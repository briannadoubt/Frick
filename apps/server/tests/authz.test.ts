import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import {
  decide,
  principalFromUserId,
  type FrickPolicyHook,
  type MembershipReader,
} from "../src/authz.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("authorization denial envelopes", () => {
  it("returns 401 unauthenticated for object reads without a session", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/objects`);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.unauthenticated");
    expect(body.error.details.reason).toBe("unauthenticated");
  });

  it("denies non-members reading another conversation's stream with reason notMember", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });

    const response = await fetch(`${app.httpUrl}/streams/MessageStream/conversation-general`, {
      headers: authHeaders(malloryLogin.sessionToken),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notMember");
  });

  it("denies non-members appending to another conversation's stream with reason notMember", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });

    const response = await fetch(`${app.httpUrl}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(malloryLogin.sessionToken) },
      body: JSON.stringify({
        requestId: "request-mallory-denied",
        replicaId: "replica-mallory",
        stream: "MessageStream",
        key: "conversation-general",
        event: "MessageSent",
        payload: {
          messageId: "message-mallory-denied",
          senderId: "user-mallory",
          body: "nope",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notMember");
  });

  it("denies blob uploads with mismatched ownerId via ownerMismatch", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/blobs/blob-spoof/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(login.sessionToken) },
      body: Buffer.from("not ada's blob"),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("ownerMismatch");
  });

  it("denies reading another user's blob content and metadata with reason ownerMismatch", async () => {
    app = await startServer();
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });
    const graceLogin = await devLogin(app.httpUrl, { userId: "user-grace" });

    // Grace uploads a blob she owns.
    const blobBody = Buffer.from("grace's secret");
    const upload = await fetch(`${app.httpUrl}/blobs/blob-grace-secret/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(graceLogin.sessionToken) },
      body: blobBody,
    });
    expect(upload.status).toBe(201);

    // Ada tries to fetch Grace's content.
    const contentRead = await fetch(`${app.httpUrl}/blobs/blob-grace-secret/content`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    const contentBody = await contentRead.json();
    expect(contentRead.status).toBe(403);
    expect(isFrickErrorEnvelope(contentBody.error)).toBe(true);
    expect(contentBody.error.code).toBe("auth.forbidden");
    expect(contentBody.error.details.reason).toBe("ownerMismatch");

    // Ada tries to fetch Grace's metadata.
    const metaRead = await fetch(`${app.httpUrl}/blobs/blob-grace-secret`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    const metaBody = await metaRead.json();
    expect(metaRead.status).toBe(403);
    expect(metaBody.error.details.reason).toBe("ownerMismatch");
  });

  it("allows the owner to read their own blob content and metadata", async () => {
    app = await startServer();
    const graceLogin = await devLogin(app.httpUrl, { userId: "user-grace" });

    const blobBody = Buffer.from("grace's own bytes");
    const upload = await fetch(`${app.httpUrl}/blobs/blob-grace-own/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(graceLogin.sessionToken) },
      body: blobBody,
    });
    expect(upload.status).toBe(201);

    const contentRead = await fetch(`${app.httpUrl}/blobs/blob-grace-own/content`, {
      headers: authHeaders(graceLogin.sessionToken),
    });
    expect(contentRead.status).toBe(200);
    const bytes = Buffer.from(await contentRead.arrayBuffer());
    expect(bytes.equals(blobBody)).toBe(true);

    const metaRead = await fetch(`${app.httpUrl}/blobs/blob-grace-own`, {
      headers: authHeaders(graceLogin.sessionToken),
    });
    expect(metaRead.status).toBe(200);
    const meta = await metaRead.json();
    expect(meta.ownerId).toBe("user-grace");
  });

  it("denies non-members POSTing signals to another conversation with reason notMember", async () => {
    app = await startServer();
    app.store.upsertObject("User", "user-mallory", {
      displayName: "Mallory",
      avatarBlobId: undefined,
    });
    const malloryLogin = await devLogin(app.httpUrl, { userId: "user-mallory" });

    const response = await fetch(`${app.httpUrl}/signals/WebRTCSignal/conversation-general`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(malloryLogin.sessionToken) },
      body: JSON.stringify({
        senderDeviceId: "device-mallory",
        kind: "offer",
        payload: "sdp-from-outsider",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notMember");
  });

  it("invokes registered policy hooks after an allow and lets them deny", async () => {
    const denySignals: FrickPolicyHook = (input) => {
      if (input.action === "signal.send") {
        return {
          allow: false,
          reason: "notAuthorizedForResource",
          publicMessage: "Signals disabled by app policy",
        };
      }
      return null;
    };
    app = await startServer({ policyHooks: [denySignals] });
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });

    // Ada is a member of conversation-general, so the framework would allow.
    // The hook denies.
    const response = await fetch(`${app.httpUrl}/signals/WebRTCSignal/conversation-general`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(adaLogin.sessionToken) },
      body: JSON.stringify({
        senderDeviceId: "device-ada",
        kind: "offer",
        payload: "sdp-hooked",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notAuthorizedForResource");
    expect(body.error.message).toBe("Signals disabled by app policy");
  });

  it("treats a policy hook returning null as no-opinion", async () => {
    const noOpinion: FrickPolicyHook = () => null;
    app = await startServer({ policyHooks: [noOpinion] });
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });

    // Reading own inbox would be allowed by the framework; the hook abstains.
    const response = await fetch(`${app.httpUrl}/inbox`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.userId).toBe("user-ada");
  });

  it("does not consult policy hooks once the framework has denied", async () => {
    let hookCalls = 0;
    const allowEverything: FrickPolicyHook = () => {
      hookCalls += 1;
      return { allow: true, reason: "allow" };
    };
    app = await startServer({ policyHooks: [allowEverything] });
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });

    // Framework denies (ownerMismatch); the hook must not be invoked and
    // certainly must not be able to override the deny.
    const response = await fetch(`${app.httpUrl}/blobs/blob-hook-skipped/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(adaLogin.sessionToken) },
      body: Buffer.from("nope"),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.details.reason).toBe("ownerMismatch");
    expect(hookCalls).toBe(0);
  });

  it("denies reading another user's inbox with notAuthorizedForResource", async () => {
    app = await startServer();
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/inbox?userId=user-grace`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("auth.forbidden");
    expect(body.error.details.reason).toBe("notAuthorizedForResource");
  });
});

describe("decide() deny-by-default for unrecognised actions", () => {
  const memberships: MembershipReader = {
    hasUser: (userId) => userId === "user-ada",
    isRoomMember: () => false,
    hasConversation: () => false,
  };
  const stranger = principalFromUserId("user-stranger");

  it("denies object.read for an action with no explicit allow rule", () => {
    const decision = decide(
      { principal: stranger, action: "object.read", resource: { kind: "object", name: "Conversation" } },
      memberships,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("notAuthorizedForResource");
    }
  });

  it("denies presence.write for an action with no explicit allow rule", () => {
    const decision = decide(
      { principal: stranger, action: "presence.write", resource: { kind: "presence", name: "Typing", key: "conversation-x" } },
      memberships,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("notAuthorizedForResource");
    }
  });

  it("allows object.write for any authenticated principal in its own tenant", () => {
    const decision = decide(
      { principal: stranger, action: "object.write", resource: { kind: "object", name: "Conversation" } },
      memberships,
    );
    expect(decision.allow).toBe(true);
  });

  it("denies cross-tenant object.write with reason tenantMismatch", () => {
    const decision = decide(
      {
        principal: stranger,
        action: "object.write",
        resource: { kind: "object", name: "Conversation", tenantId: "other-tenant" },
      },
      memberships,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("tenantMismatch");
    }
  });

  it("still allows the owner's own inbox.read (regression: explicit allow rules unchanged)", () => {
    const ada = principalFromUserId("user-ada");
    const decision = decide(
      { principal: ada, action: "inbox.read", resource: { kind: "inbox", key: "user-ada", ownerId: "user-ada" } },
      memberships,
    );
    expect(decision.allow).toBe(true);
  });
});

describe("policy hook ordering", () => {
  it("invokes hooks in registration order and the first deny wins", async () => {
    const calls: string[] = [];
    const allowAll: FrickPolicyHook = () => {
      calls.push("allowAll");
      return { allow: true, reason: "allow" };
    };
    const denyForX: FrickPolicyHook = (input) => {
      calls.push("denyForX");
      if (input.action === "signal.send") {
        return {
          allow: false,
          reason: "notAuthorizedForResource",
          publicMessage: "Denied by denyForX",
        };
      }
      return null;
    };
    const denyForY: FrickPolicyHook = (input) => {
      calls.push("denyForY");
      if (input.action === "signal.send") {
        return {
          allow: false,
          reason: "notAuthorizedForResource",
          publicMessage: "Denied by denyForY",
        };
      }
      return null;
    };

    app = await startServer({ policyHooks: [allowAll, denyForX, denyForY] });
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(`${app.httpUrl}/signals/WebRTCSignal/conversation-general`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(adaLogin.sessionToken) },
      body: JSON.stringify({
        senderDeviceId: "device-ada",
        kind: "offer",
        payload: "sdp-order-test",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe("Denied by denyForX");
    // denyForY must NOT have been consulted for the signal-send action once denyForX denied.
    expect(calls).toContain("denyForX");
    expect(calls).not.toContain("denyForY");
  });
});

describe("admin scope bypasses tenant isolation", () => {
  it("admin-scope decide() permits a different resource tenant", () => {
    const adminPrincipal = {
      userId: "_admin",
      deviceId: "_admin",
      replicaId: "_admin",
      tenantId: "_default",
      scope: "admin" as const,
    };
    const memberships: MembershipReader = {
      hasUser: () => true,
      isRoomMember: () => true,
      hasConversation: () => true,
    };
    const decision = decide(
      {
        principal: adminPrincipal,
        action: "object.read",
        resource: { kind: "object", tenantId: "tenant-other" },
      },
      memberships,
    );
    // The cross-tenant check no longer fires; the deny here, if any, is from
    // the action policy (object.read falls through to the default deny). The
    // important assertion: it's NOT a tenantMismatch.
    if (!decision.allow) {
      expect(decision.reason).not.toBe("tenantMismatch");
    }
  });

  it("tenant-scope decide() denies a different resource tenant with tenantMismatch", () => {
    const tenantPrincipal = principalFromUserId("user-ada", "replica", "device", "tenant-a");
    const memberships: MembershipReader = {
      hasUser: () => true,
      isRoomMember: () => true,
      hasConversation: () => true,
    };
    const decision = decide(
      {
        principal: tenantPrincipal,
        action: "stream.read",
        resource: { kind: "stream", name: "MessageStream", key: "x", tenantId: "tenant-b" },
      },
      memberships,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("tenantMismatch");
    }
  });
});

async function startServer(options: { policyHooks?: readonly FrickPolicyHook[] } = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...(options.policyHooks ? { policyHooks: options.policyHooks } : {}),
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
  body: { userId: string; deviceId?: string; replicaId?: string; platform?: string },
): Promise<{ sessionToken: string }> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionToken: string };
}

function authHeaders(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}
