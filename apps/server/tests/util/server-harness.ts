import type { FrickSchema } from "@frick/protocol";
import { createFrickServer } from "../../src/server.js";

/**
 * Minimal in-process test server harness shared by runtime tests that drive the
 * real HTTP/WebSocket surface. `streams-cursor.test.ts` (FR-116 stream cursor
 * query API) imports this; it was referenced before the file existed, so it is
 * provided here as test-only support (not shipped, not part of the public API).
 *
 * `startTestServer` boots a `createFrickServer` on an ephemeral port over an
 * in-memory SQLite DB and returns the resolved base URL plus a `close()` that
 * tears it down. `demoLogin` exercises the `/auth/dev-login` route and returns
 * the bearer session token, mirroring how the other runtime tests authenticate.
 */
export interface RunningServer {
  /** `http://127.0.0.1:<port>` for HTTP routes. */
  readonly baseUrl: string;
  /** `ws://127.0.0.1:<port>/_frick/sync` for the sync gateway. */
  readonly wsUrl: string;
  /** The underlying server's store, for direct seeding/assertions. */
  readonly store: ReturnType<typeof createFrickServer>["store"];
  close(): Promise<void>;
}

export async function startTestServer(schema: FrickSchema): Promise<RunningServer> {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", schema });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/_frick/sync`,
    store: server.store,
    close: server.close,
  };
}

export async function demoLogin(
  running: RunningServer,
  body: { userId: string; tenantId?: string },
): Promise<string> {
  const response = await fetch(`${running.baseUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.status || response.status >= 400) {
    throw new Error(`dev-login failed: ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as { sessionToken: string };
  return json.sessionToken;
}
