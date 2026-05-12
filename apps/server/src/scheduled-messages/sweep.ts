/**
 * Scheduled-message promotion sweep.
 *
 * Phase 6 adds a `ScheduledMessage` object to the foundation schema —
 * a row representing a pre-composed message that should be delivered
 * later. This module runs the periodic sweep that promotes due rows
 * into actual `MessageSent` events on the matching conversation
 * stream and flips the row's status to `delivered`.
 *
 * The sweep is registered as a {@link FrickJobHandler} under the
 * `scheduled.sweep` job type. An app's startup code (or the
 * framework's own scheduler when wired) enqueues a `scheduled.sweep`
 * job every minute; the handler claims one run, looks up every
 * `status: "pending"` row whose `scheduledFor` is in the past, and
 * dispatches them.
 *
 * The handler is idempotent on (row, sequence) — if the worker
 * crashes mid-sweep, the next claim re-reads the still-pending rows
 * and tries again. The store's `versionPrecondition` on the
 * `ScheduledMessage` object means a row that was already delivered
 * (and the version bumped) is skipped on the second attempt.
 */

import type { FrickStore } from "../store.js";
import type { FrickLogger } from "../logger.js";
import type { FrickJobHandler, FrickJobResult } from "../jobs/registry.js";
import { randomUUID } from "node:crypto";

export const SCHEDULED_SWEEP_JOB_TYPE = "scheduled.sweep";

export interface ScheduledSweepOptions {
  readonly store: FrickStore;
  readonly logger: FrickLogger;
  /** Override clock for deterministic tests. */
  readonly now?: () => Date;
}

interface ScheduledMessageRow {
  id: string;
  userId: string;
  conversationId: string;
  body: string;
  scheduledFor: string;
  attachmentBlobIds?: unknown;
  status: "pending" | "delivered" | "cancelled";
}

export function createScheduledMessageSweepHandler(
  options: ScheduledSweepOptions,
): FrickJobHandler {
  const { store, logger } = options;
  const now = options.now ?? (() => new Date());

  return async (ctx): Promise<FrickJobResult> => {
    const tenantId = ctx.tenantId;
    const cutoff = now().toISOString();
    let promoted = 0;
    let skipped = 0;
    try {
      const rows = store.listObjects(tenantId, "ScheduledMessage") as unknown as ScheduledMessageRow[];
      for (const row of rows) {
        if (row.status !== "pending") continue;
        if (row.scheduledFor > cutoff) continue;
        try {
          store.appendEvent({
            tenantId,
            requestId: `scheduled-${row.id}-${randomUUID()}`,
            replicaId: "server-scheduler",
            stream: "MessageStream",
            streamId: row.conversationId,
            event: "MessageSent",
            payload: {
              messageId: `msg-${row.id}`,
              senderId: row.userId,
              body: row.body,
              createdAt: now().toISOString(),
              ...(row.attachmentBlobIds ? { attachmentBlobIds: row.attachmentBlobIds } : {}),
            },
          });
          store.upsertObject(tenantId, "ScheduledMessage", row.id, {
            ...row,
            status: "delivered",
          });
          promoted += 1;
        } catch (error) {
          logger.warn("frick.scheduled.promote_failed", {
            event: "frick.scheduled.promote_failed",
            scheduledId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
          skipped += 1;
        }
      }
      return {
        status: "completed",
        result: { promoted, skipped, cutoff },
      };
    } catch (error) {
      return {
        status: "failed",
        errorCode: "scheduled.sweepError",
        errorMessage: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  };
}
