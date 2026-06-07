import { afterEach, describe, expect, it } from "vitest";
import {
  createConsoleLogger,
  isSensitiveFieldName,
  redactSensitiveFields,
} from "../src/logger.js";
import { createFrickServer } from "../src/server.js";
import type { AdminAuditRow } from "../src/storage/admin-audit-store.js";

// ---------------------------------------------------------------------------
// FR-69: Privacy-safe logging
// ---------------------------------------------------------------------------

describe("redactSensitiveFields", () => {
  it("scrubs message/stream-event bodies and payloads", () => {
    const out = redactSensitiveFields({
      streamId: "s-1",
      body: "super secret message text",
      payload: { plaintext: "more secrets" },
      messageBody: "another body",
    });
    expect(out.streamId).toBe("s-1");
    expect(out.body).toBe("<redacted>");
    expect(out.payload).toBe("<redacted>");
    expect(out.messageBody).toBe("<redacted>");
  });

  it("scrubs session/reset/device/push tokens and password hashes", () => {
    const out = redactSensitiveFields({
      userId: "user-ada",
      sessionToken: "sess-abc",
      resetToken: "reset-xyz",
      deviceToken: "apns-123",
      refreshToken: "refresh-456",
      passwordHash: "0xdeadbeef",
      password: "hunter2",
    });
    expect(out.userId).toBe("user-ada");
    for (const key of [
      "sessionToken",
      "resetToken",
      "deviceToken",
      "refreshToken",
      "passwordHash",
      "password",
    ]) {
      expect(out[key]).toBe("<redacted>");
    }
  });

  it("scrubs assorted secret-shaped fields recursively", () => {
    const out = redactSensitiveFields({
      ok: "visible",
      nested: {
        cookie: "session=abc",
        signature: "sig",
        ciphertext: "==",
        apiKey: "ak_live_123",
        kept: "still-here",
      },
    });
    expect(out.ok).toBe("visible");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.cookie).toBe("<redacted>");
    expect(nested.signature).toBe("<redacted>");
    expect(nested.ciphertext).toBe("<redacted>");
    expect(nested.apiKey).toBe("<redacted>");
    expect(nested.kept).toBe("still-here");
  });

  it("does NOT redact benign hash-shaped framework fields", () => {
    // These are logged/audited legitimately and must stay readable.
    for (const key of ["schemaHash", "entryHash", "previousHash", "contentHash"]) {
      expect(isSensitiveFieldName(key)).toBe(false);
    }
    expect(isSensitiveFieldName("sessionToken")).toBe(true);
    expect(isSensitiveFieldName("body")).toBe(true);
  });
});

describe("console logger applies broadened redaction", () => {
  it("redacts a stream-event body passed in log fields", () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createConsoleLogger(
      { logLevel: "debug" },
      { out: (line) => lines.push(JSON.parse(line)), err: (line) => lines.push(JSON.parse(line)) },
    );
    logger.info("frick.stream.append", {
      streamId: "s-1",
      body: "do-not-log-this",
      payload: { secret: "nope" },
    });
    expect(lines[0].streamId).toBe("s-1");
    expect(lines[0].body).toBe("<redacted>");
    expect(lines[0].payload).toBe("<redacted>");
  });
});

// ---------------------------------------------------------------------------
// FR-69: Audit events for auth + data lifecycle
// ---------------------------------------------------------------------------

async function startServer() {
  const server = createFrickServer({ port: 0, dbPath: ":memory:" });
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

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function auditRows(): Promise<AdminAuditRow[]> {
  return app!.store.adminAudit.list({ limit: 1000 });
}

describe("auth + lifecycle audit events", () => {
  it("emits a hash-chained audit row for signup, login, and logout", async () => {
    app = await startServer();
    const signup = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Ada Lovelace",
        handle: "ada",
        password: "correct horse battery",
      }),
    });
    expect(signup.status).toBe(201);
    const { sessionToken, userId } = (await signup.json()) as {
      sessionToken: string;
      userId: string;
    };

    const login = await fetch(`${app.httpUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "ada", password: "correct horse battery" }),
    });
    expect(login.status).toBe(200);

    const logout = await fetch(`${app.httpUrl}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(logout.status).toBe(200);

    const rows = await auditRows();
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("auth.signup");
    expect(actions).toContain("auth.login");
    expect(actions).toContain("auth.logout");

    // Subject is recorded as the target; actor fingerprint never carries raw id.
    const signupRow = rows.find((r) => r.action === "auth.signup")!;
    expect(signupRow.target).toBe(userId);
    expect(signupRow.adminTokenFingerprint).toMatch(/^u:[0-9a-f]{12}$/);
    expect(signupRow.outcome).toBe("allow");

    // The lifecycle rows are part of the same tamper-evident chain.
    expect(await app.store.adminAudit.verifyChain()).toEqual({ valid: true });
  });

  it("records a deny audit row on a failed login", async () => {
    app = await startServer();
    const login = await fetch(`${app.httpUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "ghost", password: "wrong" }),
    });
    expect(login.status).toBe(401);
    const rows = await auditRows();
    const denyRow = rows.find((r) => r.action === "auth.login" && r.outcome === "deny");
    expect(denyRow).toBeDefined();
    // The audit detail must never carry the attempted password.
    expect(denyRow!.detail ?? "").not.toContain("wrong");
  });

  it("audits a self-service data export and never leaks the session token", async () => {
    app = await startServer();
    const signup = await fetch(`${app.httpUrl}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Grace Hopper",
        handle: "grace",
        password: "nanoseconds-matter",
      }),
    });
    const { sessionToken, userId } = (await signup.json()) as {
      sessionToken: string;
      userId: string;
    };

    const exportResp = await fetch(`${app.httpUrl}/account/export`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(exportResp.status).toBe(200);

    const rows = await auditRows();
    const exportRow = rows.find((r) => r.action === "account.export");
    expect(exportRow).toBeDefined();
    expect(exportRow!.target).toBe(userId);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(sessionToken);
    }
  });
});
