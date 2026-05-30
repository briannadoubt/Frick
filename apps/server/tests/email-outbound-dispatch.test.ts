/**
 * Framework-managed outbound email dispatch through the public adapter
 * surface (`identityProviders.email.outbound`).
 *
 * Covers, using the in-memory test sink:
 *   - `/auth/email/forgot-password` dispatches a templated reset email
 *     through the configured adapter when a `resetUrl` builder is set.
 *   - The reset send and the `onPasswordResetRequested` hook coexist.
 *   - Unknown emails never dispatch (the existence probe stays plugged).
 *   - `/auth/email/signup` dispatches the welcome email on first sign-in.
 *   - A throwing adapter does not fail the originating auth request.
 */
import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, validateSchema, type FrickSchema } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import { createFrickTestEmailAdapter, type FrickTestEmailAdapter } from "../src/email/test-adapter.js";
import type { EmailOutboundConfig } from "../src/auth/identity-routes.js";

function schemaWithUser(): FrickSchema {
  const next = structuredClone(foundationSchema);
  next.hash = `${next.hash}-outbound-test`;
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

async function signup(httpUrl: string, email = "ada@example.com"): Promise<Response> {
  return fetch(`${httpUrl}/auth/email/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple", displayName: "Ada" }),
  });
}

async function forgot(httpUrl: string, email = "ada@example.com"): Promise<Response> {
  return fetch(`${httpUrl}/auth/email/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

describe("framework-managed reset email dispatch", () => {
  it("dispatches a templated reset email through the configured adapter", async () => {
    const adapter = createFrickTestEmailAdapter();
    app = await startServer({
      schema: schemaWithUser(),
      outbound: {
        adapter,
        defaultFrom: "noreply@app.test",
        appName: "Frickle",
        resetUrl: ({ token }) => `https://app.test/reset?token=${token}`,
      },
    });

    expect((await signup(app.httpUrl)).status).toBe(200);
    expect((await forgot(app.httpUrl)).status).toBe(200);

    const sent = adapter.delivered.filter((d) => d.message.tags?.kind === "passwordReset");
    expect(sent).toHaveLength(1);
    const message = sent[0]!.message;
    expect(message.to).toBe("ada@example.com");
    expect(message.from).toBe("noreply@app.test");
    expect(message.subject).toBe("Reset your password for Frickle");
    // The minted single-use token is woven into the reset link.
    expect(message.text).toMatch(/https:\/\/app\.test\/reset\?token=.+/);
  });

  it("runs the outbound send and the onPasswordResetRequested hook together", async () => {
    const adapter = createFrickTestEmailAdapter();
    const hookTokens: string[] = [];
    app = await startServer({
      schema: schemaWithUser(),
      outbound: {
        adapter,
        defaultFrom: "noreply@app.test",
        resetUrl: ({ token }) => `https://app.test/reset?token=${token}`,
      },
      onPasswordResetRequested: (event) => {
        hookTokens.push(event.token);
      },
    });

    await signup(app.httpUrl);
    await forgot(app.httpUrl);

    const sent = adapter.delivered.filter((d) => d.message.tags?.kind === "passwordReset");
    expect(sent).toHaveLength(1);
    expect(hookTokens).toHaveLength(1);
    // Same token in both the dispatched link and the hook callback.
    expect(sent[0]!.message.text).toContain(hookTokens[0]!);
  });

  it("does not dispatch for an unknown email", async () => {
    const adapter = createFrickTestEmailAdapter();
    app = await startServer({
      schema: schemaWithUser(),
      outbound: {
        adapter,
        defaultFrom: "noreply@app.test",
        resetUrl: ({ token }) => `https://app.test/reset?token=${token}`,
      },
    });

    const res = await forgot(app.httpUrl, "nobody@example.com");
    expect(res.status).toBe(200);
    expect(adapter.delivered).toHaveLength(0);
  });

  it("does not dispatch when no resetUrl builder is configured", async () => {
    const adapter = createFrickTestEmailAdapter();
    app = await startServer({
      schema: schemaWithUser(),
      outbound: { adapter, defaultFrom: "noreply@app.test" },
    });

    await signup(app.httpUrl);
    const res = await forgot(app.httpUrl);
    expect(res.status).toBe(200);
    expect(adapter.delivered.filter((d) => d.message.tags?.kind === "passwordReset")).toHaveLength(0);
  });

  it("does not fail the request when the adapter throws", async () => {
    const throwingAdapter = {
      provider: "boom",
      async send(): Promise<never> {
        throw new Error("provider exploded");
      },
    };
    app = await startServer({
      schema: schemaWithUser(),
      outbound: {
        adapter: throwingAdapter,
        defaultFrom: "noreply@app.test",
        resetUrl: ({ token }) => `https://app.test/reset?token=${token}`,
      },
    });

    await signup(app.httpUrl);
    const res = await forgot(app.httpUrl);
    // The router converts the throw to a structured failure, so forgot still 200s.
    expect(res.status).toBe(200);
  });
});

describe("framework-managed welcome email dispatch", () => {
  it("dispatches a welcome email on first email signup", async () => {
    const adapter = createFrickTestEmailAdapter();
    app = await startServer({
      schema: schemaWithUser(),
      outbound: {
        adapter,
        defaultFrom: "noreply@app.test",
        appName: "Frickle",
        welcome: {},
      },
    });

    expect((await signup(app.httpUrl)).status).toBe(200);

    const welcome = adapter.delivered.filter((d) => d.message.tags?.kind === "welcome");
    expect(welcome).toHaveLength(1);
    expect(welcome[0]!.message.to).toBe("ada@example.com");
    expect(welcome[0]!.message.subject).toBe("Welcome to Frickle");
    expect(welcome[0]!.message.text).toContain("Ada");
  });

  it("honors a custom welcome body + subject builder", async () => {
    const adapter = createFrickTestEmailAdapter();
    app = await startServer({
      schema: schemaWithUser(),
      outbound: {
        adapter,
        defaultFrom: "noreply@app.test",
        welcome: {
          subject: "You're in!",
          body: ({ displayName }) => ({
            text: `Hi ${displayName}, enjoy.`,
            html: `<p>Hi ${displayName}, enjoy.</p>`,
          }),
        },
      },
    });

    await signup(app.httpUrl);
    const welcome = adapter.delivered.filter((d) => d.message.tags?.kind === "welcome")[0]!;
    expect(welcome.message.subject).toBe("You're in!");
    expect(welcome.message.text).toBe("Hi Ada, enjoy.");
    expect(welcome.message.html).toBe("<p>Hi Ada, enjoy.</p>");
  });

  it("does not dispatch a welcome email when welcome is not configured", async () => {
    const adapter = createFrickTestEmailAdapter();
    app = await startServer({
      schema: schemaWithUser(),
      outbound: { adapter, defaultFrom: "noreply@app.test" },
    });

    await signup(app.httpUrl);
    expect(adapter.delivered.filter((d) => d.message.tags?.kind === "welcome")).toHaveLength(0);
  });
});

async function startServer(options: {
  schema?: FrickSchema;
  outbound: EmailOutboundConfig;
  onPasswordResetRequested?: (event: {
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
        outbound: options.outbound,
        ...(options.onPasswordResetRequested
          ? { onPasswordResetRequested: options.onPasswordResetRequested }
          : {}),
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
    adapter: options.outbound.adapter as FrickTestEmailAdapter,
  };
}
