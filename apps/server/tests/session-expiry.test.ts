import { afterEach, describe, expect, it } from "vitest";
import { isFrickErrorEnvelope } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("session expiry envelope", () => {
  it("returns 401 auth.sessionExpired for expired session tokens", async () => {
    app = await startServer({
      config: { env: "development", demoAuthEnabled: true, sessionTtlSeconds: -1 },
    });

    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    expect(login.status).toBe(200);
    const { sessionToken } = (await login.json()) as { sessionToken: string };

    const response = await fetch(`${app.httpUrl}/objects`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(isFrickErrorEnvelope(body.error)).toBe(true);
    expect(body.error.code).toBe("auth.sessionExpired");
    expect(body.error.details.reason).toBe("unauthenticated");
  });
});

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const server = createFrickServer({ port: 0, dbPath: ":memory:", ...options });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}
