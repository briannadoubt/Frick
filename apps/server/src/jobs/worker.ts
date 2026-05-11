/**
 * In-process background-job worker. Polls the {@link JobStore} on an interval,
 * claims a batch of ready jobs, and dispatches each through the registered
 * handler. The worker is intentionally minimal:
 *
 *   - one polling loop per worker instance (no thread pool)
 *   - sequential handler execution within a claim batch (no per-job
 *     concurrency knob)
 *   - graceful stop awaits in-flight handlers up to `gracefulShutdownTimeoutMs`
 *
 * Apps that need higher throughput run multiple workers (each with its own
 * stable `workerId`); the `claim` SQL is safe under concurrent callers
 * because SQLite serializes writes through a single writer lock.
 */

import { randomUUID } from "node:crypto";
import type { FrickLogger } from "../logger.js";
import type { FrickMetrics } from "../metrics.js";
import type { FrickStore } from "../store.js";
import type { JobRow } from "../storage/job-store.js";
import { emitDevToolsEvent } from "../devtools/emit.js";
import type { FrickJobHandler, FrickJobRegistry, FrickJobResult } from "./registry.js";

export interface FrickJobWorker {
  start(): void;
  stop(): Promise<void>;
  /** True iff `start()` has been called and `stop()` hasn't completed. */
  readonly running: boolean;
  /** Stable id baked into claim/`last_error` rows for traceability. */
  readonly workerId: string;
}

export interface FrickJobWorkerOptions {
  store: FrickStore;
  registry: FrickJobRegistry;
  logger: FrickLogger;
  workerId?: string;
  pollIntervalMs?: number;
  claimBatchSize?: number;
  metrics?: FrickMetrics;
  /** How long `stop()` waits for in-flight handlers before resolving. */
  gracefulShutdownTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_CLAIM_BATCH_SIZE = 5;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

export function createFrickJobWorker(options: FrickJobWorkerOptions): FrickJobWorker {
  const {
    store,
    registry,
    logger,
    metrics,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    claimBatchSize = DEFAULT_CLAIM_BATCH_SIZE,
    gracefulShutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = options;
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const log = logger.child({ workerId });

  let started = false;
  let stopRequested = false;
  let inFlight = 0;
  let stopResolve: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  function schedule(): void {
    if (stopRequested) return;
    pollTimer = setTimeout(tick, pollIntervalMs);
    // The worker is a daemon — don't let it keep the event loop alive on its
    // own. Tests rely on this to allow the process to exit when their
    // server.close() resolves before the next tick.
    pollTimer.unref?.();
  }

  async function tick(): Promise<void> {
    if (stopRequested) return;
    try {
      const claimed = store.jobs.claim(workerId, undefined, claimBatchSize);
      if (claimed.length > 0) {
        metrics?.counter("frick.jobs.claimed.total").inc(claimed.length);
        // Process serially so a slow handler doesn't starve the worker's
        // ability to acknowledge stop. With `Promise.all` we'd have to track
        // each handler's settle separately for graceful shutdown.
        for (const job of claimed) {
          await runJob(job);
          if (stopRequested) break;
        }
      }
    } catch (error) {
      // A failure here means the claim query itself blew up (e.g. database
      // disappeared). Log loudly and keep polling — the next tick gets a
      // fresh chance. We intentionally never tear down the worker from this
      // catch.
      log.error("frick.jobs.tick_error", {
        event: "frick.jobs.tick_error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      schedule();
    }
  }

  async function runJob(job: JobRow): Promise<void> {
    inFlight += 1;
    const startedAtMs = Date.now();
    const handler = registry.resolve(job.jobType);
    const ctx = {
      tenantId: job.tenantId,
      jobId: job.id,
      jobType: job.jobType,
      payload: job.payload,
      attemptCount: job.attemptCount,
      store,
      logger: log.child({
        jobId: job.id,
        jobType: job.jobType,
        tenantId: job.tenantId,
        attemptCount: job.attemptCount,
      }),
    };

    try {
      if (!handler) {
        // No handler registered for this job type. Fail non-retryable so the
        // row goes straight to dead-letter — retrying without code changes
        // can't help, and we don't want a misconfigured queue to silently
        // accumulate stale jobs.
        const result: FrickJobResult = {
          status: "failed",
          errorCode: "jobs.unknownHandler",
          errorMessage: `No handler registered for job type "${job.jobType}"`,
          retryable: false,
        };
        applyResult(job, result, startedAtMs);
        return;
      }

      let result: FrickJobResult;
      try {
        result = await handler(ctx);
      } catch (error) {
        // Handler threw — translate into a retryable failure with the
        // generic server.internal code. The retry budget eventually
        // dead-letters this, but we give it a chance to be a transient
        // hiccup first.
        result = {
          status: "failed",
          errorCode: "server.internal",
          errorMessage: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
        ctx.logger.error("frick.jobs.handler_threw", {
          event: "frick.jobs.handler_threw",
          error: result.errorMessage,
        });
      }
      applyResult(job, result, startedAtMs);
    } finally {
      inFlight -= 1;
      if (stopRequested && inFlight === 0 && stopResolve) {
        stopResolve();
      }
    }
  }

  function applyResult(job: JobRow, result: FrickJobResult, startedAtMs: number): void {
    const durationMs = Date.now() - startedAtMs;
    if (result.status === "completed") {
      store.jobs.complete(job.id, result.result);
      metrics?.counter("frick.jobs.completed.total", { jobType: job.jobType }).inc();
      emitDevToolsEvent(store, {
        kind: "job.completed",
        tenantId: job.tenantId,
        fields: { jobType: job.jobType, jobId: job.id, durationMs },
      });
      return;
    }
    const retryable = result.retryable ?? false;
    const errorCode = result.errorCode ?? "server.internal";
    const errorMessage = result.errorMessage ?? "job handler returned failure";
    store.jobs.fail(job.id, errorCode, errorMessage, retryable);
    metrics
      ?.counter("frick.jobs.failed.total", {
        jobType: job.jobType,
        retryable: String(retryable),
      })
      .inc();
    // Re-read so we can tell whether `fail` rolled this into dead-letter or
    // a retry. The same `fail` returning that info would be tighter, but
    // keeping the store API symmetrical with `complete` is worth one extra
    // SELECT in the failure path.
    const after = store.jobs.getById(job.id);
    const attemptCount = after?.attemptCount ?? job.attemptCount + 1;
    if (after?.status === "dead_lettered") {
      metrics?.counter("frick.jobs.dead_lettered.total", { jobType: job.jobType }).inc();
      emitDevToolsEvent(store, {
        kind: "job.dead_lettered",
        tenantId: job.tenantId,
        fields: { jobType: job.jobType, jobId: job.id, errorCode, attemptCount },
      });
    } else {
      emitDevToolsEvent(store, {
        kind: "job.failed",
        tenantId: job.tenantId,
        fields: { jobType: job.jobType, jobId: job.id, errorCode, attemptCount },
      });
    }
  }

  return {
    get running() {
      return started && !stopRequested;
    },
    workerId,
    start() {
      if (started) return;
      started = true;
      log.info("frick.jobs.worker_start", {
        event: "frick.jobs.worker_start",
        pollIntervalMs,
        claimBatchSize,
      });
      schedule();
    },
    stop() {
      if (!started) return Promise.resolve();
      if (stopPromise) return stopPromise;
      stopRequested = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      if (inFlight === 0) {
        stopPromise = Promise.resolve();
        log.info("frick.jobs.worker_stop", { event: "frick.jobs.worker_stop", inFlight: 0 });
        return stopPromise;
      }
      stopPromise = new Promise<void>((resolve) => {
        stopResolve = resolve;
        const timer = setTimeout(() => {
          log.warn("frick.jobs.worker_stop_timeout", {
            event: "frick.jobs.worker_stop_timeout",
            inFlight,
          });
          resolve();
        }, gracefulShutdownTimeoutMs);
        timer.unref?.();
      }).then(() => {
        log.info("frick.jobs.worker_stop", { event: "frick.jobs.worker_stop", inFlight });
      });
      return stopPromise;
    },
  };
}
