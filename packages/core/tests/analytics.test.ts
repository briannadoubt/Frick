import { afterEach, describe, expect, test, vi } from "vitest";
import { foundationSchema } from "@frick/protocol";
import { FrickClient, trackAnalyticsEvent } from "../src/index.js";

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

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}
