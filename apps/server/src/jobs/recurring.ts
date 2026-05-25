/**
 * Recurring job scheduler. Re-enqueues a registered job once per time-window
 * using an idempotency key derived from the window start timestamp, so:
 *
 *   - ticks that fire multiple times in the same window are no-ops
 *   - process restarts resume correctly — the next tick after restart
 *     covers any window that landed while the process was down
 *   - multi-tenant fan-out is explicit: apps supply `resolveTargets` which
 *     returns one (tenantId, payload) tuple per target to enqueue
 *
 * This is intentionally thin — the scheduler owns the timer and the
 * idempotency strategy; the job worker owns retries and failure handling.
 */

import type { PlainObject } from "@frick/protocol";
import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";

export const RECURRING_MIN_INTERVAL_MS = 60_000;

export interface FrickRecurringJob {
  /** Stable name for this recurring spec, e.g. "discogs.poll-orders". */
  name: string;
  /** The jobType registered in jobs.handlers that will run on each tick. */
  jobType: string;
  /** Interval between completions, in ms. Minimum 60_000. */
  intervalMs: number;
  /**
   * Resolve the set of (tenantId, payload) tuples to enqueue on each tick.
   * Called by the scheduler on each tick; lets apps fan out across all
   * linked tenants without keeping their own list.
   */
  resolveTargets(ctx: { store: FrickStore; logger: FrickLogger }):
    | Iterable<{ tenantId: string; payload?: PlainObject }>
    | Promise<Iterable<{ tenantId: string; payload?: PlainObject }>>;
}

export interface FrickRecurringRegistry {
  list(): readonly FrickRecurringJob[];
}

export interface RecurringSchedulerOptions {
  store: FrickStore;
  logger: FrickLogger;
  jobs: readonly FrickRecurringJob[];
  tickIntervalMs?: number;
}

export interface RecurringScheduler {
  start(): void;
  stop(): void;
}

export function createFrickRecurringRegistry(
  jobs: readonly FrickRecurringJob[],
): FrickRecurringRegistry {
  for (const job of jobs) {
    if (job.intervalMs < RECURRING_MIN_INTERVAL_MS) {
      throw new Error(
        `Recurring job "${job.name}" intervalMs must be >= ${RECURRING_MIN_INTERVAL_MS} (got ${job.intervalMs})`,
      );
    }
  }
  const registered = jobs.slice();
  return {
    list: () => registered,
  };
}

export function createRecurringScheduler(opts: RecurringSchedulerOptions): RecurringScheduler {
  const { store, logger, jobs } = opts;
  const tickIntervalMs = opts.tickIntervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function tick(): Promise<void> {
    const now = Date.now();
    for (const job of jobs) {
      const windowStart = Math.floor(now / job.intervalMs) * job.intervalMs;
      const idempotencyKeyPrefix = `recurring:${job.name}:`;
      let targets: Iterable<{ tenantId: string; payload?: PlainObject }>;
      try {
        targets = await job.resolveTargets({ store, logger });
      } catch (err) {
        logger.error("frick.recurring.resolve_targets_failed", {
          event: "frick.recurring.resolve_targets_failed",
          jobName: job.name,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      for (const { tenantId, payload } of targets) {
        const idempotencyKey = `${idempotencyKeyPrefix}${tenantId}:${windowStart}`;
        try {
          store.jobs.enqueue({
            tenantId,
            jobType: job.jobType,
            payload: payload ?? {},
            idempotencyKey,
            availableAt: new Date(windowStart).toISOString(),
          });
        } catch (err) {
          logger.error("frick.recurring.enqueue_failed", {
            event: "frick.recurring.enqueue_failed",
            jobName: job.name,
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      const interval = setInterval(() => {
        void tick();
      }, tickIntervalMs);
      interval.unref();
      timer = interval;
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
