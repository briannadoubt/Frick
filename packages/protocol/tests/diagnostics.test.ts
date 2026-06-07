/**
 * FR-76: diagnostics snapshot data model helpers.
 */
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_VERSION,
  REDACTED_DIAGNOSTICS_VALUE,
  redactDiagnosticsContext,
} from "../src/diagnostics.js";

describe("redactDiagnosticsContext", () => {
  it("masks secret-looking keys and leaves the rest intact", () => {
    const out = redactDiagnosticsContext({
      userId: "user-ada",
      password: "hunter2",
      sessionToken: "tok_live_xxx",
      api_key: "sk-1",
      authorization: "Bearer z",
      cookie: "sid=1",
      credential: "c",
      path: "/safe",
    });
    expect(out?.userId).toBe("user-ada");
    expect(out?.path).toBe("/safe");
    expect(out?.password).toBe(REDACTED_DIAGNOSTICS_VALUE);
    expect(out?.sessionToken).toBe(REDACTED_DIAGNOSTICS_VALUE);
    expect(out?.api_key).toBe(REDACTED_DIAGNOSTICS_VALUE);
    expect(out?.authorization).toBe(REDACTED_DIAGNOSTICS_VALUE);
    expect(out?.cookie).toBe(REDACTED_DIAGNOSTICS_VALUE);
    expect(out?.credential).toBe(REDACTED_DIAGNOSTICS_VALUE);
  });

  it("does not mutate the input", () => {
    const input = { secret: "s", ok: 1 };
    const out = redactDiagnosticsContext(input);
    expect(input.secret).toBe("s");
    expect(out).not.toBe(input);
  });

  it("returns undefined for undefined input", () => {
    expect(redactDiagnosticsContext(undefined)).toBeUndefined();
  });
});

describe("DIAGNOSTICS_VERSION", () => {
  it("is the current snapshot version", () => {
    expect(DIAGNOSTICS_VERSION).toBe(1);
  });
});
