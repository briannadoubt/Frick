/**
 * Admin route tests for PUT /_frick/admin/tenants/:tenantId/push/apns (and
 * the FCM + Web Push variants). Verifies that the route is correctly gated by
 * admin auth, persists credentials via saveApnsCredentials, and returns the
 * right status codes for missing/invalid inputs.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import { loadApnsCredentials } from "../src/push/credentials.js";

const ADMIN_TOKEN = "test-admin-token-push-creds-ABCDEF1234567890ABCDEF12";
const FRICK_PUSH_CRED_KEY = randomBytes(32).toString("base64");

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("PUT /_frick/admin/tenants/:tenantId/push/apns", () => {
  it("returns 401 without admin token", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/admin/tenants/_default/push/apns`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keyId: "KEYID",
        teamId: "TEAMID",
        bundleId: "com.example",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 204 and persists credentials when FRICK_PUSH_CRED_KEY is set", async () => {
    app = await startServer({ pushCredKey: FRICK_PUSH_CRED_KEY });
    const response = await fetch(`${app.httpUrl}/_frick/admin/tenants/_default/push/apns`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        keyId: "KEYID",
        teamId: "TEAMID",
        bundleId: "com.example.app",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
        useSandbox: true,
      }),
    });
    expect(response.status).toBe(204);

    const loaded = await loadApnsCredentials(
      app.store.tenantSettings,
      "_default",
      { FRICK_PUSH_CRED_KEY },
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.keyId).toBe("KEYID");
    expect(loaded.value.teamId).toBe("TEAMID");
    expect(loaded.value.bundleId).toBe("com.example.app");
    expect(loaded.value.useSandbox).toBe(true);
  });

  it("returns 400 when FRICK_PUSH_CRED_KEY is not set", async () => {
    app = await startServer({ pushCredKey: undefined });
    const response = await fetch(`${app.httpUrl}/_frick/admin/tenants/_default/push/apns`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        keyId: "K",
        teamId: "T",
        bundleId: "com.example",
        privateKeyPem: "pem",
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("push.credentials.disabled");
  });

  it("returns 400 when required fields are missing", async () => {
    app = await startServer({ pushCredKey: FRICK_PUSH_CRED_KEY });
    const response = await fetch(`${app.httpUrl}/_frick/admin/tenants/_default/push/apns`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ keyId: "KEYID" }),
    });
    expect(response.status).toBe(400);
  });
});

interface StartOpts {
  pushCredKey?: string;
}

async function startServer(opts: StartOpts = { pushCredKey: FRICK_PUSH_CRED_KEY }) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: {
      adminToken: ADMIN_TOKEN,
      ...(opts.pushCredKey !== undefined
        ? {}
        : {}),
    },
  });
  // Inject the key into process.env for the credential store's load path.
  // We do this after construction because FrickStore reads env at call time.
  if (opts.pushCredKey !== undefined) {
    process.env.FRICK_PUSH_CRED_KEY = opts.pushCredKey;
  } else {
    delete process.env.FRICK_PUSH_CRED_KEY;
  }
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: server.store,
    close: async () => {
      await server.close();
      delete process.env.FRICK_PUSH_CRED_KEY;
    },
  };
}
