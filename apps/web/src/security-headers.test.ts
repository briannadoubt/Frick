import { describe, expect, test } from "vitest";
import { isDevEnvironment } from "./App.js";
import { buildWebSecurityHeaders, buildWebContentSecurityPolicy } from "./security-headers.js";

describe("web demo security headers", () => {
  test("serves a strict CSP for preview builds", () => {
    const csp = buildWebContentSecurityPolicy({
      command: "preview",
      demoHttpEndpoint: "https://demo.example.test",
      demoWsEndpoint: "wss://demo.example.test/_frick/sync",
    });

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://demo.example.test wss://demo.example.test");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test("keeps Vite development HMR working without relaxing preview CSP", () => {
    const csp = buildWebContentSecurityPolicy({
      command: "serve",
      demoHttpEndpoint: "http://127.0.0.1:4099",
      demoWsEndpoint: "ws://127.0.0.1:4099/_frick/sync",
    });

    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("ws://127.0.0.1:*");
    expect(csp).toContain("ws://localhost:*");
  });

  test("sets browser hardening headers alongside CSP", () => {
    const headers = buildWebSecurityHeaders({
      command: "preview",
      demoHttpEndpoint: "https://demo.example.test",
      demoWsEndpoint: "wss://demo.example.test/_frick/sync",
    });

    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["service-worker-allowed"]).toBe("/");
  });

  test("does not enable devtools just because a production preview runs on localhost", () => {
    expect(isDevEnvironment({ DEV: false })).toBe(false);
    expect(isDevEnvironment({ DEV: true })).toBe(true);
  });
});
