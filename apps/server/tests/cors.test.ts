import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("CORS enforcement (HTTP)", () => {
  it("preflight with allowed origin returns 204 and echoes the origin", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://app.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    const response = await fetch(`${app.httpUrl}/objects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "GET",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("preflight with disallowed origin returns 403 with auth.forbidden envelope", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://app.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    const response = await fetch(`${app.httpUrl}/objects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });
    const body = (await response.json()) as { error: unknown; code: string };

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.code).toBe("auth.forbidden");
    expect(body.error).toMatchObject({
      code: "auth.forbidden",
      details: { reason: "originNotAllowed" },
    });
  });

  it("GET with allowed origin echoes origin header on the response", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://app.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    const response = await fetch(`${app.httpUrl}/health`, {
      headers: { origin: "https://app.example.com" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("GET with disallowed origin omits CORS headers (browser-side block)", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://app.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    const response = await fetch(`${app.httpUrl}/health`, {
      headers: { origin: "https://evil.example.com" },
    });

    // Server still serves the body; only Allow-Origin headers are missing.
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("GET with no Origin header always succeeds (same-origin / curl)", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://app.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    const response = await fetch(`${app.httpUrl}/health`);
    expect(response.status).toBe(200);
    // Same-origin: no Allow-Origin header needed.
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("dev mode defaults to wildcard and accepts any origin", async () => {
    app = await startServer();

    const preflight = await fetch(`${app.httpUrl}/objects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://anything.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    const get = await fetch(`${app.httpUrl}/health`, {
      headers: { origin: "https://anything.example.com" },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("production with explicit allowlist accepts listed origins and rejects others", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://app.example.com", "https://admin.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    const okAdmin = await fetch(`${app.httpUrl}/health`, {
      headers: { origin: "https://admin.example.com" },
    });
    expect(okAdmin.headers.get("access-control-allow-origin")).toBe(
      "https://admin.example.com",
    );

    const badPreflight = await fetch(`${app.httpUrl}/objects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://other.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(badPreflight.status).toBe(403);
  });

  it("subdomain wildcard allowlist reflects matching subdomains and rejects others", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://*.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    // A matching subdomain is reflected (not the wildcard string) with Vary.
    const okTenant = await fetch(`${app.httpUrl}/health`, {
      headers: { origin: "https://tenant42.example.com" },
    });
    expect(okTenant.headers.get("access-control-allow-origin")).toBe(
      "https://tenant42.example.com",
    );
    expect(okTenant.headers.get("vary")).toBe("Origin");

    // Preflight for a matching subdomain succeeds.
    const okPreflight = await fetch(`${app.httpUrl}/objects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(okPreflight.status).toBe(204);
    expect(okPreflight.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );

    // The apex host is NOT covered by the wildcard.
    const apexPreflight = await fetch(`${app.httpUrl}/objects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(apexPreflight.status).toBe(403);

    // A lookalike domain is rejected.
    const evilPreflight = await fetch(`${app.httpUrl}/objects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.notexample.com",
        "access-control-request-method": "GET",
      },
    });
    expect(evilPreflight.status).toBe(403);
  });
});

describe("CORS enforcement (WebSocket upgrade)", () => {
  it("accepts upgrade from an allowed origin", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://app.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    const socket = new WebSocket(app.url, {
      headers: { origin: "https://app.example.com" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.close();
  });

  it("rejects upgrade from a disallowed origin with 403", async () => {
    app = await startServer({
      config: {
        env: "production",
        allowedOrigins: ["https://app.example.com"],
        dbPath: tmpDbPath(),
        inspectionEnabled: false,
      },
    });

    const socket = new WebSocket(app.url, {
      headers: { origin: "https://evil.example.com" },
    });
    const result = await new Promise<{ ok: false; status: number | undefined; message: string }>(
      (resolve) => {
        socket.once("open", () => {
          socket.close();
          resolve({ ok: false, status: undefined, message: "unexpected open" });
        });
        socket.once("unexpected-response", (_req, res) => {
          resolve({ ok: false, status: res.statusCode, message: res.statusMessage ?? "" });
          res.resume();
        });
        socket.once("error", (err) => {
          resolve({ ok: false, status: undefined, message: err.message });
        });
      },
    );

    expect(result.status).toBe(403);
  });
});

async function startServer(
  options: Parameters<typeof createFrickServer>[0] = {},
) {
  // Only default dbPath to ":memory:" when the caller hasn't picked their own
  // (production config rejects ":memory:" so prod-mode tests pass a tmp file).
  const baseDbPath = options.dbPath ?? (options.config?.env === "production" ? undefined : ":memory:");
  const server = createFrickServer({ port: 0, ...options, ...(baseDbPath ? { dbPath: baseDbPath } : {}) });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/_frick/sync`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}

function tmpDbPath(): string {
  // Production config rejects ":memory:" — use a unique file path under the
  // OS tmp dir. The server creates the file on first write; we leave cleanup
  // to OS tmp eviction (these are tiny SQLite files).
  const rand = Math.random().toString(36).slice(2);
  return `/tmp/frick-cors-test-${process.pid}-${rand}.sqlite`;
}
