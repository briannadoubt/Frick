/**
 * In-memory email adapter. Records every send for test assertions and
 * always succeeds. The framework's default when no other adapter is
 * registered, mirroring the push framework's `TestPushAdapter`.
 */
import { randomUUID } from "node:crypto";
import type {
  FrickEmailAdapter,
  FrickEmailContext,
  FrickEmailDelivery,
  FrickEmailMessage,
} from "./types.js";

export interface FrickTestEmailAdapter extends FrickEmailAdapter {
  readonly provider: "test";
  readonly delivered: ReadonlyArray<{ message: FrickEmailMessage; delivery: FrickEmailDelivery }>;
  reset(): void;
}

export function createFrickTestEmailAdapter(): FrickTestEmailAdapter {
  const delivered: { message: FrickEmailMessage; delivery: FrickEmailDelivery }[] = [];
  return {
    provider: "test",
    delivered,
    reset() {
      delivered.length = 0;
    },
    async send(message: FrickEmailMessage, _ctx: FrickEmailContext): Promise<FrickEmailDelivery> {
      const delivery: FrickEmailDelivery = {
        attemptedAt: new Date().toISOString(),
        status: "delivered",
        receiptId: `test-email-${randomUUID()}`,
      };
      delivered.push({ message, delivery });
      return delivery;
    },
  };
}
