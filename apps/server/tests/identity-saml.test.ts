import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { SignedXml } from "xml-crypto";
import type { FrickSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

/**
 * Integration test for Frick's identityProviders.saml surface:
 *
 *   GET  /auth/saml/:providerId/metadata
 *   POST /auth/saml/:providerId/acs
 *
 * Frick verifies a SAML Response/Assertion's XML signature against the
 * provider's configured certificate, checks issuer / audience / validity
 * window / recipient / InResponseTo, guards against assertion replay, maps
 * SAML attributes onto the app-owned User object, runs onFirstSignIn, and
 * mints a session exactly like the OIDC path.
 *
 * The happy path uses a REAL RSA keypair + `xml-crypto` to sign a synthetic
 * assertion (so the production crypto path is genuinely exercised). The
 * negative cases that probe assertion *logic* (expiry, audience, replay,
 * unsigned, wrong cert) are driven through that same real verifier so the
 * whole boundary is tested end-to-end.
 */

const PROVIDER_ID = "okta-saml";
const IDP_ENTITY_ID = "https://idp.example.test/metadata";
const SP_ENTITY_ID = "https://sp.frick.test";
const ACS_URL = "https://sp.frick.test/auth/saml/okta-saml/acs";

const testSchema: FrickSchema = {
  name: "identity-saml-test",
  schemaId: "identity-saml-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "identity-saml-test-0.1.0",
  objects: [
    {
      id: 1,
      name: "User",
      fields: [
        { id: 1, name: "displayName", kind: "string", required: true },
        { id: 2, name: "email", kind: "string", required: false },
        { id: 3, name: "appleSubject", kind: "string", required: false },
        { id: 4, name: "googleSubject", kind: "string", required: false },
        { id: 5, name: "samlSubject", kind: "string", required: false },
        { id: 6, name: "createdAt", kind: "timestamp", required: true },
        { id: 7, name: "revokedAt", kind: "timestamp", required: false },
        { id: 8, name: "primaryTenantId", kind: "string", required: false },
        { id: 9, name: "department", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "bySamlSubject", fields: ["samlSubject"] }],
    },
  ],
  streams: [],
  events: [],
  presences: [],
  signals: [],
  blobs: [],
  jobs: [],
  projections: [],
};

let app: ReturnType<typeof createFrickServer>;
let idpPrivateKeyPem: string;
let idpPublicKeyPem: string;
let wrongPublicKeyPem: string;

interface AssertionOpts {
  id?: string;
  nameId?: string;
  issuer?: string;
  audience?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  recipient?: string;
  inResponseTo?: string;
  email?: string;
  displayName?: string;
  department?: string;
  /** When true, return the assertion XML WITHOUT a signature. */
  unsigned?: boolean;
  /** Sign with this key instead of the IdP key (wrong-cert case). */
  signWithPrivateKey?: string;
}

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Build a SAML assertion XML, optionally enveloped-signed by the IdP key. */
function buildAssertion(opts: AssertionOpts = {}): string {
  const id = opts.id ?? `_assertion-${Math.random().toString(36).slice(2)}`;
  const nameId = opts.nameId ?? "saml-user-1";
  const issuer = opts.issuer ?? IDP_ENTITY_ID;
  const audience = opts.audience ?? SP_ENTITY_ID;
  const notBefore = opts.notBefore ?? isoIn(-60);
  const notOnOrAfter = opts.notOnOrAfter ?? isoIn(300);
  const recipient = opts.recipient ?? ACS_URL;
  const email = opts.email ?? "saml.user@example.test";
  const displayName = opts.displayName ?? "Saml User";
  const inResponseToAttr =
    opts.inResponseTo !== undefined ? ` InResponseTo="${opts.inResponseTo}"` : "";
  const deptAttr = opts.department
    ? `<saml:Attribute Name="dept"><saml:AttributeValue>${opts.department}</saml:AttributeValue></saml:Attribute>`
    : "";

  const xml = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${isoIn(-1)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID>${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData${inResponseToAttr} Recipient="${recipient}" NotOnOrAfter="${notOnOrAfter}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="displayName"><saml:AttributeValue>${displayName}</saml:AttributeValue></saml:Attribute>` +
    deptAttr +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>`;

  if (opts.unsigned) return xml;

  const sig = new SignedXml({ privateKey: opts.signWithPrivateKey ?? idpPrivateKeyPem });
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    uri: `#${id}`,
  });
  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='Assertion']", action: "append" },
  });
  return sig.getSignedXml();
}

function b64(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

async function postAcs(
  providerId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${app.httpUrl}/auth/saml/${providerId}/acs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const idp = generateKeyPairSync("rsa", { modulusLength: 2048 });
  idpPrivateKeyPem = idp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  idpPublicKeyPem = idp.publicKey.export({ type: "spki", format: "pem" }) as string;
  const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 });
  wrongPublicKeyPem = wrong.publicKey.export({ type: "spki", format: "pem" }) as string;

  app = createFrickServer({
    schema: testSchema,
    port: 0,
    dbPath: ":memory:",
    config: { env: "test" },
    jobs: { workerEnabled: false },
    identityProviders: {
      saml: [
        {
          id: PROVIDER_ID,
          idpEntityId: IDP_ENTITY_ID,
          spEntityId: SP_ENTITY_ID,
          acsUrl: ACS_URL,
          idpCertificate: idpPublicKeyPem,
          attributeMappings: { extra: { department: "dept" } },
        },
      ],
      onFirstSignIn: async ({ subject, providerId }) => ({
        tenantId: `tenant-${providerId}-${subject}`,
      }),
    },
  });
  await app.listen();
});

afterAll(async () => {
  await app.close();
});

describe("Frick identityProviders.saml — happy path (real xml-crypto signature)", () => {
  it("accepts a correctly-signed assertion, maps attributes, mints a session", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(buildAssertion({ nameId: "saml-user-happy" })),
    });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.session.tenantId).toBe(`tenant-${PROVIDER_ID}-saml-user-happy`);
    expect(res.body.user.samlSubject).toBe(`${PROVIDER_ID}:saml-user-happy`);
    expect(res.body.user.email).toBe("saml.user@example.test");
    expect(res.body.user.displayName).toBe("Saml User");
  });

  it("maps an extra attribute onto the configured User field", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(buildAssertion({ nameId: "saml-dept", department: "Platform" })),
    });
    expect(res.status).toBe(200);
    expect(res.body.user.department).toBe("Platform");
  });

  it("returning sign-in reuses the same User + tenant", async () => {
    const first = await postAcs(PROVIDER_ID, {
      samlResponse: b64(buildAssertion({ nameId: "saml-returning" })),
    });
    const second = await postAcs(PROVIDER_ID, {
      samlResponse: b64(buildAssertion({ nameId: "saml-returning" })),
    });
    expect(first.body.user.id).toBe(second.body.user.id);
    expect(second.body.isNewUser).toBe(false);
  });

  it("accepts a raw (non-base64) XML SAMLResponse too", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: buildAssertion({ nameId: "saml-rawxml" }),
    });
    expect(res.status).toBe(200);
  });

  it("honors InResponseTo when expected (SP-initiated flow)", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(buildAssertion({ nameId: "saml-irt", inResponseTo: "req-123" })),
      expectedInResponseTo: "req-123",
    });
    expect(res.status).toBe(200);
  });
});

describe("Frick identityProviders.saml — rejections (auth boundary)", () => {
  it("REJECTS an unsigned assertion", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(buildAssertion({ nameId: "saml-unsigned", unsigned: true })),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SamlSignatureInvalid");
  });

  it("REJECTS an assertion signed by the wrong key (wrong cert)", async () => {
    // Configured cert is the IdP public key; sign with a different private key.
    const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongPriv = wrong.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(
        buildAssertion({ nameId: "saml-wrongcert", signWithPrivateKey: wrongPriv }),
      ),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SamlSignatureInvalid");
  });

  it("REJECTS an expired assertion (Conditions NotOnOrAfter in the past)", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(
        buildAssertion({
          nameId: "saml-expired",
          notBefore: isoIn(-600),
          notOnOrAfter: isoIn(-300),
        }),
      ),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SamlExpired");
  });

  it("REJECTS a wrong-audience assertion", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(
        buildAssertion({ nameId: "saml-wrongaud", audience: "https://someone-else.test" }),
      ),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SamlAudienceMismatch");
  });

  it("REJECTS a wrong-issuer assertion", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(
        buildAssertion({ nameId: "saml-wrongiss", issuer: "https://evil-idp.test" }),
      ),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SamlIssuerMismatch");
  });

  it("REJECTS a Recipient that does not match the configured ACS URL", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(
        buildAssertion({ nameId: "saml-recip", recipient: "https://evil.test/acs" }),
      ),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SamlRecipientMismatch");
  });

  it("REJECTS a mismatched InResponseTo", async () => {
    const res = await postAcs(PROVIDER_ID, {
      samlResponse: b64(buildAssertion({ nameId: "saml-irt2", inResponseTo: "req-A" })),
      expectedInResponseTo: "req-B",
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SamlInResponseToMismatch");
  });

  it("REJECTS a replayed assertion (same assertion ID consumed twice)", async () => {
    const xml = b64(buildAssertion({ id: "_replay-fixed-id", nameId: "saml-replay" }));
    const first = await postAcs(PROVIDER_ID, { samlResponse: xml });
    expect(first.status).toBe(200);
    const second = await postAcs(PROVIDER_ID, { samlResponse: xml });
    expect(second.status).toBe(401);
    expect(second.body.code).toBe("SamlAssertionReplay");
  });

  it("REJECTS when the signature covers a different element than the assertion (wrapping)", async () => {
    // A second provider whose verifier override reports a signature that
    // verified, but over an element id that is NOT the assertion's — the
    // signature-wrapping guard must reject it.
    const wrapApp = createFrickServer({
      schema: testSchema,
      port: 0,
      dbPath: ":memory:",
      config: { env: "test" },
      jobs: { workerEnabled: false },
      identityProviders: {
        saml: [
          {
            id: "wrap",
            idpEntityId: IDP_ENTITY_ID,
            spEntityId: SP_ENTITY_ID,
            acsUrl: ACS_URL,
            idpCertificate: idpPublicKeyPem,
          },
        ],
        onFirstSignIn: async () => ({ tenantId: "t" }),
        samlVerifyOverrides: {
          // Report a valid signature, but over a bogus element id.
          wrap: {
            verify: () => ({ valid: true, signedElementIds: ["_some-other-element"] }),
          },
        },
      },
    });
    await wrapApp.listen();
    try {
      const res = await fetch(`${wrapApp.httpUrl}/auth/saml/wrap/acs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          samlResponse: b64(buildAssertion({ id: "_real-assertion", nameId: "x" })),
        }),
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe("SamlAssertionNotSigned");
    } finally {
      await wrapApp.close();
    }
  });

  it("404s for an unconfigured provider id", async () => {
    const res = await postAcs("nope", {
      samlResponse: b64(buildAssertion({ nameId: "x" })),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("saml_provider_not_configured");
  });
});

describe("Frick identityProviders.saml — SP metadata endpoint", () => {
  it("serves SP metadata XML with entityID and ACS URL", async () => {
    const res = await fetch(`${app.httpUrl}/auth/saml/${PROVIDER_ID}/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("samlmetadata+xml");
    const xml = await res.text();
    expect(xml).toContain(`entityID="${SP_ENTITY_ID}"`);
    expect(xml).toContain(ACS_URL);
    expect(xml).toContain("AssertionConsumerService");
  });

  it("404s metadata for an unconfigured provider", async () => {
    const res = await fetch(`${app.httpUrl}/auth/saml/nope/metadata`);
    expect(res.status).toBe(404);
  });
});
