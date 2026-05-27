import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import { ALLOW, deny, type FrickPolicyHook } from "../src/authz.js";

// End-to-end tests for cross-user sharing primitives (FR-1).
//
// Two flavours:
//   1. HTTP-level invariants for the /share/* routes — happy path,
//      single-use, expiry, cross-tenant, owner self-accept, revoke.
//   2. Authz-flow integration — proves that an active grant flips a
//      policy-hook deny on object.write back to allow, and that revoking
//      the grant restores the deny.

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("sharing primitives — invitations and grants", () => {
  it("owner creates invitation; recipient accepts and gets a grant", async () => {
    app = await startServer();
    const owner = await devLogin(app.httpUrl, { userId: "user-owner", tenantId: "t1" });
    const recipient = await devLogin(app.httpUrl, { userId: "user-recipient", tenantId: "t1" });

    const inviteRes = await postJson(
      `${app.httpUrl}/share/invite`,
      { recordType: "Account", recordId: "acct-1", permission: "write" },
      owner.sessionToken,
    );
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.invitation.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(inviteRes.body.invitation.permission).toBe("write");
    expect(inviteRes.body.invitation.ownerUserId).toBe(owner.userId ?? "user-owner");

    const acceptRes = await postJson(
      `${app.httpUrl}/share/accept`,
      { token: inviteRes.body.invitation.token },
      recipient.sessionToken,
    );
    expect(acceptRes.status).toBe(201);
    expect(acceptRes.body.grant.permission).toBe("write");
    expect(acceptRes.body.grant.granteeUserId).toBe("user-recipient");
    expect(acceptRes.body.grant.recordType).toBe("Account");
    expect(acceptRes.body.grant.recordId).toBe("acct-1");
    expect(acceptRes.body.grant.revokedAt).toBeUndefined();
  });

  it("rejects a second accept of the same token (single-use)", async () => {
    app = await startServer();
    const owner = await devLogin(app.httpUrl, { userId: "user-owner-short", tenantId: "t1" });
    const r1 = await devLogin(app.httpUrl, { userId: "user-recipient-one", tenantId: "t1" });
    const r2 = await devLogin(app.httpUrl, { userId: "user-recipient-two", tenantId: "t1" });

    const inviteRes = await postJson(
      `${app.httpUrl}/share/invite`,
      { recordType: "Account", recordId: "acct-x", permission: "read" },
      owner.sessionToken,
    );
    const token = inviteRes.body.invitation.token;

    const first = await postJson(`${app.httpUrl}/share/accept`, { token }, r1.sessionToken);
    expect(first.status).toBe(201);

    const second = await postJson(`${app.httpUrl}/share/accept`, { token }, r2.sessionToken);
    expect(second.status).toBe(403);
    expect(second.body?.error?.message).toMatch(/already been redeemed/i);
  });

  it("rejects an expired invitation token", async () => {
    app = await startServer();
    const owner = await devLogin(app.httpUrl, { userId: "user-owner-short", tenantId: "t1" });
    const recipient = await devLogin(app.httpUrl, { userId: "user-r-expired", tenantId: "t1" });

    // Mint the invitation directly so we can stamp a past expiry. The
    // route path clamps to a future time; reaching into the store for
    // this case keeps the test fast and deterministic.
    const past = new Date(Date.now() - 60_000).toISOString();
    const invitation = app.store.invitations.create({
      id: "inv-expired",
      tenantId: "t1",
      ownerUserId: "user-owner-short",
      recordType: "Account",
      recordId: "acct-expired",
      permission: "read",
      token: "expired-token-aaaaaa",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: past,
    });
    void owner;

    const res = await postJson(
      `${app.httpUrl}/share/accept`,
      { token: invitation.token },
      recipient.sessionToken,
    );
    expect(res.status).toBe(403);
    expect(res.body?.error?.message).toMatch(/expired/i);
  });

  it("rejects accept of an invitation that belongs to a different tenant", async () => {
    app = await startServer();
    // Owner in t1 mints the invitation.
    const owner = await devLogin(app.httpUrl, { userId: "user-owner-cross", tenantId: "t1" });
    const inviteRes = await postJson(
      `${app.httpUrl}/share/invite`,
      { recordType: "Account", recordId: "acct-c", permission: "write" },
      owner.sessionToken,
    );
    const token = inviteRes.body.invitation.token;

    // Recipient is in t2 — same token; cross-tenant accept must reject.
    const recipient = await devLogin(app.httpUrl, { userId: "user-recipient-cross", tenantId: "t2" });
    const res = await postJson(`${app.httpUrl}/share/accept`, { token }, recipient.sessionToken);
    expect(res.status).toBe(403);
  });

  it("rejects an owner accepting their own invitation", async () => {
    app = await startServer();
    const owner = await devLogin(app.httpUrl, { userId: "user-solo", tenantId: "t1" });

    const inviteRes = await postJson(
      `${app.httpUrl}/share/invite`,
      { recordType: "Account", recordId: "acct-solo", permission: "write" },
      owner.sessionToken,
    );
    const res = await postJson(
      `${app.httpUrl}/share/accept`,
      { token: inviteRes.body.invitation.token },
      owner.sessionToken,
    );
    expect(res.status).toBe(403);
    expect(res.body?.error?.message).toMatch(/own invitation/i);
  });

  it("revoked grant is excluded from list by default; included with includeRevoked", async () => {
    app = await startServer();
    const owner = await devLogin(app.httpUrl, { userId: "user-owner-r", tenantId: "t1" });
    const recipient = await devLogin(app.httpUrl, { userId: "user-grantee-r", tenantId: "t1" });

    const inviteRes = await postJson(
      `${app.httpUrl}/share/invite`,
      { recordType: "Account", recordId: "acct-rev", permission: "write" },
      owner.sessionToken,
    );
    const acceptRes = await postJson(
      `${app.httpUrl}/share/accept`,
      { token: inviteRes.body.invitation.token },
      recipient.sessionToken,
    );
    const grantId: string = acceptRes.body.grant.id;

    const beforeRevoke = await getJson(`${app.httpUrl}/share/grants`, owner.sessionToken);
    expect(beforeRevoke.body.grants.map((g: any) => g.id)).toContain(grantId);

    const revoke = await deleteRequest(`${app.httpUrl}/share/grants/${grantId}`, owner.sessionToken);
    expect(revoke.status).toBe(200);
    expect(revoke.body.grant.revokedAt).toBeTruthy();

    const afterRevoke = await getJson(`${app.httpUrl}/share/grants`, owner.sessionToken);
    expect(afterRevoke.body.grants.map((g: any) => g.id)).not.toContain(grantId);

    const withRevoked = await getJson(
      `${app.httpUrl}/share/grants?includeRevoked=true`,
      owner.sessionToken,
    );
    expect(withRevoked.body.grants.map((g: any) => g.id)).toContain(grantId);
  });

  it("non-owner cannot revoke another user's grant", async () => {
    app = await startServer();
    const owner = await devLogin(app.httpUrl, { userId: "user-o-perm", tenantId: "t1" });
    const recipient = await devLogin(app.httpUrl, { userId: "user-r-perm", tenantId: "t1" });
    const stranger = await devLogin(app.httpUrl, { userId: "user-s-perm", tenantId: "t1" });

    const inviteRes = await postJson(
      `${app.httpUrl}/share/invite`,
      { recordType: "Account", recordId: "acct-perm", permission: "write" },
      owner.sessionToken,
    );
    const acceptRes = await postJson(
      `${app.httpUrl}/share/accept`,
      { token: inviteRes.body.invitation.token },
      recipient.sessionToken,
    );
    const grantId: string = acceptRes.body.grant.id;

    // Grantee revoking is treated as 404 — we don't expose the grant's
    // existence to anyone except the owner via revoke. (Listing still
    // works for grantees.)
    const granteeRevoke = await deleteRequest(
      `${app.httpUrl}/share/grants/${grantId}`,
      recipient.sessionToken,
    );
    expect(granteeRevoke.status).toBe(404);

    const strangerRevoke = await deleteRequest(
      `${app.httpUrl}/share/grants/${grantId}`,
      stranger.sessionToken,
    );
    expect(strangerRevoke.status).toBe(404);
  });
});


describe("sharing primitives — authz integration", () => {
  it("grant flips a policy-hook deny on object.write back to allow; revoke restores deny", async () => {
    // App-level policy hook: only the original owner can write Account.
    // The framework's default decision for object.write is allow for any
    // authenticated tenant user, so we tighten it here to mimic the
    // RangerCRM model where the policy layer encodes ownership.
    const ownerOnly: FrickPolicyHook = (input) => {
      if (input.action !== "object.write") {
        return null;
      }
      if (input.resource.name !== "Conversation") {
        return null;
      }
      const ownerId = (input.context?.value as Record<string, unknown> | undefined)?.createdBy;
      if (typeof ownerId !== "string") {
        return ALLOW;
      }
      if (input.principal?.userId === ownerId) {
        return ALLOW;
      }
      return deny("ownerMismatch", "Only the owner may write this Conversation");
    };

    app = await startServer({ policyHooks: [ownerOnly] });
    const owner = await devLogin(app.httpUrl, { userId: "user-alice", tenantId: "shared-t" });
    const recipient = await devLogin(app.httpUrl, { userId: "user-bob", tenantId: "shared-t" });

    // 1. Owner writes the record.
    const ownerWrite = await postJson(
      `${app.httpUrl}/objects/Conversation/acct-shared`,
      { kind: "group", title: "Acme Co", createdBy: "user-alice" },
      owner.sessionToken,
    );
    expect(ownerWrite.status).toBeLessThan(300);

    // 2. Recipient tries to write — policy hook denies (no grant yet).
    const beforeGrant = await postJson(
      `${app.httpUrl}/objects/Conversation/acct-shared`,
      { kind: "group", title: "Acme Co (edited by B)", createdBy: "user-alice" },
      recipient.sessionToken,
    );
    expect(beforeGrant.status).toBe(403);

    // 3. Owner invites recipient with write permission; recipient accepts.
    const inviteRes = await postJson(
      `${app.httpUrl}/share/invite`,
      { recordType: "Conversation", recordId: "acct-shared", permission: "write" },
      owner.sessionToken,
    );
    const acceptRes = await postJson(
      `${app.httpUrl}/share/accept`,
      { token: inviteRes.body.invitation.token },
      recipient.sessionToken,
    );
    expect(acceptRes.status).toBe(201);
    const grantId: string = acceptRes.body.grant.id;

    // 4. Recipient retries the write — grant lookup flips deny -> allow.
    const afterGrant = await postJson(
      `${app.httpUrl}/objects/Conversation/acct-shared`,
      { kind: "group", title: "Acme Co (edited by B)", createdBy: "user-alice" },
      recipient.sessionToken,
    );
    expect(afterGrant.status).toBeLessThan(300);

    // 5. Owner revokes; recipient is denied again.
    const revoke = await deleteRequest(`${app.httpUrl}/share/grants/${grantId}`, owner.sessionToken);
    expect(revoke.status).toBe(200);

    const afterRevoke = await postJson(
      `${app.httpUrl}/objects/Conversation/acct-shared`,
      { kind: "group", title: "Acme Co (edited by B again)", createdBy: "user-alice" },
      recipient.sessionToken,
    );
    expect(afterRevoke.status).toBe(403);
  });

  it("read-only grant does not satisfy an object.write check", async () => {
    const ownerOnly: FrickPolicyHook = (input) => {
      if (input.action !== "object.write" || input.resource.name !== "Conversation") {
        return null;
      }
      const ownerId = (input.context?.value as Record<string, unknown> | undefined)?.createdBy;
      if (typeof ownerId !== "string" || input.principal?.userId === ownerId) {
        return ALLOW;
      }
      return deny("ownerMismatch", "Only the owner may write this Account");
    };

    app = await startServer({ policyHooks: [ownerOnly] });
    const owner = await devLogin(app.httpUrl, { userId: "user-owner-ro", tenantId: "t1" });
    const recipient = await devLogin(app.httpUrl, { userId: "user-r-ro", tenantId: "t1" });

    await postJson(
      `${app.httpUrl}/objects/Conversation/acct-ro`,
      { kind: "group", title: "RO", createdBy: "user-owner-ro" },
      owner.sessionToken,
    );

    const inviteRes = await postJson(
      `${app.httpUrl}/share/invite`,
      { recordType: "Conversation", recordId: "acct-ro", permission: "read" },
      owner.sessionToken,
    );
    await postJson(
      `${app.httpUrl}/share/accept`,
      { token: inviteRes.body.invitation.token },
      recipient.sessionToken,
    );

    // Read-grant + write attempt — must still deny.
    const writeAttempt = await postJson(
      `${app.httpUrl}/objects/Conversation/acct-ro`,
      { kind: "group", title: "RO edited", createdBy: "user-owner-ro" },
      recipient.sessionToken,
    );
    expect(writeAttempt.status).toBe(403);
  });
});


async function startServer(opts: { policyHooks?: FrickPolicyHook[] } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    ...(opts.policyHooks ? { policyHooks: opts.policyHooks } : {}),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: server.close,
  };
}

async function devLogin(
  httpUrl: string,
  body: { userId: string; tenantId?: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{ sessionToken: string; tenantId: string; userId: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string; tenantId: string; userId: string };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
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
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
}

async function getJson(url: string, sessionToken: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
}

async function deleteRequest(
  url: string,
  sessionToken: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
}
