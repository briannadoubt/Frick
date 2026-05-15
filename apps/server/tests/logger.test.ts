import { describe, expect, it } from "vitest";
import { createConsoleLogger, createNoopLogger } from "../src/logger.js";

interface CapturedLine {
  stream: "out" | "err";
  parsed: Record<string, unknown>;
}

function capture(level: "debug" | "info" | "warn" | "error") {
  const lines: CapturedLine[] = [];
  const logger = createConsoleLogger(
    { logLevel: level },
    {
      out: (line) => lines.push({ stream: "out", parsed: JSON.parse(line) }),
      err: (line) => lines.push({ stream: "err", parsed: JSON.parse(line) }),
    },
  );
  return { logger, lines };
}

describe("createConsoleLogger", () => {
  it("writes JSON-line records with timestamp, level, and message", () => {
    const { logger, lines } = capture("debug");
    logger.info("hello", { foo: "bar" });
    expect(lines).toHaveLength(1);
    expect(lines[0].stream).toBe("out");
    expect(lines[0].parsed).toMatchObject({ level: "info", msg: "hello", foo: "bar" });
    expect(typeof lines[0].parsed.ts).toBe("string");
  });

  it("routes warn and error to stderr; info and debug to stdout", () => {
    const { logger, lines } = capture("debug");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((l) => l.stream)).toEqual(["out", "out", "err", "err"]);
  });

  it("honors the log-level threshold", () => {
    const { logger, lines } = capture("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((l) => (l.parsed as { level: string }).level)).toEqual(["warn", "error"]);
  });

  it("redacts sensitive fields", () => {
    const { logger, lines } = capture("debug");
    logger.info("login", {
      userId: "user-ada",
      sessionToken: "secret-token",
      password: "hunter2",
      passwordHash: "0xdeadbeef",
    });
    expect(lines[0].parsed).toMatchObject({
      userId: "user-ada",
      sessionToken: "<redacted>",
      password: "<redacted>",
      passwordHash: "<redacted>",
    });
  });

  it("createNoopLogger discards everything", () => {
    const logger = createNoopLogger();
    expect(() => {
      logger.info("ignored", { secret: "value" });
      logger.error("ignored too");
    }).not.toThrow();
  });

  it("redacts Authorization-header field values", () => {
    const { logger, lines } = capture("debug");
    logger.info("req", { Authorization: "Bearer abc", authorization: "Bearer xyz" });
    expect(lines[0].parsed).toMatchObject({
      Authorization: "<redacted>",
      authorization: "<redacted>",
    });
  });

  it("redacts sensitive fields recursively while preserving safe nested primitives", () => {
    const { logger, lines } = capture("debug");
    logger.info("req", {
      userId: "user-ada",
      headers: {
        authorization: "Bearer nested",
        contentType: "application/json",
      },
      auth: {
        apiKey: "api-secret",
        passwordResetToken: "reset-secret",
        safeCount: 2,
      },
      flags: {
        enabled: true,
        retryAfterMs: 250,
      },
    });

    expect(lines[0].parsed).toMatchObject({
      userId: "user-ada",
      headers: {
        authorization: "<redacted>",
        contentType: "application/json",
      },
      auth: {
        apiKey: "<redacted>",
        passwordResetToken: "<redacted>",
        safeCount: 2,
      },
      flags: {
        enabled: true,
        retryAfterMs: 250,
      },
    });
  });

  it("redacts common secret key names inside arrays", () => {
    const { logger, lines } = capture("debug");
    logger.info("push", {
      credentials: [
        {
          publicKey: "public",
          privateKey: "private",
          clientSecret: "client-secret",
          access_token: "access-secret",
        },
      ],
    });

    expect(lines[0].parsed.credentials).toEqual([
      {
        publicKey: "public",
        privateKey: "<redacted>",
        clientSecret: "<redacted>",
        access_token: "<redacted>",
      },
    ]);
  });

  describe("child", () => {
    it("inherits parent fields on every emission", () => {
      const { logger, lines } = capture("debug");
      logger.child({ requestId: "r-1" }).info("hi", { foo: "bar" });
      expect(lines[0].parsed).toMatchObject({
        msg: "hi",
        requestId: "r-1",
        foo: "bar",
      });
    });

    it("cascades through nested children", () => {
      const { logger, lines } = capture("debug");
      logger.child({ a: 1 }).child({ b: 2 }).info("hi");
      expect(lines[0].parsed).toMatchObject({ msg: "hi", a: 1, b: 2 });
    });

    it("per-emission fields override inherited ones", () => {
      const { logger, lines } = capture("debug");
      logger.child({ status: 200 }).info("done", { status: 500 });
      expect((lines[0].parsed as { status: number }).status).toBe(500);
    });

    it("redacts inherited sensitive fields", () => {
      const { logger, lines } = capture("debug");
      logger.child({ password: "supersecret" }).info("nope");
      expect((lines[0].parsed as { password: string }).password).toBe("<redacted>");
    });

    it("createNoopLogger.child returns a no-op logger", () => {
      const logger = createNoopLogger();
      expect(() => {
        logger.child({ a: 1 }).info("hi");
      }).not.toThrow();
    });
  });
});
