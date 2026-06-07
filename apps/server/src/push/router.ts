/**
 * Notification router. Wired into the job framework as the `push.deliver`
 * handler: the worker hands it a job whose payload is a serialized
 * {@link FrickNotificationIntent}, and the router fans the intent out to
 * every active push registration for the listed recipients.
 *
 * Lifecycle for one job:
 *
 *   1. Decode the payload into a {@link FrickNotificationIntent}.
 *   2. For each user in `recipientUserIds`, list their active registrations.
 *   3. Group by `platform` and resolve the adapter — registrations whose
 *      platform has no adapter become `status: "skipped"` deliveries with
 *      `error.code = "push.unknownAdapter"`.
 *   4. For each remaining registration, call `adapter.send(...)`. On
 *      `status: "delivered"`, bump `last_seen_at` via
 *      `pushRegistrations.touch(...)`. On `status: "failed"` with a
 *      revocation error code (see {@link isPushRevocationError}), revoke the
 *      registration so the next intent skips it.
 *   5. A thrown exception from the adapter is converted into a synthetic
 *      `status: "failed"` delivery with `error.code = "adapter.threw"` so a
 *      single buggy adapter can't poison the entire job. The job itself
 *      still completes — partial fan-out is the right behavior here, since
 *      reattempting the whole job would multiply successful deliveries.
 *
 * Convenience: `enqueueIntent(...)` packages an intent as a `push.deliver`
 * job row so HTTP routes / app code don't have to repeat the encoding
 * boilerplate.
 */

import type { JobRow } from "../storage/job-store.js";
import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";
import type { FrickJobHandler, FrickJobResult } from "../jobs/registry.js";
import type { FrickPushRegistry } from "./registry.js";
import {
  isPushRevocationError,
  type FrickNotificationContext,
  type FrickNotificationIntent,
  type FrickPushAdapter,
  type FrickPushDelivery,
  type PushDeviceRegistration,
} from "./types.js";

export const PUSH_DELIVER_JOB_TYPE = "push.deliver";

export interface NotificationRouter {
  /** Job handler — register with the job worker under {@link PUSH_DELIVER_JOB_TYPE}. */
  handler: FrickJobHandler;
  /** Enqueue an intent for asynchronous delivery. Returns the persisted job row. */
  enqueueIntent(intent: FrickNotificationIntent): Promise<JobRow>;
  /**
   * Run the router inline against an intent. Exposed for tests and for the
   * rare caller that needs to fan out synchronously (e.g. an admin "send
   * once and tell me what happened" tool). Production paths should prefer
   * `enqueueIntent` so retries are durable.
   */
  deliver(intent: FrickNotificationIntent): Promise<FrickPushDelivery[]>;
}

export interface NotificationRouterOptions {
  store: FrickStore;
  pushRegistry: FrickPushRegistry;
  logger: FrickLogger;
}

export function createNotificationRouter(deps: NotificationRouterOptions): NotificationRouter {
  const { store, pushRegistry, logger } = deps;

  async function deliver(intent: FrickNotificationIntent): Promise<FrickPushDelivery[]> {
    const deliveries: FrickPushDelivery[] = [];
    const seen = new Set<string>();
    for (const userId of intent.recipientUserIds) {
      const registrations = await store.pushRegistrations.listByUser(intent.tenantId, userId);
      for (const registration of registrations) {
        // De-dupe in the (rare) case a recipient list repeats a user — we
        // don't want two deliveries to the same registration just because
        // the caller passed `["user-ada", "user-ada"]`.
        if (seen.has(registration.registrationId)) continue;
        seen.add(registration.registrationId);

        const delivery = await deliverOne(intent, registration);
        deliveries.push(delivery);
      }
    }
    return deliveries;
  }

  async function deliverOne(
    intent: FrickNotificationIntent,
    registration: PushDeviceRegistration,
  ): Promise<FrickPushDelivery> {
    const adapter: FrickPushAdapter | undefined = pushRegistry.resolveAdapter(
      registration.platform,
    );
    if (!adapter) {
      return {
        registration,
        attemptedAt: new Date().toISOString(),
        status: "skipped",
        error: {
          code: "push.unknownAdapter",
          message: `No adapter registered for platform "${registration.platform}"`,
        },
      };
    }
    const ctx: FrickNotificationContext = {
      tenantId: intent.tenantId,
      intent,
      store,
      logger: logger.child({
        intent: intent.intent,
        tenantId: intent.tenantId,
        registrationId: registration.registrationId,
        platform: registration.platform,
      }),
    };
    let delivery: FrickPushDelivery;
    try {
      delivery = await adapter.send(intent, registration, ctx);
    } catch (error) {
      delivery = {
        registration,
        attemptedAt: new Date().toISOString(),
        status: "failed",
        error: {
          code: "adapter.threw",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      ctx.logger.error("frick.push.adapter_threw", {
        event: "frick.push.adapter_threw",
        error: delivery.error?.message,
      });
    }
    if (delivery.status === "delivered") {
      store.pushRegistrations.touch(registration.registrationId, registration.tenantId);
    } else if (delivery.status === "failed" && isPushRevocationError(delivery.error?.code)) {
      // The platform told us this token is dead. Tombstone the registration
      // so future intents skip it; the row stays in the table so operators
      // can still grep for who-what-when.
      store.pushRegistrations.revoke(registration.registrationId, registration.tenantId);
      ctx.logger.info("frick.push.revoked", {
        event: "frick.push.revoked",
        reason: delivery.error?.code,
      });
    }
    void store.devtoolsEvents
      .record({
        kind: "frick.push.delivery",
        tenantId: registration.tenantId,
        fields: {
          intent: intent.intent,
          platform: registration.platform,
          registrationId: registration.registrationId,
          userId: registration.userId,
          status: delivery.status,
          ...(delivery.error ? { errorCode: delivery.error.code } : {}),
          ...(delivery.receiptId ? { receiptId: delivery.receiptId } : {}),
        },
      })
      .catch(() => {});
    return delivery;
  }

  const handler: FrickJobHandler = async (ctx) => {
    const intent = decodeIntent(ctx.payload);
    if (intent instanceof Error) {
      const result: FrickJobResult = {
        status: "failed",
        errorCode: "push.invalidIntent",
        errorMessage: intent.message,
        retryable: false,
      };
      return result;
    }
    try {
      const deliveries = await deliver(intent);
      return {
        status: "completed",
        result: {
          intent: intent.intent,
          tenantId: intent.tenantId,
          deliveries: deliveries.map(serializeDelivery),
        },
      };
    } catch (error) {
      // We treat router-level failures as retryable: the most common cause
      // is the database being momentarily unavailable, which the worker's
      // exponential backoff is built to absorb.
      return {
        status: "failed",
        errorCode: "push.routerError",
        errorMessage: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  };

  async function enqueueIntent(intent: FrickNotificationIntent): Promise<JobRow> {
    return store.jobs.enqueue({
      tenantId: intent.tenantId,
      jobType: PUSH_DELIVER_JOB_TYPE,
      payload: encodeIntent(intent),
    });
  }

  return { handler, enqueueIntent, deliver };
}

function encodeIntent(intent: FrickNotificationIntent): Record<string, unknown> {
  return {
    intent: intent.intent,
    tenantId: intent.tenantId,
    recipientUserIds: [...intent.recipientUserIds],
    body: { ...intent.body },
    ...(intent.threadId !== undefined ? { threadId: intent.threadId } : {}),
    ...(intent.deepLink !== undefined ? { deepLink: intent.deepLink } : {}),
  };
}

function decodeIntent(payload: unknown): FrickNotificationIntent | Error {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return new Error("push.deliver payload must be an object");
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.intent !== "string" || obj.intent.length === 0) {
    return new Error("push.deliver payload.intent must be a non-empty string");
  }
  if (typeof obj.tenantId !== "string" || obj.tenantId.length === 0) {
    return new Error("push.deliver payload.tenantId must be a non-empty string");
  }
  if (!Array.isArray(obj.recipientUserIds)) {
    return new Error("push.deliver payload.recipientUserIds must be an array");
  }
  for (const u of obj.recipientUserIds) {
    if (typeof u !== "string" || u.length === 0) {
      return new Error("push.deliver payload.recipientUserIds must be strings");
    }
  }
  const body =
    obj.body && typeof obj.body === "object" && !Array.isArray(obj.body)
      ? (obj.body as Record<string, unknown>)
      : {};
  const intent: FrickNotificationIntent = {
    intent: obj.intent,
    tenantId: obj.tenantId,
    recipientUserIds: obj.recipientUserIds as string[],
    body: {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      ...(body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? { data: body.data as Record<string, unknown> }
        : {}),
    },
  };
  if (typeof obj.threadId === "string") intent.threadId = obj.threadId;
  if (typeof obj.deepLink === "string") intent.deepLink = obj.deepLink;
  return intent;
}

function serializeDelivery(delivery: FrickPushDelivery): Record<string, unknown> {
  const out: Record<string, unknown> = {
    registrationId: delivery.registration.registrationId,
    userId: delivery.registration.userId,
    deviceId: delivery.registration.deviceId,
    platform: delivery.registration.platform,
    attemptedAt: delivery.attemptedAt,
    status: delivery.status,
  };
  if (delivery.error) out.error = delivery.error;
  if (delivery.receiptId) out.receiptId = delivery.receiptId;
  return out;
}
