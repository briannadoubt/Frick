import { describe, expect, test } from "vitest";
import { resolveInitialTheme } from "./theme.js";

describe("resolveInitialTheme", () => {
  test("uses a stored explicit theme before system preference", () => {
    expect(resolveInitialTheme("dark", false)).toBe("dark");
    expect(resolveInitialTheme("light", true)).toBe("light");
  });

  test("falls back to system dark preference when no stored theme exists", () => {
    expect(resolveInitialTheme(null, true)).toBe("dark");
    expect(resolveInitialTheme(null, false)).toBe("light");
  });

  test("ignores unrecognized stored theme values", () => {
    expect(resolveInitialTheme("solarized", true)).toBe("dark");
  });
});
