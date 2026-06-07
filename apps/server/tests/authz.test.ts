import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope, productTestSchema } from "@fricken/protocol";
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

  it("does not accept protected HTTP session tokens from the query string", async () => {
    app = await startServer();
    const login = await devLogin(app.httpUrl, { userId: "user-ada" });

    const response = await fetch(
      `${app.httpUrl}/objects?sessionToken=${encodeURIComponent(login.sessionToken)}`,
    );

    expect(response.status).toBe(401);
  });

  // Removed: notMember/inbox.read/TypingState authz tests. Those rules
  // were chat-specific (MessageStream-as-conversation, inbox.read,
  // TypingState membership) and were deleted from src/authz.ts during the
  // framework boundary cleanup. The framework's generic authz primitives
  // (allow/deny envelopes, policy hooks, admin scope, tenant isolation,
  // self-User writes, blob owner checks) are still covered by the
  // surviving tests in this file.

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

  it("defaults blob listing to the principal and rejects another ownerId", async () => {
    app = await startServer();
    const adaLogin = await devLogin(app.httpUrl, { userId: "user-ada" });
    const graceLogin = await devLogin(app.httpUrl, { userId: "user-grace" });

    const adaUpload = await fetch(`${app.httpUrl}/blobs/blob-ada-list/content?ownerId=user-ada`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(adaLogin.sessionToken) },
      body: Buffer.from("ada bytes"),
    });
    expect(adaUpload.status).toBe(201);
    const graceUpload = await fetch(`${app.httpUrl}/blobs/blob-grace-list/content?ownerId=user-grace`, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...authHeaders(graceLogin.sessionToken) },
      body: Buffer.from("grace bytes"),
    });
    expect(graceUpload.status).toBe(201);

    const ownList = await fetch(`${app.httpUrl}/blobs`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    expect(ownList.status).toBe(200);
    const ownBody = await ownList.json();
    expect(ownBody.data.map((row: { blobId: string }) => row.blobId)).toEqual(["blob-ada-list"]);

    const otherList = await fetch(`${app.httpUrl}/blobs?ownerId=user-grace`, {
      headers: authHeaders(adaLogin.sessionToken),
    });
    expect(otherList.status).toBe(403);
    const otherBody = await otherList.json();
    expect(otherBody.error.details.reason).toBe("ownerMismatch");
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

});

describe("decide() deny-by-default for unrecognised actions", () => {
  const memberships: MembershipReader = {
    hasUser: (userId) => userId === "user-ada",
    isRoomMember: () => false,
    hasConversation: () => false,
  };
  const stranger = principalFromUserId("user-stranger");

  it("denies object.read for an action with no explicit allow rule", async () => {
    const decision = decide(
      { principal: stranger, action: "object.read", resource: { kind: "object", name: "Conversation" } },
      memberships,
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toBe("notAuthorizedForResource");
    }
  });

  it("allows custom presence writes so app policy hooks can tighten them", async () => {
    const decision = decide(
      {
        principal: stranger,
        action: "presence.write",
        resource: { kind: "presence", name: "Typing", key: "conversation-x" },
      },
      memberships,
    );
    expect(decision.allow).toBe(true);
  });

  it("allows object.write for custom app objects in the principal's own tenant", async () => {
    const decision = decide(
      { principal: stranger, action: "object.write", resource: { kind: "object", name: "Note" } },
      memberships,
    );
    expect(decision.allow).toBe(true);
  });

  it("denies cross-tenant object.write with reason tenantMismatch", async () => {
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
  it("admin-scope decide() permits a different resource tenant", async () => {
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

  it("tenant-scope decide() denies a different resource tenant with tenantMismatch", async () => {
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
    schema: productTestSchema,
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
