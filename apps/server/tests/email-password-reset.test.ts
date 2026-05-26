import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, validateSchema, type FrickSchema } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";

/// Reset flow tests reuse the framework's email provider with a fake
/// `onPasswordResetRequested` hook so we can capture the issued token
/// without standing up a real email adapter.

function schemaWithUser(): FrickSchema {
  const next = structuredClone(foundationSchema);
  next.hash = `${next.hash}-reset-test`;
  next.objects.push({
    id: 99,
    name: "User",
    fields: [
      { id: 1, name: "displayName", kind: "string", required: true },
      { id: 2, name: "email", kind: "string", required: false },
      { id: 3, name: "appleSubject", kind: "string", required: false },
      { id: 4, name: "googleSubject", kind: "string", required: false },
      { id: 5, name: "createdAt", kind: "int", required: false },
      { id: 6, name: "revokedAt", kind: "int", required: false },
      { id: 7, name: "primaryTenantId", kind: "string", required: false },
    ],
    indexes: [{ id: 1, name: "byEmail", fields: ["email"] }],
  });
  return validateSchema(next);
}

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("password reset", () => {
  it("issues a token via /auth/email/forgot-password and resets via /auth/email/reset-password", async () => {
    const issued: { token?: string; userId?: string; expiresAt?: string } = {};
    app = await startServer({
      schema: schemaWithUser(),
      hook: (event) => {
        issued.token = event.token;
        issued.userId = event.userId;
        issued.expiresAt = event.expiresAt;
      },
    });

    // 1. Sign up so there's a user to reset.
    const signup = await fetch(`${app.httpUrl}/auth/email/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "ada@example.com",
        password: "correct-horse-battery-staple",
        displayName: "Ada",
      }),
    });
    expect(signup.status).toBe(200);

    // 2. Request the reset.
    const request = await fetch(`${app.httpUrl}/auth/email/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    expect(request.status).toBe(200);
    expect(issued.token).toBeTruthy();
    expect(issued.userId).toBeTruthy();

    // 3. Submit the new password.
    const confirm = await fetch(`${app.httpUrl}/auth/email/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: issued.token,
        password: "new-correct-horse",
      }),
    });
    expect(confirm.status).toBe(200);

    // 4. Old password no longer works.
    const oldLogin = await fetch(`${app.httpUrl}/auth/email/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "correct-horse-battery-staple" }),
    });
    expect(oldLogin.status).toBeGreaterThanOrEqual(400);

    // 5. New password does.
    const newLogin = await fetch(`${app.httpUrl}/auth/email/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "new-correct-horse" }),
    });
    expect(newLogin.status).toBe(200);
  });

  it("does not leak whether the email is on file (always 200)", async () => {
    const issued: { token?: string } = {};
    app = await startServer({
      schema: schemaWithUser(),
      hook: (event) => {
        issued.token = event.token;
      },
    });

    const response = await fetch(`${app.httpUrl}/auth/email/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(response.status).toBe(200);
    expect(issued.token).toBeUndefined();
  });

  it("rejects a second use of the same token", async () => {
    const issued: { token?: string } = {};
    app = await startServer({
      schema: schemaWithUser(),
      hook: (event) => {
        issued.token = event.token;
      },
    });

    await fetch(`${app.httpUrl}/auth/email/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "ada@example.com",
        password: "correct-horse-battery-staple",
        displayName: "Ada",
      }),
    });
    await fetch(`${app.httpUrl}/auth/email/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });

    const first = await fetch(`${app.httpUrl}/auth/email/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.token, password: "new-pass-1" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${app.httpUrl}/auth/email/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.token, password: "new-pass-2" }),
    });
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("invalid_or_expired_token");
  });

  it("rejects passwords below the minimum length", async () => {
    app = await startServer({
      schema: schemaWithUser(),
      hook: () => {},
    });

    const response = await fetch(`${app.httpUrl}/auth/email/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "anything", password: "short" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("password_too_short");
  });
});

async function startServer(options: {
  schema?: FrickSchema;
  hook: (event: {
    token: string;
    userId: string;
    tenantId: string;
    email: string;
    expiresAt: string;
  }) => Promise<void> | void;
}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...(options.schema ? { schema: options.schema } : {}),
    identityProviders: {
      email: {
        onPasswordResetRequested: options.hook,
      },
    },
  });
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
