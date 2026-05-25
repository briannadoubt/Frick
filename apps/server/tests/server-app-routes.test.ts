import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrickServer, type FrickAppRoute } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("ServerOptions.appRoutes", () => {
  it("routes a matching request to the app route handler", async () => {
    app = await startServer({
      appRoutes: [
        {
          pathPrefix: "/custom",
          async handle(_req, res) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return true;
          },
        },
      ],
    });

    const response = await fetch(`${app.httpUrl}/custom/foo`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
  });

  it("falls through to Frick's 404 when route returns false", async () => {
    app = await startServer({
      appRoutes: [
        {
          pathPrefix: "/skip",
          handle() {
            return false;
          },
        },
      ],
    });

    const response = await fetch(`${app.httpUrl}/skip/foo`);
    expect(response.status).toBe(404);
  });

  it("returns 500 with structured log when app route handler throws", async () => {
    const errorSpy = vi.fn();
    app = await startServer({
      appRoutes: [
        {
          pathPrefix: "/throws",
          handle() {
            throw new Error("route explosion");
          },
        },
      ],
      loggerOverride: { error: errorSpy },
    });

    const response = await fetch(`${app.httpUrl}/throws`);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("internal_error");
    expect(errorSpy).toHaveBeenCalledWith(
      "frick.app_route.handle_failed",
      expect.objectContaining({ pathPrefix: "/throws", error: "route explosion" }),
    );
  });

  it("respects method filter — non-matching method falls through", async () => {
    app = await startServer({
      appRoutes: [
        {
          pathPrefix: "/method-test",
          method: "POST",
          async handle(_req, res) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ matched: true }));
            return true;
          },
        },
      ],
    });

    const get = await fetch(`${app.httpUrl}/method-test`);
    expect(get.status).toBe(404);

    const post = await fetch(`${app.httpUrl}/method-test`, { method: "POST" });
    expect(post.status).toBe(200);
    expect((await post.json()).matched).toBe(true);
  });

  it("earlier registration wins over a later less-specific prefix", async () => {
    app = await startServer({
      appRoutes: [
        {
          pathPrefix: "/api/specific",
          async handle(_req, res) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ route: "specific" }));
            return true;
          },
        },
        {
          pathPrefix: "/api",
          async handle(_req, res) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ route: "generic" }));
            return true;
          },
        },
      ],
    });

    const specific = await fetch(`${app.httpUrl}/api/specific/foo`);
    expect((await specific.json()).route).toBe("specific");

    const generic = await fetch(`${app.httpUrl}/api/other`);
    expect((await generic.json()).route).toBe("generic");
  });

  it("does not claim requests for unrelated paths", async () => {
    app = await startServer({
      appRoutes: [
        {
          pathPrefix: "/only-this",
          async handle(_req, res) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return true;
          },
        },
      ],
    });

    const unrelated = await fetch(`${app.httpUrl}/health`);
    expect(unrelated.status).toBe(200);
    expect((await unrelated.json()).service).toBe("frick-server");
  });
});

interface StartOptions {
  appRoutes?: readonly FrickAppRoute[];
  loggerOverride?: Partial<{
    error: (event: string, fields: Record<string, unknown>) => void;
  }>;
}

async function startServer(opts: StartOptions = {}) {
  const logger = opts.loggerOverride
    ? {
        info: () => {},
        warn: () => {},
        debug: () => {},
        child: () => logger,
        error: opts.loggerOverride.error ?? (() => {}),
      }
    : undefined;

  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...(opts.appRoutes !== undefined ? { appRoutes: opts.appRoutes } : {}),
    ...(logger !== undefined ? { logger: logger as Parameters<typeof createFrickServer>[0]["logger"] } : {}),
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}
