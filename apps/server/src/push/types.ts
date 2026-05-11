/**
 * Type surface for the push-notification framework.
 *
 * A {@link FrickNotificationIntent} is the privacy-safe, already-translated
 * description of "what should be delivered to whom". Apps construct intents
 * and hand them to the notification router; the router resolves recipient
 * devices, groups by platform, and delegates physical delivery to a
 * {@link FrickPushAdapter}. The adapter surface is intentionally thin: it
 * takes an intent + one registration and returns one {@link FrickPushDelivery}.
 * Fan-out, retries, and revocation handling live in the router so adapters
 * stay focused on the platform-specific encoding step.
 *
 * The framework ships exactly one adapter — the in-memory test adapter — to
 * keep credential-bearing dependencies (APNs, FCM, web-push) out of the core
 * dependency tree. Apps register real adapters via `ServerOptions.push`.
 */

import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";
import type {
  PushDeviceRegistration,
  PushPlatform,
} from "../storage/push-registration-store.js";

export type { PushDeviceRegistration, PushPlatform } from "../storage/push-registration-store.js";

/**
 * A privacy-safe, already-translated description of a notification to send.
 *
 * `intent` is a stable semantic identifier (convention `"<noun>.<verb>"`,
 * e.g. `"message.new"`, `"call.ringing"`) so apps can register routing
 * preferences or sound mappings per-intent without depending on body text.
 *
 * `recipientUserIds` is an explicit list for v1. Broadcast (empty list → all
 * tenant members) is documented as out of scope for the first slice.
 *
 * `body.data` is the only place to ship structured payload — keep it small
 * and non-sensitive. APNs caps the alert at 4 KB total; FCM at 4 KB for
 * `data` messages. The framework doesn't enforce this — it's the adapter's
 * job to translate or reject.
 */
export interface FrickNotificationIntent {
  intent: string;
  tenantId: string;
  recipientUserIds: readonly string[];
  body: {
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
  };
  threadId?: string;
  deepLink?: string;
}

export interface FrickNotificationContext {
  tenantId: string;
  intent: FrickNotificationIntent;
  store: FrickStore;
  logger: FrickLogger;
}

/**
 * Outcome of one delivery attempt for one (intent, registration) pair. The
 * router accumulates these into the job result so operators can read back
 * exactly what landed where.
 *
 *   "delivered" — adapter handed the payload off to the platform
 *   "failed"    — adapter rejected the registration; `error` is populated
 *   "skipped"   — no adapter registered for the platform, or the adapter
 *                 declined for a non-error reason (e.g. environment mismatch)
 */
export interface FrickPushDelivery {
  registration: PushDeviceRegistration;
  attemptedAt: string;
  status: "delivered" | "failed" | "skipped";
  error?: { code: string; message: string };
  receiptId?: string;
}

/**
 * Pluggable platform adapter. The framework groups registrations by
 * `platform` and dispatches each to the matching adapter. Adapters MUST be
 * idempotent on (intent, registration) — the job framework re-runs failed
 * jobs and a partial delivery shouldn't multiply notifications.
 *
 * `send()` should be defensive: a thrown exception is treated as a
 * `status: "failed"` with `error.code = "adapter.threw"` so a bug in one
 * adapter can't tear down the worker.
 */
export interface FrickPushAdapter {
  platform: PushPlatform;
  send(
    intent: FrickNotificationIntent,
    registration: PushDeviceRegistration,
    ctx: FrickNotificationContext,
  ): Promise<FrickPushDelivery>;
}

/**
 * Error codes adapters use to signal that a registration's token is no
 * longer accepted by the platform and should be revoked. The router watches
 * for these and calls `pushRegistrations.revoke(...)` so the next delivery
 * skips the dead token.
 *
 * Mirrors APNs `BadDeviceToken` / `Unregistered`, FCM `UNREGISTERED` /
 * `INVALID_ARGUMENT(registration token)`, and web-push 410 Gone responses.
 */
export const PUSH_REVOCATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "push.badDeviceToken",
  "push.unregistered",
  "push.tokenExpired",
]);

export function isPushRevocationError(code: string | undefined): boolean {
  return code !== undefined && PUSH_REVOCATION_ERROR_CODES.has(code);
}
