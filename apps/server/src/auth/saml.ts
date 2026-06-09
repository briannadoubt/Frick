import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

/**
 * SAML 2.0 Service Provider (SP) assertion validation — the federation seam
 * that lets an app accept identities from a SAML IdP (Okta, Entra, ADFS,
 * Shibboleth, …) the same way {@link ./oidc.ts} accepts generic OIDC issuers.
 *
 * Where OIDC verifies a signed JWT against the issuer's JWKS, SAML verifies a
 * signed XML assertion against the IdP's configured X.509 certificate. The
 * security boundary here is the *assertion*, not the transport: a SAML
 * Response arrives at the SP's Assertion Consumer Service (ACS) endpoint as a
 * base64-encoded XML document, and the SP must independently prove it came
 * from the trusted IdP and is fresh.
 *
 * This module deliberately mirrors the OIDC runtime shape
 * (`create*ProviderRuntime` → `{ config, verify }` returning a normalized
 * `Verified*Identity`) so {@link ./identity-routes.ts} can reuse the exact
 * same identity-linking + session-issuance path for both. The downstream
 * route maps the verified subject/attributes onto the app's User object and
 * mints a session through the shared `onFirstSignIn` flow.
 *
 * ## What is validated (all enforced; non-negotiable)
 *   1. **XML signature** — the Response and/or Assertion carries an enveloped
 *      `<ds:Signature>` that verifies against the provider's configured
 *      certificate. UNSIGNED documents are REJECTED. A signature that does not
 *      cover the Assertion element we read claims from is REJECTED (defends
 *      against XML signature-wrapping).
 *   2. **Issuer** — the assertion's `<Issuer>` matches the configured IdP
 *      entityID.
 *   3. **Audience restriction** — `<AudienceRestriction><Audience>` contains
 *      the SP's configured entityID.
 *   4. **Conditions window** — `NotBefore` / `NotOnOrAfter` on `<Conditions>`
 *      (and `<SubjectConfirmationData>` when present) bound the current time,
 *      within a configurable clock-skew tolerance.
 *   5. **Recipient / InResponseTo** — when a `Recipient` is present on the
 *      SubjectConfirmationData it must equal the configured ACS URL. The
 *      optional `expectedInResponseTo` adds an equality check on `InResponseTo`,
 *      but this module does NOT issue or persist AuthnRequest ids: the expected
 *      value is supplied by the caller, not derived from server-side state
 *      (auth-saml-5). So `InResponseTo` here is a defense-in-depth equality
 *      check for callers that track their own request id out-of-band, NOT a
 *      server-verified SP-initiated / anti-CSRF binding. The real IdP HTTP-POST
 *      binding is treated as unsolicited / IdP-initiated SSO.
 *   6. **Replay** — the assertion `ID` must not have been consumed before.
 *      Enforced by the caller via the `SamlAssertionStore` seam; this module
 *      surfaces the assertion ID + freshness window for that check.
 *
 * The signature primitive is pluggable via {@link SamlSignatureVerifier} so
 * the crypto is a clean, testable seam — production uses the `xml-crypto`
 * default ({@link createXmlCryptoSignatureVerifier}), and tests can inject a
 * fake to exercise the surrounding assertion logic offline without minting
 * real XML-DSIG.
 *
 * Refs:
 *   https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf
 *   https://www.w3.org/TR/xmldsig-core/
 */

const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";

/**
 * Signature-algorithm allowlist (auth-saml-1). xml-crypto registers
 * `rsa-sha1` + the SHA1 digest in its default maps, so without an explicit
 * check a collision-broken SHA1 XML-DSIG signature would verify and be
 * accepted. We pin the SignatureMethod to RSA/ECDSA over SHA-256/384/512 and
 * each Reference's DigestMethod to SHA-256/384/512 — anything weaker (or
 * unrecognized) is rejected before its `signedElementIds` are trusted. SHA1 is
 * deliberately absent.
 */
const ALLOWED_SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512",
]);
const ALLOWED_DIGEST_ALGORITHMS: ReadonlySet<string> = new Set([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512",
  "http://www.w3.org/2001/04/xmldsig-more#sha384",
]);

export interface SamlAttributeMappings {
  /** Source assertion attribute (or NameID) for the User's email. Default: `email`. */
  email?: string;
  /** Source attribute for the User's display name. Default: `displayName`. */
  displayName?: string;
  /**
   * Extra attribute → User-field mappings copied verbatim into the upserted
   * User row. Keys are the destination User field name, values are the source
   * SAML attribute Name. Multi-valued attributes collapse to their first
   * value.
   */
  extra?: Record<string, string>;
}

/** One SAML SP provider an app plugs in via `identityProviders.saml: [...]`. */
export interface SamlProviderConfig {
  /**
   * App-chosen stable id for this provider, used in the routes
   * (`/auth/saml/:id/metadata`, `/auth/saml/:id/acs`) and recorded (scoped)
   * on the mapped User row. Must be unique within the `saml` array and
   * URL-safe.
   */
  id: string;
  /** The IdP's entityID — must match the assertion's `<Issuer>`. */
  idpEntityId: string;
  /** This SP's entityID — must appear in the assertion's `<Audience>`. */
  spEntityId: string;
  /**
   * The SP's Assertion Consumer Service URL. Exposed in SP metadata and, when
   * the assertion carries a SubjectConfirmationData `Recipient`, required to
   * match it.
   */
  acsUrl: string;
  /**
   * PEM- or base64-encoded X.509 certificate (or `-----BEGIN CERTIFICATE-----`
   * block) the IdP signs assertions with. The signature MUST verify against
   * this cert; the cert embedded in the document's own `<KeyInfo>` is never
   * trusted on its own.
   *
   * Accepts either a single cert or an array of certs (auth-saml-6). When an
   * array is supplied the signature is accepted if it verifies under ANY of the
   * configured certs, which permits zero-downtime IdP signing-key rotation
   * (trust old + new simultaneously across the rollover window).
   */
  idpCertificate: string | string[];
  /**
   * Optional SP signing/encryption certificate (PEM) advertised in SP
   * metadata so the IdP can encrypt to / verify the SP. Metadata-only; not
   * used for inbound assertion validation.
   */
  spCertificate?: string;
  /** Attribute → User-field overrides. */
  attributeMappings?: SamlAttributeMappings;
  /** Clock-skew tolerance in seconds for the Conditions window. Defaults to 60. */
  clockToleranceSec?: number;
}

export interface VerifiedSamlIdentity {
  /** The assertion's NameID — the stable provider subject. */
  subject: string;
  /** The assertion's `ID` attribute — used by the caller for replay defense. */
  assertionId: string;
  /**
   * The assertion's effective expiry (the earliest `NotOnOrAfter` seen on
   * Conditions / SubjectConfirmationData), ISO 8601.
   */
  notOnOrAfter: string;
  /**
   * The timestamp (ISO 8601) the replay-guard row should live until: the
   * effective expiry PLUS the clock-skew tolerance (auth-saml-4). The freshness
   * check accepts an assertion until `notOnOrAfter + clockToleranceSec`, so the
   * replay row must survive at least that long — otherwise a purged row could
   * predate a still-acceptable assertion and open a one-shot replay window. The
   * caller pins the replay-guard row to THIS value.
   */
  replayExpiresAt: string;
  /** Verified email, if mapped/present. */
  email: string | undefined;
  /** Display name resolved from the mapped attribute. */
  name: string | undefined;
  /** Extra User fields resolved from `attributeMappings.extra`. */
  extraUserFields: Record<string, unknown>;
  /** All parsed attributes (Name → first value), for callers that need more. */
  attributes: Record<string, string>;
}

export interface VerifySamlOptions {
  /**
   * Expected `InResponseTo` — the id of the AuthnRequest the SP issued for
   * this login. When set, the assertion's `InResponseTo` must match exactly
   * (SP-initiated flow). Omit for IdP-initiated flows.
   */
  expectedInResponseTo?: string;
  /**
   * Test/clock override — treat this as "now" for the Conditions window.
   * Production leaves it undefined (uses `Date.now()`).
   */
  now?: Date;
  /**
   * Override the signature verifier (test seam). Production uses the
   * provider's configured `xml-crypto` verifier.
   */
  signatureVerifierOverride?: SamlSignatureVerifier;
}

/**
 * Pluggable XML-signature verifier. Given the raw SAML XML and the IdP's
 * configured certificate, returns the set of element IDs whose signature
 * cryptographically verified (so the caller can confirm the *assertion* it
 * reads is actually covered by a valid signature, not some sibling element).
 *
 * Implementations MUST return only references that passed cryptographic
 * verification against the supplied certificate, and MUST throw / return an
 * empty set for an unsigned document or a signature that doesn't verify.
 */
export interface SamlSignatureVerifier {
  /**
   * `certificate` is one trusted IdP cert or an array of them (the signature is
   * valid if it verifies under any one). Single-string remains accepted for
   * back-compat with custom/test verifiers.
   */
  verify(input: { xml: string; certificate: string | string[] }): SamlSignatureResult;
}

export interface SamlSignatureResult {
  /** True only when at least one signature verified against the cert. */
  valid: boolean;
  /**
   * IDs of the elements covered by a verified signature (the `URI="#id"`
   * reference targets, with the leading `#` stripped). Empty when invalid. An
   * empty-URI reference (whole-document signature) is reported as the document
   * element's own id when it has one.
   */
  signedElementIds: string[];
}

export class SamlValidationError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SamlValidationError";
    this.code = code;
  }
}

interface ResolvedSamlProvider {
  id: string;
  idpEntityId: string;
  spEntityId: string;
  acsUrl: string;
  /**
   * One or more trusted IdP signing certs. A signature is valid if it verifies
   * under ANY entry (auth-saml-6: supports overlapping keys during rotation).
   */
  idpCertificates: string[];
  spCertificate: string | undefined;
  attributeMappings: Required<Omit<SamlAttributeMappings, "extra">> & {
    extra: Record<string, string>;
  };
  clockToleranceSec: number;
}

const DEFAULT_ATTR_MAPPINGS = {
  email: "email",
  displayName: "displayName",
} as const;

function resolveProvider(config: SamlProviderConfig): ResolvedSamlProvider {
  return {
    id: config.id,
    idpEntityId: config.idpEntityId,
    spEntityId: config.spEntityId,
    acsUrl: config.acsUrl,
    idpCertificates: normalizeCertList(config.idpCertificate),
    spCertificate: config.spCertificate,
    attributeMappings: {
      email: config.attributeMappings?.email ?? DEFAULT_ATTR_MAPPINGS.email,
      displayName:
        config.attributeMappings?.displayName ?? DEFAULT_ATTR_MAPPINGS.displayName,
      extra: config.attributeMappings?.extra ?? {},
    },
    clockToleranceSec: config.clockToleranceSec ?? 60,
  };
}

export interface SamlProviderRuntime {
  config: ResolvedSamlProvider;
  /**
   * Verify a base64-encoded (or raw) SAML Response/Assertion XML document and
   * return the normalized identity, or throw {@link SamlValidationError}.
   * Replay defense is the caller's responsibility via the returned
   * `assertionId` + `notOnOrAfter`.
   */
  verify(samlResponse: string, options?: VerifySamlOptions): VerifiedSamlIdentity;
  /** SP metadata XML for this provider's `/metadata` endpoint. */
  metadataXml(): string;
}

/**
 * Build a runtime for one SAML SP provider. Pure/synchronous — there's no
 * network dependency for inbound assertion validation (unlike OIDC discovery),
 * because the IdP's signing certificate is configured directly.
 */
export function createSamlProviderRuntime(
  config: SamlProviderConfig,
): SamlProviderRuntime {
  const resolved = resolveProvider(config);
  const defaultVerifier = createXmlCryptoSignatureVerifier();

  function verify(
    samlResponse: string,
    options?: VerifySamlOptions,
  ): VerifiedSamlIdentity {
    const xml = decodeSamlPayload(samlResponse);
    const verifier = options?.signatureVerifierOverride ?? defaultVerifier;

    // 1. Signature. Reject unsigned / non-verifying documents up front.
    let signature: SamlSignatureResult;
    try {
      signature = verifier.verify({ xml, certificate: resolved.idpCertificates });
    } catch (err) {
      throw new SamlValidationError(
        `SAML signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
        "SamlSignatureInvalid",
      );
    }
    if (!signature.valid || signature.signedElementIds.length === 0) {
      throw new SamlValidationError(
        "SAML document is unsigned or its signature did not verify",
        "SamlSignatureInvalid",
      );
    }

    const doc = parseXml(xml);
    const assertion = findAssertion(doc);
    if (!assertion) {
      throw new SamlValidationError(
        "SAML document has no <Assertion> element",
        "SamlNoAssertion",
      );
    }

    // 1b. Signature-wrapping defense: the Assertion we read claims from MUST
    // itself be covered by a verified signature — either directly, or via a
    // signed enclosing Response whose signature references that element. We
    // require the Assertion's own ID (or the signed Response's ID containing
    // exactly this assertion) to be in the verified reference set.
    const assertionId = attr(assertion, "ID");
    if (!assertionId) {
      throw new SamlValidationError("SAML <Assertion> has no ID", "SamlNoAssertionId");
    }
    const responseEl = doc.documentElement;
    const responseId =
      responseEl && localName(responseEl) === "Response" ? attr(responseEl, "ID") : null;
    const assertionIsSigned = signature.signedElementIds.includes(assertionId);
    const responseIsSigned =
      responseId !== null && signature.signedElementIds.includes(responseId);
    if (!assertionIsSigned && !responseIsSigned) {
      throw new SamlValidationError(
        "The SAML assertion read for claims is not covered by a verified signature",
        "SamlAssertionNotSigned",
      );
    }

    // 2. Issuer.
    const issuer = textOf(childByLocalName(assertion, "Issuer"));
    if (issuer !== resolved.idpEntityId) {
      throw new SamlValidationError(
        `SAML issuer "${issuer ?? "(none)"}" does not match configured IdP entityID`,
        "SamlIssuerMismatch",
      );
    }

    // 4 + 5. Conditions window, audience, recipient, InResponseTo.
    const now = options?.now ?? new Date();
    const skewMs = resolved.clockToleranceSec * 1000;
    const conditions = childByLocalName(assertion, "Conditions");
    let notOnOrAfter: string | undefined;

    if (conditions) {
      const nb = attr(conditions, "NotBefore");
      const noa = attr(conditions, "NotOnOrAfter");
      // auth-saml-2: a malformed timestamp must be a HARD failure, not a
      // silently-satisfied bound. `Date.parse` returns NaN for garbage and
      // every relational comparison with NaN is false, which would otherwise
      // disable the freshness window. parseInstant throws on NaN.
      if (nb && now.getTime() + skewMs < parseInstant(nb, "Conditions NotBefore")) {
        throw new SamlValidationError(
          "SAML assertion is not yet valid (Conditions NotBefore)",
          "SamlNotYetValid",
        );
      }
      if (noa) {
        notOnOrAfter = noa;
        if (now.getTime() - skewMs >= parseInstant(noa, "Conditions NotOnOrAfter")) {
          throw new SamlValidationError(
            "SAML assertion has expired (Conditions NotOnOrAfter)",
            "SamlExpired",
          );
        }
      }
      // 3. Audience restriction. Per SAML core, multiple <AudienceRestriction>
      // blocks are CONJUNCTIVE (the SP must satisfy ALL of them) while multiple
      // <Audience> within one block are DISJUNCTIVE. auth-saml-3: evaluate each
      // block on its own and require the SP entityID in EVERY block — never
      // flatten, which would let a second, narrower restriction scoped to a
      // different RP pass.
      const restrictionBlocks = collectAudienceRestrictions(conditions);
      if (restrictionBlocks.length === 0) {
        throw new SamlValidationError(
          "SAML assertion has no AudienceRestriction",
          "SamlNoAudience",
        );
      }
      for (const block of restrictionBlocks) {
        if (!block.includes(resolved.spEntityId)) {
          throw new SamlValidationError(
            "SAML assertion audience does not include this SP entityID",
            "SamlAudienceMismatch",
          );
        }
      }
    } else {
      throw new SamlValidationError(
        "SAML assertion has no <Conditions> (cannot bound audience/validity)",
        "SamlNoConditions",
      );
    }

    // Subject confirmation: Recipient + InResponseTo + NotOnOrAfter.
    const subjectEl = childByLocalName(assertion, "Subject");
    const confirmationData = subjectEl
      ? descendantByLocalName(subjectEl, "SubjectConfirmationData")
      : undefined;
    if (confirmationData) {
      const recipient = attr(confirmationData, "Recipient");
      if (recipient && recipient !== resolved.acsUrl) {
        throw new SamlValidationError(
          "SAML SubjectConfirmationData Recipient does not match the configured ACS URL",
          "SamlRecipientMismatch",
        );
      }
      const scNotOnOrAfter = attr(confirmationData, "NotOnOrAfter");
      if (scNotOnOrAfter) {
        const scExpiry = parseInstant(
          scNotOnOrAfter,
          "SubjectConfirmationData NotOnOrAfter",
        );
        if (now.getTime() - skewMs >= scExpiry) {
          throw new SamlValidationError(
            "SAML SubjectConfirmationData has expired (NotOnOrAfter)",
            "SamlExpired",
          );
        }
        // Pin replay TTL to the earliest expiry we can prove. `notOnOrAfter`,
        // when set, already parsed cleanly above.
        if (!notOnOrAfter || scExpiry < parseInstant(notOnOrAfter, "Conditions NotOnOrAfter")) {
          notOnOrAfter = scNotOnOrAfter;
        }
      }
      const inResponseTo = attr(confirmationData, "InResponseTo");
      if (options?.expectedInResponseTo !== undefined) {
        if (inResponseTo !== options.expectedInResponseTo) {
          throw new SamlValidationError(
            "SAML InResponseTo does not match the expected AuthnRequest id",
            "SamlInResponseToMismatch",
          );
        }
      }
    } else if (options?.expectedInResponseTo !== undefined) {
      // SP-initiated flow expected a confirmation to bind InResponseTo.
      throw new SamlValidationError(
        "SAML assertion has no SubjectConfirmationData to bind InResponseTo",
        "SamlInResponseToMismatch",
      );
    }

    // Subject (NameID).
    const nameId = subjectEl ? textOf(childByLocalName(subjectEl, "NameID")) : undefined;
    if (!nameId) {
      throw new SamlValidationError(
        "SAML assertion has no Subject NameID",
        "SamlNoSubject",
      );
    }

    // Attributes → User fields.
    const attributes = collectAttributes(assertion);
    const mappings = resolved.attributeMappings;
    const email = attributes[mappings.email];
    const name = attributes[mappings.displayName];
    const extraUserFields: Record<string, unknown> = {};
    for (const [destField, sourceAttr] of Object.entries(mappings.extra)) {
      const value = attributes[sourceAttr];
      if (value !== undefined) extraUserFields[destField] = value;
    }

    // If no NotOnOrAfter was present anywhere, fall back to "now + skew" so the
    // replay row still has a bounded lifetime.
    const effectiveNotOnOrAfter =
      notOnOrAfter ?? new Date(now.getTime() + skewMs).toISOString();
    // auth-saml-4: pad the replay TTL by the clock-skew tolerance so a purged
    // row can never predate an assertion that is still freshness-acceptable.
    // `effectiveNotOnOrAfter` parsed cleanly above (or was constructed here).
    const replayExpiresAt = new Date(
      Date.parse(effectiveNotOnOrAfter) + skewMs,
    ).toISOString();

    return {
      subject: nameId,
      assertionId,
      notOnOrAfter: effectiveNotOnOrAfter,
      replayExpiresAt,
      email,
      name,
      extraUserFields,
      attributes,
    };
  }

  function metadataXml(): string {
    return buildSpMetadata(resolved);
  }

  return { config: resolved, verify, metadataXml };
}

/**
 * Production signature verifier built on `xml-crypto` (the vetted XML-DSIG
 * library node-saml/passport-saml are built on). It pins verification to the
 * supplied certificate — the document's own embedded KeyInfo is never trusted
 * to choose the key — and returns the IDs of the references that verified so
 * the caller can guard against signature wrapping.
 */
export function createXmlCryptoSignatureVerifier(): SamlSignatureVerifier {
  return {
    verify({ xml, certificate }) {
      const doc = parseXml(xml);
      // Find every enveloped <ds:Signature>. A document may sign the Response,
      // the Assertion, or both; we verify each and union the references.
      const signatureNodes = Array.from(
        doc.getElementsByTagNameNS(DSIG_NS, "Signature"),
      );
      if (signatureNodes.length === 0) {
        return { valid: false, signedElementIds: [] };
      }
      // auth-saml-6: accept the signature if it verifies under ANY configured
      // cert, so old + new IdP signing keys can overlap during a rotation.
      const pems = normalizeCertList(certificate).map(normalizeCertToPem);
      if (pems.length === 0) {
        // No trusted cert configured — nothing can verify.
        return { valid: false, signedElementIds: [] };
      }
      const firstPem = pems[0] as string;
      const signedIds: string[] = [];
      let anyValid = false;
      for (const sigNode of signatureNodes) {
        // auth-saml-1: load the signature once so we can inspect the declared
        // SignatureMethod / DigestMethod, and reject anything outside the
        // allowlist BEFORE crediting its references — a rsa-sha1 / sha1-digest
        // signature must never contribute to signedElementIds even if the
        // (collision-broken) math checks out.
        const probe = new SignedXml();
        probe.publicCert = firstPem;
        probe.getCertFromKeyInfo = () => null;
        probe.loadSignature(sigNode as unknown as Node);
        const sigAlg = probe.signatureAlgorithm;
        if (sigAlg === undefined || !ALLOWED_SIGNATURE_ALGORITHMS.has(sigAlg)) {
          throw new SamlValidationError(
            `SAML signature uses a disallowed SignatureMethod algorithm: ${sigAlg ?? "(none)"}`,
            "SamlSignatureInvalid",
          );
        }
        for (const ref of probe.getReferences()) {
          const digestAlg = (ref as { digestAlgorithm?: string }).digestAlgorithm;
          if (digestAlg === undefined || !ALLOWED_DIGEST_ALGORITHMS.has(digestAlg)) {
            throw new SamlValidationError(
              `SAML signature reference uses a disallowed DigestMethod algorithm: ${digestAlg ?? "(none)"}`,
              "SamlSignatureInvalid",
            );
          }
        }

        let ok = false;
        // Verify against each trusted cert until one accepts; a fresh SignedXml
        // per attempt keeps verification state isolated.
        for (const pem of pems) {
          const sig = new SignedXml();
          // Pin the key: always verify against a configured cert, never the
          // cert embedded in the document.
          sig.publicCert = pem;
          sig.getCertFromKeyInfo = () => null;
          sig.loadSignature(sigNode as unknown as Node);
          try {
            if (sig.checkSignature(xml)) {
              ok = true;
              break;
            }
          } catch {
            // Try the next cert.
          }
        }
        if (!ok) continue;
        anyValid = true;
        for (const ref of probe.getReferences()) {
          const uri = (ref as { uri?: string }).uri ?? "";
          const id = uri.startsWith("#") ? uri.slice(1) : uri;
          if (id) signedIds.push(id);
          else {
            // Empty URI = whole-document signature; credit the doc element id.
            const rootId = doc.documentElement
              ? attr(doc.documentElement, "ID")
              : null;
            if (rootId) signedIds.push(rootId);
          }
        }
      }
      return { valid: anyValid, signedElementIds: signedIds };
    },
  };
}

// ---------------------------------------------------------------------------
// XML helpers (kept deliberately small; @xmldom/xmldom is the only parser).
// ---------------------------------------------------------------------------

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  if (!doc || !doc.documentElement) {
    throw new SamlValidationError("SAML payload is not well-formed XML", "SamlMalformedXml");
  }
  return doc;
}

function decodeSamlPayload(input: string): string {
  const trimmed = input.trim();
  // Already XML?
  if (trimmed.startsWith("<")) return trimmed;
  // Otherwise assume base64 (the wire form posted to ACS as SAMLResponse).
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.trim().startsWith("<")) return decoded;
  } catch {
    // fall through
  }
  throw new SamlValidationError(
    "SAMLResponse is neither XML nor base64-encoded XML",
    "SamlMalformedXml",
  );
}

function localName(el: Element): string {
  return el.localName ?? el.nodeName.replace(/^.*:/, "");
}

function attr(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  return v && v.length > 0 ? v : null;
}

function findAssertion(doc: Document): Element | undefined {
  const root = doc.documentElement;
  if (!root) return undefined;
  if (localName(root) === "Assertion") return root;
  const list = doc.getElementsByTagNameNS(SAML_ASSERTION_NS, "Assertion");
  return list.length > 0 ? (list[0] as Element) : undefined;
}

function childByLocalName(el: Element, name: string): Element | undefined {
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node && node.nodeType === 1 && localName(node as Element) === name) {
      return node as Element;
    }
  }
  return undefined;
}

function descendantByLocalName(el: Element, name: string): Element | undefined {
  // SubjectConfirmationData lives under Subject > SubjectConfirmation.
  const list = el.getElementsByTagNameNS(SAML_ASSERTION_NS, name);
  if (list.length > 0) return list[0] as Element;
  // Fallback for unqualified docs.
  const all = el.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const node = all[i] as Element;
    if (localName(node) === name) return node;
  }
  return undefined;
}

function textOf(el: Element | undefined): string | undefined {
  if (!el) return undefined;
  const text = (el.textContent ?? "").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Parse a SAML timestamp into epoch milliseconds, throwing
 * {@link SamlValidationError} when it is unparseable (auth-saml-2). A bare
 * `Date.parse` returns NaN for garbage, and `NaN >= x` / `NaN < x` are both
 * false — so a malformed NotBefore/NotOnOrAfter would silently disable the
 * freshness window. We treat an unparseable bound as a hard rejection instead.
 */
function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new SamlValidationError(
      `SAML ${label} is not a parseable timestamp: "${value}"`,
      "SamlMalformedTimestamp",
    );
  }
  return parsed;
}

/**
 * Collect the <Audience> values per <AudienceRestriction> block (auth-saml-3).
 * Returns one inner array per restriction block (OR within the block); the
 * caller ANDs across blocks. Blocks with no parseable <Audience> are dropped so
 * an empty restriction can't vacuously satisfy the AND.
 */
function collectAudienceRestrictions(conditions: Element): string[][] {
  const blocks: string[][] = [];
  const restrictionEls = elementsByLocalName(conditions, "AudienceRestriction");
  for (const restriction of restrictionEls) {
    const audiences: string[] = [];
    for (const audienceEl of elementsByLocalName(restriction, "Audience")) {
      const t = textOf(audienceEl);
      if (t) audiences.push(t);
    }
    if (audiences.length > 0) blocks.push(audiences);
  }
  return blocks;
}

/**
 * All descendant elements of `el` with the given local name, namespace-agnostic
 * (handles both the SAML-assertion namespace and unqualified test fixtures).
 */
function elementsByLocalName(el: Element, name: string): Element[] {
  const out: Element[] = [];
  const nsList = el.getElementsByTagNameNS(SAML_ASSERTION_NS, name);
  if (nsList.length > 0) {
    for (let i = 0; i < nsList.length; i++) out.push(nsList[i] as Element);
    return out;
  }
  const all = el.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const node = all[i] as Element;
    if (localName(node) === name) out.push(node);
  }
  return out;
}

function collectAttributes(assertion: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const statements = assertion.getElementsByTagNameNS(
    SAML_ASSERTION_NS,
    "Attribute",
  );
  const nodes =
    statements.length > 0
      ? Array.from(statements)
      : Array.from(assertion.getElementsByTagName("*")).filter(
          (n) => localName(n as Element) === "Attribute",
        );
  for (const node of nodes) {
    const el = node as Element;
    const name = attr(el, "Name");
    if (!name) continue;
    // First AttributeValue child wins (multi-valued collapses to first).
    let value: string | undefined;
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child && child.nodeType === 1 && localName(child as Element) === "AttributeValue") {
        value = textOf(child as Element);
        break;
      }
    }
    if (value !== undefined && out[name] === undefined) out[name] = value;
  }
  return out;
}

/**
 * Coerce a single-cert-or-array `idpCertificate` into a non-empty array of
 * trimmed cert strings (auth-saml-6). Empty/blank entries are dropped.
 */
function normalizeCertList(certificate: string | string[]): string[] {
  const list = (Array.isArray(certificate) ? certificate : [certificate])
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter((c) => c.length > 0);
  return list;
}

function normalizeCertToPem(certificate: string): string {
  const trimmed = certificate.trim();
  // Already a PEM block of some kind (CERTIFICATE or a bare PUBLIC KEY) — pass
  // through unchanged; xml-crypto's `publicCert` accepts both.
  if (trimmed.includes("-----BEGIN")) return trimmed;
  // Bare base64 DER (the form in IdP metadata <X509Certificate>): wrap it as a
  // certificate block.
  const body = trimmed.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? trimmed;
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function buildSpMetadata(p: ResolvedSamlProvider): string {
  const keyDescriptor = p.spCertificate
    ? `
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="${DSIG_NS}">
        <ds:X509Data>
          <ds:X509Certificate>${stripPem(p.spCertificate)}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:KeyDescriptor use="encryption">
      <ds:KeyInfo xmlns:ds="${DSIG_NS}">
        <ds:X509Data>
          <ds:X509Certificate>${stripPem(p.spCertificate)}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(p.spEntityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="${SAML_PROTOCOL_NS}">${keyDescriptor}
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(p.acsUrl)}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

function stripPem(cert: string): string {
  return cert
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
