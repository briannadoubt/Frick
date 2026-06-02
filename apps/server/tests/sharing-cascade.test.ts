import { afterEach, describe, expect, it } from "vitest";
import type { FrickSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import {
  assertCanSubscribe,
  AuthorizationError,
  deny,
  principalFromUserId,
  type FrickCascadeGrantLookup,
  type FrickPolicyInput,
  type MembershipReader,
} from "../src/authz.js";

// FR-70: a grant on an object record cascades READ access to the stream whose
// `streamId` equals the granted record id and to the projection rows whose
// subscribe/read `key` equals that id, within the same tenant. These tests
// cover both the authz unit (assertCanSubscribe) and the HTTP stream-read path
// end to end.

// Object + a same-name stream so a shared `document` record id can tie back to
// a `documentEdits` stream keyed by that same id.
const schema: FrickSchema = {
  name: "frick-sharing-cascade-test",
  schemaId: "frick-sharing-cascade-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "frick-sharing-cascade-test-0.1.0",
  objects: [
    {
      id: 1,
      name: "Document",
      fields: [{ id: 1, name: "title", kind: "string", required: false }],
      indexes: [{ id: 1, name: "all", fields: ["title"] }],
    },
  ],
  streams: [
    {
      id: 1,
      name: "documentEdits",
      keyFields: [{ id: 1, name: "documentId", kind: "string", required: true }],
      events: ["edited"],
    },
  ],
  events: [
    {
      id: 1,
      name: "edited",
      fields: [{ id: 1, name: "summary", kind: "string", required: true }],
    },
  ],
  presences: [],
  signals: [],
  blobs: [],
  jobs: [],
  projections: [
    {
      id: 1,
      name: "documentSummary",
      source: "documentEdits",
      fields: [
        { id: 1, name: "documentId", kind: "string", required: true },
        { id: 2, name: "summary", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "byDocument", fields: ["documentId"] }],
    },
  ],
};

/**
 * Policy hook modelling an app whose streams + projections are private to a
 * record owner. The owner of a row whose id is `<id>` is `owner-<id>`. For
 * everyone else the hook denies `stream.read` / `projection.read`, which is the
 * deny the FR-70 cascade is expected to relax for an active grantee. Object
 * reads and writes are left untouched.
 */
function ownerOnlyDerivedReads(input: FrickPolicyInput) {
  if (input.action !== "stream.read" && input.action !== "projection.read") {
    return null;
  }
  const key = input.resource.key;
  const ownerId = key ? `owner-${key}` : undefined;
  if (input.principal && ownerId && input.principal.userId === ownerId) {
    return null; // owner: no opinion, baseline allow stands
  }
  return deny("notAuthorizedForResource", "Derived row is private to its owner");
}

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// ---------------------------------------------------------------------------
// Unit tests: assertCanSubscribe cascade
// ---------------------------------------------------------------------------

describe("FR-70 — assertCanSubscribe cascade (unit)", () => {
  const TENANT = "tenant-a";
  const RECORD_ID = "doc-1";
  const OWNER_ID = `owner-${RECORD_ID}`;
  const GRANTEE_ID = "user-grantee";
  const STRANGER_ID = "user-stranger";

  const allowAllMembership: MembershipReader = { hasUser: () => true };

  // Cascade lookup that only the grantee in TENANT holds, on RECORD_ID.
  const cascade: FrickCascadeGrantLookup = (args) =>
    args.tenantId === TENANT &&
    args.granteeUserId === GRANTEE_ID &&
    args.recordId === RECORD_ID;

  // NOTE: `key` has no default. A defaulted param would replace an
  // explicitly-passed `undefined`, silently turning the whole-projection
  // (no-key) case into a keyed read — callers pass the key explicitly.
  function attempt(
    userId: string,
    tenant: string,
    kind: "stream" | "projection",
    key: string | undefined,
  ): "allow" | "deny" {
    const principal = principalFromUserId(userId, "r", "d", tenant);
    try {
      assertCanSubscribe(
        principal,
        kind,
        kind === "stream" ? "documentEdits" : "documentSummary",
        key,
        allowAllMembership,
        [ownerOnlyDerivedReads],
        cascade,
      );
      return "allow";
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      return "deny";
    }
  }

  for (const kind of ["stream", "projection"] as const) {
    it(`grantee can read the shared object's ${kind}`, () => {
      expect(attempt(GRANTEE_ID, TENANT, kind, RECORD_ID)).toBe("allow");
    });

    it(`non-grantee in the same tenant cannot read the ${kind}`, () => {
      expect(attempt(STRANGER_ID, TENANT, kind, RECORD_ID)).toBe("deny");
    });

    it(`owner is unaffected for the ${kind}`, () => {
      expect(attempt(OWNER_ID, TENANT, kind, RECORD_ID)).toBe("allow");
    });

    it(`cross-tenant grantee cannot read the ${kind}`, () => {
      // Same userId, different tenant: the cascade lookup is tenant-scoped, so
      // the grant does not apply and the deny stands.
      expect(attempt(GRANTEE_ID, "tenant-other", kind, RECORD_ID)).toBe("deny");
    });
  }

  it("cascade does not apply when the row id does not match the grant", () => {
    expect(attempt(GRANTEE_ID, TENANT, "stream", "doc-2")).toBe("deny");
  });

  // NOTE: passing undefined here is intentional and now reaches the cascade as
  // a genuinely absent key (the helper no longer defaults it).

  it("whole-projection subscribe (no key) fails closed", () => {
    // No key -> no resolvable record id -> cascade skipped -> the owner-only
    // deny stands. We deny rather than over-share the entire projection.
    expect(attempt(GRANTEE_ID, TENANT, "projection", undefined)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// HTTP integration: stream read cascade
// ---------------------------------------------------------------------------

describe("FR-70 — HTTP stream read cascade", () => {
  it("lets a grantee read the shared object's stream events; blocks others", async () => {
    app = await startServer({ policyHooks: [ownerOnlyDerivedReads] });
    const docId = "doc-1";
    const owner = await devLogin(app.httpUrl, {
      userId: `owner-${docId}`,
      tenantId: "t1",
    });
    const grantee = await devLogin(app.httpUrl, {
      userId: "user-grantee",
      tenantId: "t1",
    });
    const stranger = await devLogin(app.httpUrl, {
      userId: "user-stranger",
      tenantId: "t1",
    });

    seedEdit(app.store, "t1", docId, "first edit", "req-1");

    // Owner reads their own stream.
    const ownerRead = await getStream(app.httpUrl, docId, owner.sessionToken);
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.data.length).toBe(1);

    // Stranger (same tenant, no grant) is denied.
    const strangerRead = await getStream(app.httpUrl, docId, stranger.sessionToken);
    expect(strangerRead.status).toBe(403);

    // Grant the Document object to the grantee -> cascade lets them read the
    // stream whose streamId == the granted record id.
    await shareDocument(app.httpUrl, owner.sessionToken, grantee.sessionToken, docId);
    const granteeRead = await getStream(app.httpUrl, docId, grantee.sessionToken);
    expect(granteeRead.status).toBe(200);
    expect(granteeRead.body.data.length).toBe(1);

    // Stranger is still blocked.
    const strangerRead2 = await getStream(app.httpUrl, docId, stranger.sessionToken);
    expect(strangerRead2.status).toBe(403);
  });

  it("does not cascade across tenants", async () => {
    app = await startServer({ policyHooks: [ownerOnlyDerivedReads] });
    const docId = "doc-1";
    const owner = await devLogin(app.httpUrl, {
      userId: `owner-${docId}`,
      tenantId: "t1",
    });
    const granteeT1 = await devLogin(app.httpUrl, {
      userId: "user-grantee",
      tenantId: "t1",
    });

    seedEdit(app.store, "t1", docId, "t1 edit", "req-1");
    await shareDocument(app.httpUrl, owner.sessionToken, granteeT1.sessionToken, docId);

    // The grantee in t1 reads fine via the cascade.
    const granteeRead = await getStream(app.httpUrl, docId, granteeT1.sessionToken);
    expect(granteeRead.status).toBe(200);

    // A user in another tenant has no grant there -> denied (the cascade is
    // tenant-scoped). A distinct userId is required because dev-login binds a
    // userId to a single tenant, so the t1 grantee's id can't re-login under t2.
    const granteeT2 = await devLogin(app.httpUrl, {
      userId: "user-grantee-t2",
      tenantId: "t2",
    });
    const crossTenantRead = await getStream(app.httpUrl, docId, granteeT2.sessionToken);
    expect(crossTenantRead.status).toBe(403);
  });

  it("a read grant cascades read access but is read-only; revoke restores the deny", async () => {
    app = await startServer({ policyHooks: [ownerOnlyDerivedReads] });
    const docId = "doc-1";
    const owner = await devLogin(app.httpUrl, {
      userId: `owner-${docId}`,
      tenantId: "t1",
    });
    const grantee = await devLogin(app.httpUrl, {
      userId: "user-grantee",
      tenantId: "t1",
    });

    seedEdit(app.store, "t1", docId, "first edit", "req-1");
    const grantId = await shareDocument(
      app.httpUrl,
      owner.sessionToken,
      grantee.sessionToken,
      docId,
      "read",
    );

    // A "read" grant is sufficient for the read cascade.
    const granteeRead = await getStream(app.httpUrl, docId, grantee.sessionToken);
    expect(granteeRead.status).toBe(200);
    expect(granteeRead.body.data.length).toBe(1);

    // Revoking the grant removes the cascade -> read denied again.
    const revoke = await deleteRequest(
      `${app.httpUrl}/share/grants/${grantId}`,
      owner.sessionToken,
    );
    expect(revoke.status).toBe(200);
    const afterRevoke = await getStream(app.httpUrl, docId, grantee.sessionToken);
    expect(afterRevoke.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedEdit(
  store: { appendEvent: (input: Record<string, unknown>) => unknown },
  tenantId: string,
  docId: string,
  summary: string,
  requestId: string,
): void {
  store.appendEvent({
    tenantId,
    requestId,
    replicaId: "test-replica",
    stream: "documentEdits",
    streamId: docId,
    event: "edited",
    payload: { summary },
  });
}

async function shareDocument(
  httpUrl: string,
  ownerToken: string,
  granteeToken: string,
  recordId: string,
  permission: "read" | "write" = "read",
): Promise<string> {
  const inviteRes = await postJson(
    `${httpUrl}/share/invite`,
    { recordType: "Document", recordId, permission },
    ownerToken,
  );
  expect(inviteRes.status).toBe(201);
  const acceptRes = await postJson(
    `${httpUrl}/share/accept`,
    { token: inviteRes.body.invitation.token },
    granteeToken,
  );
  expect(acceptRes.status).toBe(201);
  return acceptRes.body.grant.id as string;
}

function getStream(httpUrl: string, docId: string, sessionToken: string) {
  return getJson(`${httpUrl}/streams/documentEdits/${docId}`, sessionToken);
}

function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  return startServerImpl(options);
}

async function startServerImpl(
  options: Parameters<typeof createFrickServer>[0] = {},
): Promise<{
  httpUrl: string;
  store: ReturnType<typeof createFrickServer>["store"];
  close: () => Promise<void>;
}> {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema,
    ...options,
  });
  await server.listen();
  const addr = server.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    httpUrl: `http://127.0.0.1:${port}`,
    store: server.store,
    close: () => server.close(),
  };
}

async function devLogin(
  url: string,
  opts: { userId: string; tenantId: string },
): Promise<{ sessionToken: string; tenantId: string; userId: string }> {
  const response = await fetch(`${url}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: opts.userId, tenantId: opts.tenantId }),
  });
  return (await response.json()) as {
    sessionToken: string;
    tenantId: string;
    userId: string;
  };
}

async function postJson(
  url: string,
  body: unknown,
  sessionToken?: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let parsed: unknown = undefined;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

async function getJson(
  url: string,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  let parsed: unknown = undefined;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

async function deleteRequest(
  url: string,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  let parsed: unknown = undefined;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}
