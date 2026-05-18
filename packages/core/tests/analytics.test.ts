import { afterEach, describe, expect, test, vi } from "vitest";
import { foundationSchema } from "@frick/protocol";
import { FrickClient, installBrowserAnalyticsTracking, trackAnalyticsEvent } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackAnalyticsEvent", () => {
  test("posts product analytics events with bearer auth", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const responseBody = {
      ok: true,
      eventId: "platform-event-1",
      sequence: 7,
      acceptedAt: "2026-05-17T12:00:01.000Z",
      duplicate: false,
    };
    const fetchImpl = async (input: URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      return new Response(JSON.stringify(responseBody), { status: 202 });
    };

    await expect(
      trackAnalyticsEvent({
        httpEndpoint: "http://127.0.0.1:4099/",
        sessionToken: "session-token-123",
        name: "screen.viewed",
        properties: { screen: "Home" },
        context: { path: "/" },
        traceId: "trace-1",
        idempotencyKey: "event-1",
        occurredAt: new Date("2026-05-17T12:00:00.000Z"),
        fetchImpl,
      }),
    ).resolves.toEqual(responseBody);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4099/analytics/events");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headersObject(calls[0]?.init?.headers)).toEqual({
      accept: "application/json",
      authorization: "Bearer session-token-123",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "screen.viewed",
      properties: { screen: "Home" },
      context: { path: "/" },
      traceId: "trace-1",
      idempotencyKey: "event-1",
      occurredAt: "2026-05-17T12:00:00.000Z",
    });
  });

  test("surfaces server analytics validation messages", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "sync.protocolError",
            message: "occurredAt must be a canonical ISO timestamp string",
          },
        }),
        { status: 400 },
      );

    await expect(
      trackAnalyticsEvent({
        httpEndpoint: "http://127.0.0.1:4099/",
        sessionToken: "session-token-123",
        name: "screen.viewed",
        occurredAt: "05/17/2026",
        fetchImpl,
      }),
    ).rejects.toThrow("occurredAt must be a canonical ISO timestamp string");
  });
});

describe("FrickClient.track", () => {
  test("uses the configured HTTP endpoint and current session token", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      return new Response(
        JSON.stringify({
          ok: true,
          eventId: "platform-event-2",
          sequence: 8,
          acceptedAt: "2026-05-17T12:00:02.000Z",
          duplicate: false,
        }),
        { status: 202 },
      );
    });
    const client = new FrickClient({
      endpoint: "ws://unused/_frick/sync",
      httpEndpoint: "https://api.example.test/frick",
      schema: foundationSchema,
      session: {
        schemaHash: foundationSchema.hash,
        sessionToken: "session-token-client",
        tenantId: "tenant-a",
        userId: "user-ada",
        deviceId: "device-web",
        replicaId: "replica-web",
        expiresAt: "2026-05-17T13:00:00.000Z",
      },
    });

    await expect(client.track("button.clicked", { label: "Save" })).resolves.toMatchObject({
      eventId: "platform-event-2",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/frick/analytics/events");
    expect(headersObject(calls[0]?.init?.headers).authorization).toBe("Bearer session-token-client");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "button.clicked",
      properties: { label: "Save" },
    });
  });
});

describe("installBrowserAnalyticsTracking", () => {
  test("tracks the initial route and subsequent history changes once per route", async () => {
    const calls: Array<{ name: string; properties?: Record<string, unknown> }> = [];
    const client = {
      track: vi.fn(async (name: string, properties?: Record<string, unknown>) => {
        calls.push({ name, properties });
        return {
          ok: true as const,
          eventId: `event-${calls.length}`,
          sequence: calls.length,
          acceptedAt: "2026-05-17T12:00:00.000Z",
          duplicate: false,
        };
      }),
    };
    const browser = new FakeBrowserWindow("https://app.example.test/");

    const tracker = installBrowserAnalyticsTracking(client, { window: browser });
    await tracker.flush();
    browser.history.pushState({}, "", "/settings?tab=billing#plans");
    browser.history.pushState({}, "", "/settings?tab=billing#plans");
    await tracker.flush();

    expect(calls).toEqual([
      {
        name: "screen.viewed",
        properties: {
          path: "/",
          search: "",
          hash: "",
          url: "https://app.example.test/",
          title: "Frick Test App",
        },
      },
      {
        name: "screen.viewed",
        properties: {
          path: "/settings",
          search: "?tab=billing",
          hash: "#plans",
          url: "https://app.example.test/settings?tab=billing#plans",
          title: "Frick Test App",
        },
      },
    ]);
  });

  test("stops tracking after dispose", async () => {
    const client = {
      track: vi.fn(async () => ({
        ok: true as const,
        eventId: "event-1",
        sequence: 1,
        acceptedAt: "2026-05-17T12:00:00.000Z",
        duplicate: false,
      })),
    };
    const browser = new FakeBrowserWindow("https://app.example.test/");
    const tracker = installBrowserAnalyticsTracking(client, { window: browser });
    await tracker.flush();

    tracker.dispose();
    browser.history.pushState({}, "", "/after-dispose");
    await tracker.flush();

    expect(client.track).toHaveBeenCalledTimes(1);
  });

  test("keeps history patched until every tracker is disposed", async () => {
    const first = trackingClient();
    const second = trackingClient();
    const browser = new FakeBrowserWindow("https://app.example.test/");
    const originalPushState = browser.history.pushState;

    const firstTracker = installBrowserAnalyticsTracking(first, { window: browser });
    const secondTracker = installBrowserAnalyticsTracking(second, { window: browser });
    await firstTracker.flush();
    await secondTracker.flush();

    firstTracker.dispose();
    browser.history.pushState({}, "", "/still-tracked");
    await secondTracker.flush();

    expect(first.track).toHaveBeenCalledTimes(1);
    expect(second.track).toHaveBeenCalledTimes(2);

    secondTracker.dispose();
    expect(browser.history.pushState).toBe(originalPushState);
  });
});

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

class FakeBrowserWindow {
  readonly document = {
    title: "Frick Test App",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  readonly listeners = new Map<string, Set<() => void>>();
  location: URL;
  history: {
    pushState: (_state: unknown, _unused: string, url?: string | URL | null) => void;
    replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => void;
  };

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

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  private setUrl(url?: string | URL | null): void {
    if (url === undefined || url === null) return;
    this.location = new URL(url, this.location.href);
  }
}

function trackingClient() {
  return {
    track: vi.fn(async () => ({
      ok: true as const,
      eventId: "event-1",
      sequence: 1,
      acceptedAt: "2026-05-17T12:00:00.000Z",
      duplicate: false,
    })),
  };
}
