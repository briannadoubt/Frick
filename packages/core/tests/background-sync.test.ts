import { afterEach, describe, expect, test, vi } from "vitest";
import { registerFrickBackgroundSync } from "../src/background-sync.js";

describe("registerFrickBackgroundSync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("normalizes same-origin service-worker navigation messages", async () => {
    const harness = setupServiceWorkerHarness();
    const onNavigate = vi.fn();
    await registerFrickBackgroundSync({
      onFlush: vi.fn(),
      onNavigate,
    });

    harness.dispatch({ type: "frick:navigate", url: "/threads/general?from=push#latest" });
    harness.dispatch({ type: "frick:navigate", url: "threads/random" });

    expect(onNavigate).toHaveBeenNthCalledWith(1, "/threads/general?from=push#latest");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "/threads/random");
  });

  test("rejects off-origin and executable service-worker navigation messages", async () => {
    const harness = setupServiceWorkerHarness();
    const onNavigate = vi.fn();
    await registerFrickBackgroundSync({
      onFlush: vi.fn(),
      onNavigate,
    });

    for (const url of [
      "https://evil.example/path",
      "//evil.example/path",
      "javascript:alert(1)",
      "data:text/html,hello",
      "http://localhost.evil.example/path",
    ]) {
      harness.dispatch({ type: "frick:navigate", url });
    }

    expect(onNavigate).not.toHaveBeenCalled();
  });
});

function setupServiceWorkerHarness(): {
  dispatch(data: unknown): void;
} {
  let listener: ((event: MessageEvent) => void) | undefined;
  const registration = {
    unregister: vi.fn(async () => undefined),
  };
  const serviceWorker = {
    register: vi.fn(async () => registration),
    addEventListener: vi.fn((_event: string, handler: (event: MessageEvent) => void) => {
      listener = handler;
    }),
    removeEventListener: vi.fn(),
  };

  vi.stubGlobal("location", { origin: "https://app.example" });
  vi.stubGlobal("navigator", { serviceWorker });

  return {
    dispatch(data: unknown): void {
      if (!listener) throw new Error("listener was not registered");
      listener({ data } as MessageEvent);
    },
  };
}
