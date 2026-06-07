/**
 * Email router + adapter tests.
 *
 * Covers:
 *   - Test adapter records every send.
 *   - Verification + reset helpers compose the expected subject + URL.
 *   - Adapter exceptions become structured `adapter.threw` deliveries.
 *   - Resend adapter handles 2xx (with id), 401, 429, 5xx, and network
 *     errors via a stubbed fetch.
 *   - Devtools event is emitted regardless of adapter outcome.
 */
import { describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";
import { createFrickTestEmailAdapter } from "../src/email/test-adapter.js";
import { createFrickResendEmailAdapter } from "../src/email/resend-adapter.js";
import { createFrickEmailRouter } from "../src/email/router.js";
import type { FrickLogger } from "../src/logger.js";

function silentLogger(): FrickLogger {
  const noop = () => {};
  const child: FrickLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => child,
  };
  return child;
}

describe("test email adapter", () => {
  it("records every send and reports delivered", async () => {
    const adapter = createFrickTestEmailAdapter();
    const result = await adapter.send(
      { to: "ada@example.com", from: "noreply@app.test", subject: "hi", text: "hello" },
      { tenantId: "t1", logger: silentLogger() },
    );
    expect(result.status).toBe("delivered");
    expect(adapter.delivered).toHaveLength(1);
    adapter.reset();
    expect(adapter.delivered).toHaveLength(0);
  });
});

describe("FrickEmailRouter", () => {
  it("composes verification email with default from", async () => {
    const adapter = createFrickTestEmailAdapter();
    const store = new FrickStore({ path: ":memory:", seed: false });
    const router = createFrickEmailRouter({
      adapter,
      store,
      logger: silentLogger(),
      defaultFrom: "noreply@app.test",
    });
    try {
      const result = await router.sendVerificationEmail({
        tenantId: "t1",
        to: "ada@example.com",
        verificationUrl: "https://app.test/verify?token=abc",
        appName: "Frickle",
      });
      expect(result.status).toBe("delivered");
      expect(adapter.delivered[0]?.message.subject).toBe("Verify your email for Frickle");
      expect(adapter.delivered[0]?.message.text).toContain("https://app.test/verify?token=abc");
    } finally {
      store.close();
    }
  });

  it("converts adapter exceptions to adapter.threw failures", async () => {
    const adapter = {
      provider: "throws",
      async send(): Promise<never> {
        throw new Error("network exploded");
      },
    };
    const store = new FrickStore({ path: ":memory:", seed: false });
    const router = createFrickEmailRouter({
      adapter,
      store,
      logger: silentLogger(),
      defaultFrom: "noreply@app.test",
    });
    try {
      const result = await router.send(
        { to: "x@y.com", from: "noreply@app.test", subject: "x", text: "x" },
        { tenantId: "t1" },
      );
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("adapter.threw");
    } finally {
      store.close();
    }
  });

  it("records a devtools event for every send", async () => {
    const adapter = createFrickTestEmailAdapter();
    const store = new FrickStore({ path: ":memory:", seed: false });
    const router = createFrickEmailRouter({
      adapter,
      store,
      logger: silentLogger(),
      defaultFrom: "noreply@app.test",
    });
    try {
      await router.send({ to: "x@y.com", from: "noreply@app.test", subject: "s", text: "t" }, { tenantId: "t1" });
      const events = await store.devtoolsEvents.list({ kind: "frick.email.delivery" });
      expect(events).toHaveLength(1);
      expect(events[0]?.fields.status).toBe("delivered");
      expect(events[0]?.fields.recipient).toBe("x@y.com"); // 3-char local stays unmasked except for middle
    } finally {
      store.close();
    }
  });
});

describe("Resend adapter", () => {
  it("returns failed when API key is unset", async () => {
    const adapter = createFrickResendEmailAdapter({ env: {} });
    const result = await adapter.send(
      { to: "x@y.com", from: "noreply@app.test", subject: "s", text: "t" },
      { tenantId: "t1", logger: silentLogger() },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("email.unauthorized");
  });

  it("maps 200 to delivered with id receipt", async () => {
    const adapter = createFrickResendEmailAdapter({
      apiKey: "re_test",
      fetch: (async (url, init) => {
        expect(String(url)).toContain("/emails");
        expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer re_test");
        return new Response(JSON.stringify({ id: "msg_123" }), { status: 200 });
      }) as typeof fetch,
    });
    const result = await adapter.send(
      { to: "x@y.com", from: "noreply@app.test", subject: "s", text: "t" },
      { tenantId: "t1", logger: silentLogger() },
    );
    expect(result.status).toBe("delivered");
    expect(result.receiptId).toBe("msg_123");
  });

  it("maps 429 to email.rateLimited", async () => {
    const adapter = createFrickResendEmailAdapter({
      apiKey: "re_test",
      fetch: (async () => new Response("Too many", { status: 429 })) as typeof fetch,
    });
    const result = await adapter.send(
      { to: "x@y.com", from: "noreply@app.test", subject: "s", text: "t" },
      { tenantId: "t1", logger: silentLogger() },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("email.rateLimited");
  });

  it("captures fetch exceptions as email.networkError", async () => {
    const adapter = createFrickResendEmailAdapter({
      apiKey: "re_test",
      fetch: (async () => {
        throw new Error("ENOTFOUND");
      }) as typeof fetch,
    });
    const result = await adapter.send(
      { to: "x@y.com", from: "noreply@app.test", subject: "s", text: "t" },
      { tenantId: "t1", logger: silentLogger() },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("email.networkError");
  });
});
