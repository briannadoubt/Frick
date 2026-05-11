/**
 * Typed job handler registry. Apps register a handler per `jobType` at boot;
 * the worker resolves handlers by string name when claiming jobs. The
 * registry deliberately throws on duplicate registration — silently
 * shadowing a handler is an easy way to mis-route push notifications or
 * blob derivatives, and we'd rather fail loudly at boot than at run time.
 */

import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";

/**
 * Context passed to a job handler. Everything a handler needs to do its
 * work, plus a structured logger pre-bound to the job's identifying fields
 * (`tenantId`, `jobId`, `jobType`, `attemptCount`).
 */
export interface FrickJobContext {
  tenantId: string;
  jobId: number;
  jobType: string;
  payload: unknown;
  attemptCount: number;
  store: FrickStore;
  logger: FrickLogger;
}

/**
 * Outcome a handler returns from `handle()`. The worker translates this into
 * the appropriate `store.jobs.complete()` / `store.jobs.fail()` call.
 *
 *   status: "completed"  → `result` is recorded in the row's packed column
 *   status: "failed"     → `errorCode` + `errorMessage` are persisted;
 *                          `retryable` decides re-enqueue vs dead-letter
 *
 * Handlers that throw are translated into `{ status: "failed", errorCode:
 * "server.internal", retryable: true }` so a transient bug doesn't burn the
 * whole retry budget on the first attempt.
 */
export interface FrickJobResult {
  status: "completed" | "failed";
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
}

export type FrickJobHandler = (ctx: FrickJobContext) => Promise<FrickJobResult>;

export interface FrickJobRegistry {
  register(jobType: string, handler: FrickJobHandler): void;
  resolve(jobType: string): FrickJobHandler | undefined;
  list(): string[];
}

export class DuplicateJobHandlerError extends Error {
  readonly reason = "duplicateJobHandler";
  constructor(readonly jobType: string) {
    super(`A handler is already registered for job type "${jobType}"`);
    this.name = "DuplicateJobHandlerError";
  }
}

export function createFrickJobRegistry(): FrickJobRegistry {
  const handlers = new Map<string, FrickJobHandler>();
  return {
    register(jobType, handler) {
      if (handlers.has(jobType)) {
        throw new DuplicateJobHandlerError(jobType);
      }
      handlers.set(jobType, handler);
    },
    resolve(jobType) {
      return handlers.get(jobType);
    },
    list() {
      return Array.from(handlers.keys()).sort();
    },
  };
}
