import type { FrickLogger } from "../logger.js";
import type {
  PlatformEventDelivery,
  PlatformEventPipeline,
} from "../platform-events/types.js";
import {
  AnalyticsEventStore,
  AnalyticsEventValidationError,
} from "./summary.js";

export interface FrickAnalyticsEventConsumer {
  start(): void;
  stop(): Promise<void>;
  drainOnce(): Promise<number>;
  readonly running: boolean;
  readonly consumerName: string;
}

export interface FrickAnalyticsEventConsumerOptions {
  readonly platformEvents: PlatformEventPipeline;
  readonly analyticsEvents: AnalyticsEventStore;
  readonly logger: FrickLogger;
  readonly consumerName?: string;
  readonly pollIntervalMs?: number;
  readonly claimBatchSize?: number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly gracefulShutdownTimeoutMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_CONSUMER_NAME = "frick.analytics.aggregates";
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_CLAIM_BATCH_SIZE = 100;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

export function createFrickAnalyticsEventConsumer(
  options: FrickAnalyticsEventConsumerOptions,
): FrickAnalyticsEventConsumer {
  const consumerName = normalizeConsumerName(options.consumerName ?? DEFAULT_CONSUMER_NAME);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const claimBatchSize = options.claimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const gracefulShutdownTimeoutMs =
    options.gracefulShutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const log = options.logger.child({ analyticsConsumer: consumerName });

  let started = false;
  let stopRequested = false;
  let inFlight = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopResolve: (() => void) | undefined;

  function schedule(): void {
    if (stopRequested) return;
    pollTimer = setTimeout(tick, pollIntervalMs);
    pollTimer.unref?.();
  }

  async function tick(): Promise<void> {
    if (stopRequested) return;
    try {
      await drainOnce();
    } catch (error) {
      log.warn("frick.analytics.consumer_tick_failed", {
        event: "frick.analytics.consumer_tick_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      schedule();
    }
  }

  async function drainOnce(): Promise<number> {
    inFlight += 1;
    try {
      const deliveries = await options.platformEvents.claim(consumerName, {
        batchSize: claimBatchSize,
      });
      for (const delivery of deliveries) {
        await processDelivery(delivery);
      }
      return deliveries.length;
    } finally {
      inFlight -= 1;
      if (stopRequested && inFlight === 0 && stopResolve) {
        stopResolve();
      }
    }
  }

  async function processDelivery(delivery: PlatformEventDelivery): Promise<void> {
    if (delivery.event.family !== "analytics.user_event") {
      await options.platformEvents.ack(consumerName, delivery.event.id, deliveryAttempt(delivery));
      return;
    }

    try {
      options.analyticsEvents.recordPlatformEvent(delivery.event);
      await options.platformEvents.ack(consumerName, delivery.event.id, deliveryAttempt(delivery));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AnalyticsEventValidationError) {
        await options.platformEvents.deadLetter(consumerName, delivery.event.id, {
          ...deliveryAttempt(delivery),
          error: message,
        });
        return;
      }
      if (delivery.attempt >= maxAttempts) {
        await options.platformEvents.deadLetter(consumerName, delivery.event.id, {
          ...deliveryAttempt(delivery),
          error: message,
        });
        return;
      }
      await options.platformEvents.retry(consumerName, delivery.event.id, {
        ...deliveryAttempt(delivery),
        error: message,
        availableAt: new Date(now().getTime() + retryDelayMs).toISOString(),
      });
    }
  }

  return {
    get running() {
      return started && !stopRequested;
    },
    consumerName,
    start() {
      if (started) return;
      started = true;
      log.info("frick.analytics.consumer_start", {
        event: "frick.analytics.consumer_start",
        pollIntervalMs,
        claimBatchSize,
      });
      schedule();
    },
    stop() {
      if (!started && inFlight === 0) return Promise.resolve();
      if (stopPromise) return stopPromise;
      stopRequested = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      if (inFlight === 0) {
        stopPromise = Promise.resolve();
        log.info("frick.analytics.consumer_stop", {
          event: "frick.analytics.consumer_stop",
          inFlight: 0,
        });
        return stopPromise;
      }
      stopPromise = new Promise<void>((resolve) => {
        stopResolve = resolve;
        const timer = setTimeout(() => {
          log.warn("frick.analytics.consumer_stop_timeout", {
            event: "frick.analytics.consumer_stop_timeout",
            inFlight,
          });
          resolve();
        }, gracefulShutdownTimeoutMs);
        timer.unref?.();
      }).then(() => {
        log.info("frick.analytics.consumer_stop", {
          event: "frick.analytics.consumer_stop",
          inFlight,
        });
      });
      return stopPromise;
    },
    drainOnce,
  };
}

function deliveryAttempt(delivery: PlatformEventDelivery): {
  attempt: number;
  claimedAt: string;
} {
  return { attempt: delivery.attempt, claimedAt: delivery.claimedAt };
}

function normalizeConsumerName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new Error("analytics consumer name cannot be empty");
  }
  return name;
}
