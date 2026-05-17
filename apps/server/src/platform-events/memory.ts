import { randomUUID } from "node:crypto";
import {
  normalizePlatformEventInput,
  type PlatformEventClaimOptions,
  type PlatformEventDeadLetterOptions,
  type PlatformEventDelivery,
  type PlatformEventEnvelope,
  type PlatformEventHealth,
  type PlatformEventInput,
  type PlatformEventPipeline,
  type PlatformEventPublishReceipt,
  type PlatformEventRetryOptions,
} from "./types.js";

type DeliveryStatus = "pending" | "claimed" | "retry" | "acked" | "dead_lettered";

interface DeliveryState {
  status: DeliveryStatus;
  attempt: number;
  availableAt: string;
  claimedAt: string | undefined;
  lastError: string | undefined;
}

export interface MemoryPlatformEventPipelineOptions {
  readonly now?: () => Date;
}

export class MemoryPlatformEventPipeline implements PlatformEventPipeline {
  readonly adapter = "memory" as const;
  readonly #now: () => Date;
  readonly #events: PlatformEventEnvelope[] = [];
  readonly #idempotency = new Map<string, PlatformEventEnvelope>();
  readonly #deliveries = new Map<string, Map<string, DeliveryState>>();
  #sequence = 0;

  constructor(options: MemoryPlatformEventPipelineOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async publish(input: PlatformEventInput): Promise<PlatformEventPublishReceipt> {
    const normalized = normalizePlatformEventInput(input, this.#now);
    if (normalized.idempotencyKey) {
      const existing = this.#idempotency.get(normalized.idempotencyKey);
      if (existing) {
        return {
          id: existing.id,
          sequence: existing.sequence,
          acceptedAt: this.#now().toISOString(),
          duplicate: true,
        };
      }
    }

    const event: PlatformEventEnvelope = {
      ...normalized,
      id: randomUUID(),
      sequence: ++this.#sequence,
    };
    this.#events.push(event);
    if (event.idempotencyKey) {
      this.#idempotency.set(event.idempotencyKey, event);
    }
    return {
      id: event.id,
      sequence: event.sequence,
      acceptedAt: this.#now().toISOString(),
      duplicate: false,
    };
  }

  async claim(
    consumer: string,
    options: PlatformEventClaimOptions = {},
  ): Promise<PlatformEventDelivery[]> {
    const state = this.#consumerState(consumer);
    for (const event of this.#events) {
      if (!state.has(event.id)) {
        state.set(event.id, {
          status: "pending",
          attempt: 0,
          availableAt: event.occurredAt,
          claimedAt: undefined,
          lastError: undefined,
        });
      }
    }

    const availableAt = options.availableAt ?? this.#now().toISOString();
    const batchSize = clampBatchSize(options.batchSize);
    const deliveries: PlatformEventDelivery[] = [];
    for (const event of this.#events) {
      if (deliveries.length >= batchSize) break;
      const delivery = state.get(event.id);
      if (!delivery || (delivery.status !== "pending" && delivery.status !== "retry")) continue;
      if (delivery.availableAt > availableAt) continue;

      const claimedAt = this.#now().toISOString();
      delivery.status = "claimed";
      delivery.attempt += 1;
      delivery.claimedAt = claimedAt;
      deliveries.push({
        event,
        consumer,
        attempt: delivery.attempt,
        claimedAt,
      });
    }
    return deliveries;
  }

  async ack(consumer: string, eventId: string): Promise<void> {
    const delivery = this.#consumerState(consumer).get(eventId);
    if (!delivery) return;
    delivery.status = "acked";
  }

  async retry(
    consumer: string,
    eventId: string,
    options: PlatformEventRetryOptions,
  ): Promise<void> {
    const delivery = this.#consumerState(consumer).get(eventId);
    if (!delivery) return;
    delivery.status = "retry";
    delivery.availableAt = options.availableAt ?? this.#now().toISOString();
    delivery.claimedAt = undefined;
    delivery.lastError = options.error;
  }

  async deadLetter(
    consumer: string,
    eventId: string,
    options: PlatformEventDeadLetterOptions,
  ): Promise<void> {
    const delivery = this.#consumerState(consumer).get(eventId);
    if (!delivery) return;
    delivery.status = "dead_lettered";
    delivery.lastError = options.error;
  }

  async health(): Promise<PlatformEventHealth> {
    const consumers = Array.from(this.#deliveries.entries())
      .map(([name, deliveries]) => {
        const counts = countDeliveries(deliveries.values());
        return {
          name,
          ...counts,
          lag: counts.pending + counts.claimed,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const aggregate = consumers.reduce(
      (sum, row) => ({
        pending: sum.pending + row.pending,
        claimed: sum.claimed + row.claimed,
        deadLettered: sum.deadLettered + row.deadLettered,
      }),
      { pending: 0, claimed: 0, deadLettered: 0 },
    );
    return {
      adapter: this.adapter,
      ok: true,
      pending: aggregate.pending,
      claimed: aggregate.claimed,
      deadLettered: aggregate.deadLettered,
      retained: this.#events.length,
      consumers,
    };
  }

  async close(): Promise<void> {
    this.#events.length = 0;
    this.#idempotency.clear();
    this.#deliveries.clear();
  }

  #consumerState(consumer: string): Map<string, DeliveryState> {
    const name = consumer.trim();
    if (name.length === 0) {
      throw new Error("platform event consumer name cannot be empty");
    }
    let state = this.#deliveries.get(name);
    if (!state) {
      state = new Map<string, DeliveryState>();
      this.#deliveries.set(name, state);
    }
    return state;
  }
}

function countDeliveries(deliveries: Iterable<DeliveryState>): {
  pending: number;
  claimed: number;
  deadLettered: number;
} {
  let pending = 0;
  let claimed = 0;
  let deadLettered = 0;
  for (const delivery of deliveries) {
    if (delivery.status === "pending" || delivery.status === "retry") pending += 1;
    if (delivery.status === "claimed") claimed += 1;
    if (delivery.status === "dead_lettered") deadLettered += 1;
  }
  return { pending, claimed, deadLettered };
}

function clampBatchSize(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value) || value <= 0) return 100;
  return Math.min(1000, Math.floor(value));
}
