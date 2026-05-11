/**
 * In-memory push adapter. Records every delivery in a process-local list and
 * always reports success. Useful in two situations:
 *
 *   1. Test suites that need to assert "an intent fanned out to these
 *      devices" without standing up a real APNs/FCM mock.
 *   2. Local development — operators can poke the admin route, then read
 *      `adapter.delivered` to see exactly what would have been sent.
 *
 * The adapter is exported as both a factory (`createFrickTestPushAdapter`)
 * and a class-free shape so callers don't have to dig into internals to mock
 * it further. `reset()` clears the recorded list; tests should call it
 * between cases when sharing a single adapter across specs.
 */

import { randomUUID } from "node:crypto";
import type {
  FrickNotificationContext,
  FrickNotificationIntent,
  FrickPushAdapter,
  FrickPushDelivery,
  PushDeviceRegistration,
} from "./types.js";

export interface FrickTestPushAdapter extends FrickPushAdapter {
  platform: "test";
  /** Every delivery the adapter has been asked to perform, in order. */
  readonly delivered: ReadonlyArray<FrickPushDelivery>;
  /** Clear the recorded delivery list. */
  reset(): void;
}

export function createFrickTestPushAdapter(): FrickTestPushAdapter {
  const delivered: FrickPushDelivery[] = [];
  const adapter: FrickTestPushAdapter = {
    platform: "test",
    delivered,
    reset() {
      delivered.length = 0;
    },
    async send(
      _intent: FrickNotificationIntent,
      registration: PushDeviceRegistration,
      _ctx: FrickNotificationContext,
    ): Promise<FrickPushDelivery> {
      const delivery: FrickPushDelivery = {
        registration,
        attemptedAt: new Date().toISOString(),
        status: "delivered",
        receiptId: `test-receipt-${randomUUID()}`,
      };
      delivered.push(delivery);
      return delivery;
    },
  };
  return adapter;
}
