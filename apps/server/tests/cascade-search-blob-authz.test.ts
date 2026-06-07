import { afterEach, describe, expect, it } from "vitest";
import type { FrickSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import {
  assertCanReadBlob,
  AuthorizationError,
  deny,
  principalFromUserId,
  type FrickCascadeGrantLookup,
  type FrickPolicyInput,
} from "../src/authz.js";
import type { FrickSearchIndexDefinition } from "../src/search/types.js";

// FR-71 / FR-73: cross-user sharing grants must cascade beyond direct object
// reads to SEARCH results and BLOB access for a shared record, consistent with
// how object reads (FR-116) and stream/projection reads (FR-70) already honor
// grants. These tests cover both allow and deny paths plus revocation /
// leave-share, end to end through the HTTP server, and the blob authz unit.

const schema: FrickSchema = {
  name: "frick-fr71-test",
  schemaId: "frick-fr71-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "frick-fr71-test-0.1.0",
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

// A full-text index over Document objects. The on-write hook populates it when a
// Document is upserted.
const documentsIndex: FrickSearchIndexDefinition = {
  name: "documents-fts",
  source: { kind: "object", type: "Document" },
  project(input) {
    const value = input.object?.value;
    if (!value) return null;
    const title = typeof value.title === "string" ? value.title : "";
    const id = typeof value.id === "string" ? value.id : "";
    if (!title) return null;
    return { docId: id, text: title, fields: { documentId: id } };
  },
};

const streamIndex: FrickSearchIndexDefinition = {
  name: "edits-fts",
  source: { kind: "stream", type: "documentEdits" },
  project(input) {
    const e = input.streamEvent;
    if (!e) return null;
    const summary =
      typeof (e.payload as Record<string, unknown>)?.summary === "string"
        ? ((e.payload as Record<string, unknown>).summary as string)
        : "";
    if (!summary) return null;
    return { docId: e.eventId, text: summary, fields: { documentId: e.streamId } };
  },
};

/**
 * App policy that makes every record private to its owner. A record whose id is
 * `<id>` is owned by `owner-<id>`. For everyone else this denies `object.read`,
 * `stream.read` and `projection.read` — the denies the FR-70/FR-71 cascade is
 * expected to relax for an active grantee. Search-index queries are allowed so
 * the custom app-source index is reachable; per-record filtering then applies.
 */
function ownerOnlyReads(input: FrickPolicyInput) {
  if (
    input.action === "search.query" &&
    input.resource.kind === "search"
  ) {
    return { allow: true, reason: "allow" } as const;
  }
  if (
    input.action !== "object.read" &&
    input.action !== "stream.read" &&
    input.action !== "projection.read"
  ) {
    return null;
  }
  const key = input.resource.key;
  const ownerId = key ? `owner-${key}` : undefined;
  if (input.principal && ownerId && input.principal.userId === ownerId) {
    return null; // owner: no opinion, baseline stands
  }
  return deny("notAuthorizedForResource", "Record is private to its owner");
}

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// ---------------------------------------------------------------------------
// Unit: assertCanReadBlob cascade (FR-71)
// ---------------------------------------------------------------------------

describe("FR-71 — assertCanReadBlob cascade (unit)", () => {
  const TENANT = "t1";
  const OWNER = "owner-blob-1";
  const GRANTEE = "user-grantee";
  const STRANGER = "user-stranger";
  const BLOB_ID = "blob-1";

  // Cascade grant: only GRANTEE in TENANT holds a grant on record id == BLOB_ID.
  const cascade: FrickCascadeGrantLookup = (args) =>
    Promise.resolve(
      args.tenantId === TENANT &&
        args.granteeUserId === GRANTEE &&
        args.recordId === BLOB_ID,
    );

  async function attempt(userId: string, tenant: string): Promise<"allow" | "deny"> {
    const principal = principalFromUserId(userId, "r", "d", tenant);
    try {
      await assertCanReadBlob(principal, OWNER, undefined, BLOB_ID, cascade);
      return "allow";
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      return "deny";
    }
  }

  it("owner reads their own blob", async () => {
    const principal = principalFromUserId(OWNER, "r", "d", TENANT);
    await expect(
      assertCanReadBlob(principal, OWNER, undefined, BLOB_ID, cascade),
    ).resolves.toBeUndefined();
  });

  it("grantee reads a shared blob via the cascade", async () => {
    expect(await attempt(GRANTEE, TENANT)).toBe("allow");
  });

  it("stranger without a grant is denied", async () => {
    expect(await attempt(STRANGER, TENANT)).toBe("deny");
  });

  it("cross-tenant grantee is denied (cascade is tenant-scoped)", async () => {
    expect(await attempt(GRANTEE, "t2")).toBe("deny");
  });

  it("without a blobId or lookup, non-owner stays denied (no relaxation)", async () => {
    const principal = principalFromUserId(GRANTEE, "r", "d", TENANT);
    await expect(assertCanReadBlob(principal, OWNER)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP: object search hits honor grants (FR-71)
// ---------------------------------------------------------------------------

describe("FR-71 — object search results respect grants", () => {
  it("a grantee finds a shared Document in search; strangers do not", async () => {
    app = await startServer({ policyHooks: [ownerOnlyReads], indexes: [documentsIndex] });
    const docId = "doc-1";
    const owner = await devLogin(app.httpUrl, { userId: `owner-${docId}`, tenantId: "t1" });
    const grantee = await devLogin(app.httpUrl, { userId: "user-grantee", tenantId: "t1" });
    const stranger = await devLogin(app.httpUrl, { userId: "user-stranger", tenantId: "t1" });

    await app.store.upsertObject("t1", "Document", docId, {
      id: docId,
      title: "Penguin Roadmap",
    });

    // Owner finds it.
    const ownerSearch = await postSearch(app.httpUrl, owner.sessionToken, {
      index: "documents-fts",
      q: "penguin",
    });
    expect(ownerSearch.status).toBe(200);
    expect(ownerSearch.body.hits.length).toBe(1);

    // Stranger (same tenant, no grant) gets zero hits — the record is filtered.
    const strangerSearch = await postSearch(app.httpUrl, stranger.sessionToken, {
      index: "documents-fts",
      q: "penguin",
    });
    expect(strangerSearch.status).toBe(200);
    expect(strangerSearch.body.hits.length).toBe(0);

    // Before the grant, the grantee sees nothing either.
    const beforeGrant = await postSearch(app.httpUrl, grantee.sessionToken, {
      index: "documents-fts",
      q: "penguin",
    });
    expect(beforeGrant.body.hits.length).toBe(0);

    // Share the Document -> the grantee's search now surfaces the hit.
    const grantId = await shareRecord(
      app.httpUrl,
      owner.sessionToken,
      grantee.sessionToken,
      docId,
    );
    const afterGrant = await postSearch(app.httpUrl, grantee.sessionToken, {
      index: "documents-fts",
      q: "penguin",
    });
    expect(afterGrant.body.hits.length).toBe(1);
    expect(afterGrant.body.hits[0].fields.documentId).toBe(docId);

    // Revoke -> the search hit disappears again (revocation-aware).
    const revoke = await del(`${app.httpUrl}/share/grants/${grantId}`, owner.sessionToken);
    expect(revoke.status).toBe(200);
    const afterRevoke = await postSearch(app.httpUrl, grantee.sessionToken, {
      index: "documents-fts",
      q: "penguin",
    });
    expect(afterRevoke.body.hits.length).toBe(0);

    // Stranger is still empty throughout.
    const strangerStill = await postSearch(app.httpUrl, stranger.sessionToken, {
      index: "documents-fts",
      q: "penguin",
    });
    expect(strangerStill.body.hits.length).toBe(0);
  });

  it("search cascade does not cross tenants", async () => {
    app = await startServer({ policyHooks: [ownerOnlyReads], indexes: [documentsIndex] });
    const docId = "doc-1";
    const owner = await devLogin(app.httpUrl, { userId: `owner-${docId}`, tenantId: "t1" });
    const grantee = await devLogin(app.httpUrl, { userId: "user-grantee", tenantId: "t1" });
    await app.store.upsertObject("t1", "Document", docId, { id: docId, title: "Penguin" });
    await shareRecord(app.httpUrl, owner.sessionToken, grantee.sessionToken, docId);

    const granteeSearch = await postSearch(app.httpUrl, grantee.sessionToken, {
      index: "documents-fts",
      q: "penguin",
    });
    expect(granteeSearch.body.hits.length).toBe(1);

    // A user in another tenant holds no grant there — and the t1 record isn't in
    // their tenant index — so nothing surfaces.
    const other = await devLogin(app.httpUrl, { userId: "user-other", tenantId: "t2" });
    const otherSearch = await postSearch(app.httpUrl, other.sessionToken, {
      index: "documents-fts",
      q: "penguin",
    });
    expect(otherSearch.body.hits.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP: stream search hits honor the cascade (FR-71)
// ---------------------------------------------------------------------------

describe("FR-71 — stream search results respect the cascade", () => {
  it("a grantee finds shared stream events in search; strangers do not", async () => {
    app = await startServer({ policyHooks: [ownerOnlyReads], indexes: [streamIndex] });
    const docId = "doc-1";
    const owner = await devLogin(app.httpUrl, { userId: `owner-${docId}`, tenantId: "t1" });
    const grantee = await devLogin(app.httpUrl, { userId: "user-grantee", tenantId: "t1" });

    await app.store.appendEvent({
      tenantId: "t1",
      requestId: "req-1",
      replicaId: "test",
      stream: "documentEdits",
      streamId: docId,
      event: "edited",
      payload: { summary: "Penguin migration plan" },
    });

    const before = await postSearch(app.httpUrl, grantee.sessionToken, {
      index: "edits-fts",
      q: "penguin",
    });
    expect(before.body.hits.length).toBe(0);

    const grantId = await shareRecord(
      app.httpUrl,
      owner.sessionToken,
      grantee.sessionToken,
      docId,
    );
    const after = await postSearch(app.httpUrl, grantee.sessionToken, {
      index: "edits-fts",
      q: "penguin",
    });
    expect(after.body.hits.length).toBe(1);
    expect(after.body.hits[0].fields.documentId).toBe(docId);

    // Leave-share (grantee self-revocation) removes the search visibility.
    const leave = await postJson(
      `${app.httpUrl}/share/grants/${grantId}/leave`,
      {},
      grantee.sessionToken,
    );
    expect(leave.status).toBe(200);
    const afterLeave = await postSearch(app.httpUrl, grantee.sessionToken, {
      index: "edits-fts",
      q: "penguin",
    });
    expect(afterLeave.body.hits.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP: blob access honors grants (FR-71)
// ---------------------------------------------------------------------------

describe("FR-71 — blob access respects grants", () => {
  it("grantee reads a shared blob's metadata + content; revoke removes access", async () => {
    app = await startServer({ policyHooks: [ownerOnlyReads] });
    const docId = "doc-1";
    const ownerId = `owner-${docId}`;
    const owner = await devLogin(app.httpUrl, { userId: ownerId, tenantId: "t1" });
    const grantee = await devLogin(app.httpUrl, { userId: "user-grantee", tenantId: "t1" });
    const stranger = await devLogin(app.httpUrl, { userId: "user-stranger", tenantId: "t1" });

    // A blob whose blobId == the shared record id, owned by the record owner.
    const content = new TextEncoder().encode("hello penguins");
    await app.store.blobs.create("t1", {
      blobId: docId,
      ownerId,
      contentHash: "hash-1",
      byteLength: content.byteLength,
      mimeType: "text/plain",
    });
    await app.store.blobs.writeContent("t1", docId, content);

    // Owner reads metadata + content.
    const ownerMeta = await get(`${app.httpUrl}/blobs/${docId}`, owner.sessionToken);
    expect(ownerMeta.status).toBe(200);
    const ownerContent = await getRaw(`${app.httpUrl}/blobs/${docId}/content`, owner.sessionToken);
    expect(ownerContent.status).toBe(200);

    // Stranger is denied both.
    const strangerMeta = await get(`${app.httpUrl}/blobs/${docId}`, stranger.sessionToken);
    expect(strangerMeta.status).toBe(403);
    const strangerContent = await getRaw(
      `${app.httpUrl}/blobs/${docId}/content`,
      stranger.sessionToken,
    );
    expect(strangerContent.status).toBe(403);

    // Grantee denied before the grant.
    const beforeMeta = await get(`${app.httpUrl}/blobs/${docId}`, grantee.sessionToken);
    expect(beforeMeta.status).toBe(403);

    // Share the record -> the grantee can now read the blob keyed by that id.
    const grantId = await shareRecord(
      app.httpUrl,
      owner.sessionToken,
      grantee.sessionToken,
      docId,
    );
    const afterMeta = await get(`${app.httpUrl}/blobs/${docId}`, grantee.sessionToken);
    expect(afterMeta.status).toBe(200);
    const afterContent = await getRaw(
      `${app.httpUrl}/blobs/${docId}/content`,
      grantee.sessionToken,
    );
    expect(afterContent.status).toBe(200);
    expect(await afterContent.text).toBe("hello penguins");

    // Revoke -> blob access disappears immediately.
    const revoke = await del(`${app.httpUrl}/share/grants/${grantId}`, owner.sessionToken);
    expect(revoke.status).toBe(200);
    const revokedMeta = await get(`${app.httpUrl}/blobs/${docId}`, grantee.sessionToken);
    expect(revokedMeta.status).toBe(403);
    const revokedContent = await getRaw(
      `${app.httpUrl}/blobs/${docId}/content`,
      grantee.sessionToken,
    );
    expect(revokedContent.status).toBe(403);
  });

  it("blob grant does not cross tenants", async () => {
    app = await startServer({ policyHooks: [ownerOnlyReads] });
    const docId = "doc-1";
    const ownerId = `owner-${docId}`;
    const owner = await devLogin(app.httpUrl, { userId: ownerId, tenantId: "t1" });
    const grantee = await devLogin(app.httpUrl, { userId: "user-grantee", tenantId: "t1" });
    const content = new TextEncoder().encode("tenant-1 only");
    await app.store.blobs.create("t1", {
      blobId: docId,
      ownerId,
      contentHash: "hash-2",
      byteLength: content.byteLength,
      mimeType: "text/plain",
    });
    await app.store.blobs.writeContent("t1", docId, content);
    await shareRecord(app.httpUrl, owner.sessionToken, grantee.sessionToken, docId);

    const granteeMeta = await get(`${app.httpUrl}/blobs/${docId}`, grantee.sessionToken);
    expect(granteeMeta.status).toBe(200);

    // A different tenant's user can't even see the blob exists (404), let alone
    // read it — tenant isolation comes first.
    const other = await devLogin(app.httpUrl, { userId: "user-other", tenantId: "t2" });
    const otherMeta = await get(`${app.httpUrl}/blobs/${docId}`, other.sessionToken);
    expect(otherMeta.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function shareRecord(
  httpUrl: string,
  ownerToken: string,
  granteeToken: string,
  recordId: string,
  permission: "read" | "write" = "read",
): Promise<string> {
  const invite = await postJson(
    `${httpUrl}/share/invite`,
    { recordType: "Document", recordId, permission },
    ownerToken,
  );
  expect(invite.status).toBe(201);
  const accept = await postJson(
    `${httpUrl}/share/accept`,
    { token: invite.body.invitation.token },
    granteeToken,
  );
  expect(accept.status).toBe(201);
  return accept.body.grant.id as string;
}

function startServer(
  overrides: {
    policyHooks?: Parameters<typeof createFrickServer>[0]["policyHooks"];
    indexes?: FrickSearchIndexDefinition[];
  } = {},
): Promise<{
  httpUrl: string;
  store: ReturnType<typeof createFrickServer>["store"];
  close: () => Promise<void>;
}> {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema,
    ...(overrides.policyHooks !== undefined ? { policyHooks: overrides.policyHooks } : {}),
    ...(overrides.indexes !== undefined ? { search: { indexes: overrides.indexes } } : {}),
  });
  return server.listen().then(() => {
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return {
      httpUrl: `http://127.0.0.1:${port}`,
      store: server.store,
      close: () => server.close(),
    };
  });
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
  return (await response.json()) as { sessionToken: string; tenantId: string; userId: string };
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
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function postSearch(
  httpUrl: string,
  sessionToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return postJson(`${httpUrl}/search`, body, sessionToken);
}

async function get(
  url: string,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function getRaw(
  url: string,
  sessionToken: string,
): Promise<{ status: number; text: Promise<string> }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  return { status: response.status, text: response.text() };
}

async function del(
  url: string,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}
