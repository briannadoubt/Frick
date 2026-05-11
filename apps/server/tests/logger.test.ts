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
});
