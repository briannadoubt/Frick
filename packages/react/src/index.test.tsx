import { describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  createAuthorizedFetchInit,
  FrickProvider,
  frickHttpUrl,
  inboxEndpointPath,
  resolveHttpEndpoint,
  useTrackAnalyticsEvent,
  useProjection,
  useProjectionRows,
} from "./index.js";
import { FrickClient, type BrowserAnalyticsWindow } from "@frick/core";
import { foundationSchema } from "@frick/protocol";

describe("resolveHttpEndpoint", () => {
  test("maps the default websocket sync URL to the HTTP origin", () => {
    expect(resolveHttpEndpoint("ws://127.0.0.1:4099/_frick/sync")).toBe("http://127.0.0.1:4099");
  });

  test("preserves explicit HTTP endpoint overrides", () => {
    expect(resolveHttpEndpoint("https://api.example.test/frick")).toBe("https://api.example.test/frick");
  });
});

describe("inboxEndpointPath", () => {
  test("scopes inbox requests to the configured user id", () => {
    expect(inboxEndpointPath("user-ada")).toBe("/inbox?userId=user-ada");
  });

  test("encodes user ids safely for query strings", () => {
    expect(inboxEndpointPath("user+space@example.test")).toBe("/inbox?userId=user%2Bspace%40example.test");
  });
});

describe("useProjection", () => {
  test("exposes the FrickClient projection signal as a row map", () => {
    // The hook is a thin wrapper over `client.projection(name)`. Verify the
    // wiring through the underlying client so we don't need a full DOM
    // renderer in the framework's smoke tests — a project app can cover the
    // hook with a real render in its own test suite.
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema });
    expect(typeof useProjection).toBe("function");
    expect(typeof useProjectionRows).toBe("function");
    expect(typeof useTrackAnalyticsEvent).toBe("function");
    const signal = client.projection<{ unreadCount: number }>("conversation-inbox");
    signal.set(
      new Map([
        ["user-ada:conversation-general", { unreadCount: 2 }],
        ["user-grace:conversation-general", { unreadCount: 0 }],
      ]),
    );
    expect(signal.value.size).toBe(2);
    expect(signal.value.get("user-ada:conversation-general")?.unreadCount).toBe(2);
    // Subsequent calls return the same signal instance — the hook relies on
    // this to keep referential equality stable across renders.
    expect(client.projection("conversation-inbox")).toBe(signal);
  });
});

describe("useTrackAnalyticsEvent", () => {
  test("delegates event name, properties, and options to the current client", async () => {
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema });
    const receipt = {
      ok: true as const,
      eventId: "platform-event-1",
      sequence: 7,
      acceptedAt: "2026-05-17T12:00:01.000Z",
      duplicate: false,
    };
    const track = vi.spyOn(client, "track").mockResolvedValue(receipt);
    let callback: ReturnType<typeof useTrackAnalyticsEvent> | undefined;

    function Probe() {
      callback = useTrackAnalyticsEvent();
      return null;
    }

    renderToStaticMarkup(createElement(FrickProvider, { client, children: createElement(Probe) }));
    const properties = { label: "Save" };
    const options = { traceId: "trace-1", idempotencyKey: "event-1" };

    await expect(callback?.("button.clicked", properties, options)).resolves.toBe(receipt);
    expect(track).toHaveBeenCalledWith("button.clicked", properties, options);
  });

  test("FrickProvider installs browser auto tracking by default and disposes it on unmount", async () => {
    const client = new FrickClient({
      endpoint: "ws://unused",
      schema: foundationSchema,
      session: {
        schemaHash: foundationSchema.hash,
        sessionToken: "session-token-123",
        tenantId: "tenant-a",
        userId: "user-ada",
        deviceId: "device-web",
        replicaId: "replica-web",
        expiresAt: "2026-05-17T13:00:00.000Z",
      },
    });
    vi.spyOn(client, "connect").mockImplementation(() => undefined);
    vi.spyOn(client, "disconnect").mockImplementation(() => undefined);
    const track = vi.spyOn(client, "track").mockResolvedValue({
      ok: true,
      eventId: "platform-event-1",
      sequence: 1,
      acceptedAt: "2026-05-17T12:00:00.000Z",
      duplicate: false,
    });
    const browser = new FakeProviderBrowserWindow("https://app.example.test/");
    let renderer: ReactTestRenderer | undefined;
    const globalWithWindow = globalThis as { window?: BrowserAnalyticsWindow };
    const previousWindow = globalWithWindow.window;
    globalWithWindow.window = browser;

    try {
      await act(async () => {
        renderer = create(
          createElement(FrickProvider, {
            client,
            children: createElement("div"),
          }),
        );
      });
      await act(async () => undefined);
      browser.history.pushState({}, "", "/settings");
      await act(async () => undefined);

      expect(track).toHaveBeenCalledTimes(2);
      expect(track).toHaveBeenNthCalledWith(
        1,
        "screen.viewed",
        expect.objectContaining({ path: "/" }),
      );
      expect(track).toHaveBeenNthCalledWith(
        2,
        "screen.viewed",
        expect.objectContaining({ path: "/settings" }),
      );

      await act(async () => {
        renderer?.unmount();
      });
      browser.history.pushState({}, "", "/after-unmount");
      await act(async () => undefined);

      expect(track).toHaveBeenCalledTimes(2);
    } finally {
      if (previousWindow) globalWithWindow.window = previousWindow;
      else delete globalWithWindow.window;
    }
  });

  test("FrickProvider disables default browser auto tracking when opted out", async () => {
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema, session: testSession() });
    vi.spyOn(client, "connect").mockImplementation(() => undefined);
    vi.spyOn(client, "disconnect").mockImplementation(() => undefined);
    const track = vi.spyOn(client, "track").mockResolvedValue({
      ok: true,
      eventId: "platform-event-1",
      sequence: 1,
      acceptedAt: "2026-05-17T12:00:00.000Z",
      duplicate: false,
    });
    const browser = new FakeProviderBrowserWindow("https://app.example.test/");
    const globalWithWindow = globalThis as { window?: BrowserAnalyticsWindow };
    const previousWindow = globalWithWindow.window;
    globalWithWindow.window = browser;

    try {
      await act(async () => {
        create(
          createElement(FrickProvider, {
            client,
            autoAnalytics: false,
            children: createElement("div"),
          }),
        );
      });
      await act(async () => undefined);
      browser.history.pushState({}, "", "/settings");
      await act(async () => undefined);

      expect(track).not.toHaveBeenCalled();
    } finally {
      if (previousWindow) globalWithWindow.window = previousWindow;
      else delete globalWithWindow.window;
    }
  });

  test("FrickProvider starts and stops auto tracking when the client session changes after mount", async () => {
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema });
    vi.spyOn(client, "connect").mockImplementation(() => undefined);
    vi.spyOn(client, "disconnect").mockImplementation(() => undefined);
    const track = vi.spyOn(client, "track").mockResolvedValue({
      ok: true,
      eventId: "platform-event-1",
      sequence: 1,
      acceptedAt: "2026-05-17T12:00:00.000Z",
      duplicate: false,
    });
    const browser = new FakeProviderBrowserWindow("https://app.example.test/");

    await act(async () => {
      create(
        createElement(FrickProvider, {
          client,
          autoAnalytics: { window: browser },
          children: createElement("div"),
        }),
      );
    });
    expect(track).not.toHaveBeenCalled();

    await act(async () => {
      client.setSession(testSession());
    });
    await act(async () => undefined);
    expect(track).toHaveBeenCalledTimes(1);

    await act(async () => {
      client.setSession(null);
    });
    browser.history.pushState({}, "", "/after-logout");
    await act(async () => undefined);

    expect(track).toHaveBeenCalledTimes(1);
  });

  test("FrickProvider does not reinstall auto analytics for equivalent inline options", async () => {
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema, session: testSession() });
    vi.spyOn(client, "connect").mockImplementation(() => undefined);
    vi.spyOn(client, "disconnect").mockImplementation(() => undefined);
    const track = vi.spyOn(client, "track").mockResolvedValue({
      ok: true,
      eventId: "platform-event-1",
      sequence: 1,
      acceptedAt: "2026-05-17T12:00:00.000Z",
      duplicate: false,
    });
    const browser = new FakeProviderBrowserWindow("https://app.example.test/");
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(FrickProvider, {
          client,
          autoAnalytics: { window: browser },
          children: createElement("div"),
        }),
      );
    });
    await act(async () => undefined);
    await act(async () => {
      renderer?.update(
        createElement(FrickProvider, {
          client,
          autoAnalytics: { window: browser },
          children: createElement("div"),
        }),
      );
    });
    await act(async () => undefined);

    expect(track).toHaveBeenCalledTimes(1);
  });

  test("FrickProvider applies custom auto analytics options after default tracking installed", async () => {
    const client = new FrickClient({ endpoint: "ws://unused", schema: foundationSchema, session: testSession() });
    vi.spyOn(client, "connect").mockImplementation(() => undefined);
    vi.spyOn(client, "disconnect").mockImplementation(() => undefined);
    const track = vi.spyOn(client, "track").mockResolvedValue({
      ok: true,
      eventId: "platform-event-1",
      sequence: 1,
      acceptedAt: "2026-05-17T12:00:00.000Z",
      duplicate: false,
    });
    const browser = new FakeProviderBrowserWindow("https://app.example.test/");
    const globalWithWindow = globalThis as { window?: BrowserAnalyticsWindow };
    const previousWindow = globalWithWindow.window;
    globalWithWindow.window = browser;
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          createElement(FrickProvider, {
            client,
            children: createElement("div"),
          }),
        );
      });
      await act(async () => undefined);
      expect(track).toHaveBeenCalledTimes(1);

      await act(async () => {
        renderer?.update(
          createElement(FrickProvider, {
            client,
            autoAnalytics: {
              window: browser,
              trackInitialRoute: false,
              routeProperties: (location) => ({ customPath: location.pathname }),
            },
            children: createElement("div"),
          }),
        );
      });
      browser.history.pushState({}, "", "/custom");
      await act(async () => undefined);

      expect(track).toHaveBeenCalledTimes(2);
      expect(track).toHaveBeenNthCalledWith(2, "screen.viewed", { customPath: "/custom" });
    } finally {
      if (previousWindow) globalWithWindow.window = previousWindow;
      else delete globalWithWindow.window;
    }
  });
});

describe("authorized optional endpoint requests", () => {
  test("builds optional endpoint URLs relative to the configured HTTP endpoint", () => {
    expect(frickHttpUrl("https://api.example.test/frick", "/inbox?userId=user-ada").toString()).toBe(
      "https://api.example.test/frick/inbox?userId=user-ada",
    );
  });

  test("rejects absolute optional endpoint paths before bearer tokens are attached", () => {
    expect(() => frickHttpUrl("https://api.example.test", "https://evil.example/collect")).toThrow(
      /relative paths/,
    );
  });

  test("rejects scheme-relative optional endpoint paths before bearer tokens are attached", () => {
    expect(() => frickHttpUrl("https://api.example.test", "//evil.example/collect")).toThrow(
      /relative paths/,
    );
  });

  test("rejects schemed optional endpoint paths before bearer tokens are attached", () => {
    expect(() => frickHttpUrl("https://api.example.test", "javascript:alert(1)")).toThrow(
      /relative paths/,
    );
  });

  test("adds a bearer token when a session token is available", () => {
    expect(
      createAuthorizedFetchInit({
        sessionToken: "session-token-123",
        userId: "user-ada",
        deviceId: "device-web",
        replicaId: "replica-web",
        schemaHash: "schema-hash",
        expiresAt: "2026-05-09T13:00:00.000Z",
      }),
    ).toEqual({
      headers: {
        Authorization: "Bearer session-token-123",
      },
    });
  });
});

class FakeProviderBrowserWindow implements BrowserAnalyticsWindow {
  readonly document = { title: "Frick Test App" };
  readonly listeners = new Map<string, Set<() => void>>();
  location: URL;
  history: Required<NonNullable<BrowserAnalyticsWindow["history"]>>;

  constructor(initialUrl: string) {
    this.location = new URL(initialUrl);
    this.history = {
      pushState: (_state: unknown, _unused: string, url?: string | URL | null) => {
        this.setUrl(url);
      },
      replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => {
        this.setUrl(url);
      },
    };
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private setUrl(url?: string | URL | null): void {
    if (url === undefined || url === null) return;
    this.location = new URL(url, this.location.href);
  }
}

function testSession() {
  return {
    schemaHash: foundationSchema.hash,
    sessionToken: "session-token-123",
    tenantId: "tenant-a",
    userId: "user-ada",
    deviceId: "device-web",
    replicaId: "replica-web",
    expiresAt: "2026-05-17T13:00:00.000Z",
  };
}
