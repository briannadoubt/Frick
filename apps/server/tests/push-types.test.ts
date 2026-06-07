/**
 * Stability tests for the notification intent type. The intent is what apps
 * persist and replay, so it has to survive a JSON round-trip without losing
 * fields the framework relies on.
 */

import { describe, expect, it } from "vitest";
import {
  isPushRevocationError,
  PUSH_REVOCATION_ERROR_CODES,
  type FrickNotificationIntent,
  type FrickPushAdapter,
  type FrickPushDelivery,
} from "../src/push/types.js";

describe("FrickNotificationIntent", () => {
  it("round-trips through JSON without losing fields", async () => {
    const intent: FrickNotificationIntent = {
      intent: "message.new",
      tenantId: "tenant-a",
      recipientUserIds: ["user-ada", "user-grace"],
      body: {
        title: "New message",
        body: "Hi from Ada",
        data: { conversationId: "conversation-foo", eventId: "evt-1" },
      },
      threadId: "thread-foo",
      deepLink: "frick://conversations/conversation-foo",
    };
    const decoded = JSON.parse(JSON.stringify(intent)) as FrickNotificationIntent;
    expect(decoded.intent).toBe(intent.intent);
    expect(decoded.tenantId).toBe(intent.tenantId);
    expect([...decoded.recipientUserIds]).toEqual([...intent.recipientUserIds]);
    expect(decoded.body.title).toBe(intent.body.title);
    expect(decoded.body.body).toBe(intent.body.body);
    expect(decoded.body.data?.conversationId).toBe("conversation-foo");
    expect(decoded.threadId).toBe(intent.threadId);
    expect(decoded.deepLink).toBe(intent.deepLink);
  });

  it("isPushRevocationError recognizes documented codes", async () => {
    for (const code of PUSH_REVOCATION_ERROR_CODES) {
      expect(isPushRevocationError(code)).toBe(true);
    }
    expect(isPushRevocationError("push.transient")).toBe(false);
    expect(isPushRevocationError(undefined)).toBe(false);
  });

  it("a minimal adapter satisfies the type contract", async () => {
    // Compile-time + run-time check: an adapter just needs platform + send.
    const recorded: FrickPushDelivery[] = [];
    const adapter: FrickPushAdapter = {
      platform: "test",
      async send(_intent, registration) {
        const delivery: FrickPushDelivery = {
          registration,
          attemptedAt: new Date().toISOString(),
          status: "delivered",
          receiptId: `receipt-${registration.registrationId}`,
        };
        recorded.push(delivery);
        return delivery;
      },
    };
    const delivery = await adapter.send(
      {
        intent: "message.new",
        tenantId: "_default",
        recipientUserIds: ["user-ada"],
        body: { title: "hi" },
      },
      {
        registrationId: "push-fake",
        tenantId: "_default",
        userId: "user-ada",
        deviceId: "device-1",
        platform: "test",
        token: "token-1",
        environment: "production",
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
      // ctx is unused by this minimal adapter
      undefined as never,
    );
    expect(delivery.status).toBe("delivered");
    expect(recorded).toHaveLength(1);
  });
});
