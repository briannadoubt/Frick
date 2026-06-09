import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { SignedXml } from "xml-crypto";
import {
  createSamlProviderRuntime,
  SamlValidationError,
  type SamlProviderConfig,
} from "../src/auth/saml.js";

/**
 * Unit regression tests for the SAML audit fixes, exercising the runtime's
 * `verify()` directly with the production xml-crypto verifier:
 *   - auth-saml-1: signature-algorithm allowlist (reject rsa-sha1 / sha1-digest)
 *   - auth-saml-2: malformed NotBefore/NotOnOrAfter must hard-fail (NaN guard)
 *   - auth-saml-3: AudienceRestriction AND semantics across multiple blocks
 *   - auth-saml-4: replay TTL is padded by the clock-skew tolerance
 *   - auth-saml-6: idpCertificate accepts an array (rotation: old + new key)
 */

const IDP_ENTITY_ID = "https://idp.example.test/metadata";
const SP_ENTITY_ID = "https://sp.frick.test";
const ACS_URL = "https://sp.frick.test/auth/saml/test/acs";

let idpPrivateKeyPem: string;
let idpPublicKeyPem: string;
let oldPrivateKeyPem: string;
let oldPublicKeyPem: string;

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

interface BuildOpts {
  id?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  /** Raw <Conditions> children override (for multi-AudienceRestriction tests). */
  conditionsInner?: string;
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  signWithPrivateKey?: string;
}

function buildSignedAssertion(opts: BuildOpts = {}): string {
  const id = opts.id ?? `_a-${Math.random().toString(36).slice(2)}`;
  const notBefore = opts.notBefore ?? isoIn(-60);
  const notOnOrAfter = opts.notOnOrAfter ?? isoIn(300);
  const conditionsInner =
    opts.conditionsInner ??
    `<saml:AudienceRestriction><saml:Audience>${SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction>`;

  const xml =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${isoIn(-1)}">` +
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID>saml-user</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData Recipient="${ACS_URL}" NotOnOrAfter="${notOnOrAfter}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    conditionsInner +
    `</saml:Conditions>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>u@example.test</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>`;

  const sig = new SignedXml({ privateKey: opts.signWithPrivateKey ?? idpPrivateKeyPem });
  sig.signatureAlgorithm =
    opts.signatureAlgorithm ?? "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: opts.digestAlgorithm ?? "http://www.w3.org/2001/04/xmlenc#sha256",
    uri: `#${id}`,
  });
  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='Assertion']", action: "append" },
  });
  return sig.getSignedXml();
}

function runtime(certificate: string | string[]) {
  const config: SamlProviderConfig = {
    id: "test",
    idpEntityId: IDP_ENTITY_ID,
    spEntityId: SP_ENTITY_ID,
    acsUrl: ACS_URL,
    idpCertificate: certificate,
    clockToleranceSec: 60,
  };
  return createSamlProviderRuntime(config);
}

beforeAll(() => {
  const idp = generateKeyPairSync("rsa", { modulusLength: 2048 });
  idpPrivateKeyPem = idp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  idpPublicKeyPem = idp.publicKey.export({ type: "spki", format: "pem" }) as string;
  const old = generateKeyPairSync("rsa", { modulusLength: 2048 });
  oldPrivateKeyPem = old.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  oldPublicKeyPem = old.publicKey.export({ type: "spki", format: "pem" }) as string;
});

describe("auth-saml-1: signature-algorithm allowlist", () => {
  it("accepts a correctly-signed rsa-sha256/sha256 assertion (control)", () => {
    const rt = runtime(idpPublicKeyPem);
    const verified = rt.verify(buildSignedAssertion());
    expect(verified.subject).toBe("saml-user");
  });

  it("REJECTS an assertion whose SignatureMethod is rsa-sha1", () => {
    const rt = runtime(idpPublicKeyPem);
    const xml = buildSignedAssertion({
      signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    });
    let err: unknown;
    try {
      rt.verify(xml);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SamlValidationError);
    expect((err as SamlValidationError).code).toBe("SamlSignatureInvalid");
  });

  it("REJECTS an assertion whose DigestMethod is sha1", () => {
    const rt = runtime(idpPublicKeyPem);
    const xml = buildSignedAssertion({
      digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    });
    expect(() => rt.verify(xml)).toThrow(SamlValidationError);
  });
});

describe("auth-saml-2: malformed timestamps hard-fail (NaN guard)", () => {
  it("REJECTS a non-parseable NotOnOrAfter instead of treating it as never-expiring", () => {
    const rt = runtime(idpPublicKeyPem);
    const xml = buildSignedAssertion({ notOnOrAfter: "not-a-date" });
    let err: unknown;
    try {
      rt.verify(xml);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SamlValidationError);
    expect((err as SamlValidationError).code).toBe("SamlMalformedTimestamp");
  });

  it("REJECTS a non-parseable NotBefore", () => {
    const rt = runtime(idpPublicKeyPem);
    const xml = buildSignedAssertion({ notBefore: "garbage" });
    expect(() => rt.verify(xml)).toThrow(
      expect.objectContaining({ code: "SamlMalformedTimestamp" }),
    );
  });
});

describe("auth-saml-3: AudienceRestriction AND semantics", () => {
  it("REJECTS when a second restriction block omits this SP (conjunctive)", () => {
    const rt = runtime(idpPublicKeyPem);
    const xml = buildSignedAssertion({
      conditionsInner:
        `<saml:AudienceRestriction><saml:Audience>${SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction>` +
        `<saml:AudienceRestriction><saml:Audience>https://other-rp.test</saml:Audience></saml:AudienceRestriction>`,
    });
    let err: unknown;
    try {
      rt.verify(xml);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SamlValidationError);
    expect((err as SamlValidationError).code).toBe("SamlAudienceMismatch");
  });

  it("ACCEPTS when every restriction block includes this SP", () => {
    const rt = runtime(idpPublicKeyPem);
    const xml = buildSignedAssertion({
      conditionsInner:
        `<saml:AudienceRestriction><saml:Audience>${SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction>` +
        `<saml:AudienceRestriction>` +
        `<saml:Audience>https://other-rp.test</saml:Audience>` +
        `<saml:Audience>${SP_ENTITY_ID}</saml:Audience>` +
        `</saml:AudienceRestriction>`,
    });
    expect(rt.verify(xml).subject).toBe("saml-user");
  });
});

describe("auth-saml-4: replay TTL padded by clock skew", () => {
  it("replayExpiresAt = notOnOrAfter + clockToleranceSec", () => {
    const rt = runtime(idpPublicKeyPem);
    const notOnOrAfter = isoIn(300);
    const verified = rt.verify(buildSignedAssertion({ notOnOrAfter }));
    expect(verified.notOnOrAfter).toBe(notOnOrAfter);
    const pad = Date.parse(verified.replayExpiresAt) - Date.parse(verified.notOnOrAfter);
    // 60s tolerance from the config above.
    expect(pad).toBe(60_000);
  });
});

describe("auth-saml-6: idpCertificate array supports key rotation", () => {
  it("accepts a signature under EITHER configured cert (old + new overlap)", () => {
    const rt = runtime([oldPublicKeyPem, idpPublicKeyPem]);
    // Signed with the NEW key.
    expect(rt.verify(buildSignedAssertion()).subject).toBe("saml-user");
    // Signed with the OLD key (still trusted during rollover).
    expect(
      rt.verify(buildSignedAssertion({ signWithPrivateKey: oldPrivateKeyPem })).subject,
    ).toBe("saml-user");
  });

  it("still rejects a signature under a cert that is NOT configured", () => {
    const rt = runtime([idpPublicKeyPem]);
    expect(() =>
      rt.verify(buildSignedAssertion({ signWithPrivateKey: oldPrivateKeyPem })),
    ).toThrow(SamlValidationError);
  });
});
