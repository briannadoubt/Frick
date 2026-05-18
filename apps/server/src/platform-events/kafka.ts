import { createHash, randomUUID } from "node:crypto";
import {
  Kafka,
  logLevel,
  type Admin,
  type Consumer,
  type EachMessagePayload,
  type Producer,
} from "kafkajs";
import {
  normalizePlatformEventInput,
  isPlatformEventFamily,
  type PlatformEventAckOptions,
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

export interface KafkaPlatformEventPipelineOptions {
  readonly brokers: readonly string[];
  readonly topic: string;
  readonly consumerGroup: string;
  readonly clientId?: string;
  readonly now?: () => Date;
}

type DeliveryStatus = "pending" | "claimed" | "retry" | "acked" | "dead_lettered";

interface KafkaQueuedEvent {
  readonly event: PlatformEventEnvelope;
  topic: string | undefined;
  partition: number | undefined;
  offset: string | undefined;
  availableAt: string;
}

interface KafkaDeliveryState {
  status: DeliveryStatus;
  attempt: number;
  availableAt: string;
  claimedAt: string | undefined;
  queued: KafkaQueuedEvent | undefined;
}

interface KafkaConsumerState {
  readonly name: string;
  readonly groupId: string;
  readonly consumer: Consumer;
  readonly queue: KafkaQueuedEvent[];
  readonly deliveries: Map<string, KafkaDeliveryState>;
  readonly offsets: Map<string, KafkaPartitionOffsets>;
  connected: boolean;
  running: boolean;
}

interface KafkaPartitionOffsets {
  readonly seen: Set<string>;
  readonly terminal: Set<string>;
  committedNext: bigint | undefined;
}

export class KafkaPlatformEventPipeline implements PlatformEventPipeline {
  readonly adapter = "kafka" as const;

  readonly #brokers: string[];
  readonly #topic: string;
  readonly #consumerGroup: string;
  readonly #now: () => Date;
  readonly #kafka: Kafka;
  readonly #producer: Producer;
  readonly #admin: Admin;
  readonly #consumers = new Map<string, KafkaConsumerState>();
  readonly #retained = new Map<string, PlatformEventEnvelope>();
  readonly #idempotency = new Map<string, PlatformEventPublishReceipt>();
  #producerConnected = false;
  #adminConnected = false;
  readonly #readyTopics = new Set<string>();
  #lastError: string | undefined;
  #sequence = 0;
  #closed = false;

  constructor(options: KafkaPlatformEventPipelineOptions) {
    const brokers = [...options.brokers].map((broker) => broker.trim()).filter(Boolean);
    if (brokers.length === 0) {
      throw new Error("Kafka platform events require at least one broker");
    }
    const topic = options.topic.trim();
    if (topic.length === 0) {
      throw new Error("Kafka platform events require a topic");
    }
    const consumerGroup = options.consumerGroup.trim();
    if (consumerGroup.length === 0) {
      throw new Error("Kafka platform events require a consumer group");
    }

    this.#brokers = brokers;
    this.#topic = topic;
    this.#consumerGroup = consumerGroup;
    this.#now = options.now ?? (() => new Date());
    this.#kafka = new Kafka({
      clientId: options.clientId ?? "frick-platform-events",
      brokers,
      logLevel: logLevel.NOTHING,
    });
    this.#producer = this.#kafka.producer({ allowAutoTopicCreation: true });
    this.#admin = this.#kafka.admin();
  }

  async publish(input: PlatformEventInput): Promise<PlatformEventPublishReceipt> {
    this.#assertOpen();
    const normalized = normalizePlatformEventInput(input, this.#now);
    const acceptedAt = this.#now().toISOString();
    if (normalized.idempotencyKey) {
      const existing = this.#idempotency.get(idempotencyScope(normalized.tenantId, normalized.idempotencyKey));
      if (existing) {
        return { ...existing, duplicate: true };
      }
    }

    const event: PlatformEventEnvelope = {
      ...normalized,
      id: randomUUID(),
      sequence: ++this.#sequence,
      acceptedAt,
    };

    await this.#publishEvent(event);

    const receipt = receiptFromEnvelope(event, false);
    if (event.idempotencyKey) {
      this.#idempotency.set(idempotencyScope(event.tenantId, event.idempotencyKey), receipt);
    }
    return receipt;
  }

  async claim(
    consumer: string,
    options: PlatformEventClaimOptions = {},
  ): Promise<PlatformEventDelivery[]> {
    this.#assertOpen();
    const state = await this.#ensureConsumer(consumer);
    const availableAt = options.availableAt ?? this.#now().toISOString();
    const batchSize = clampBatchSize(options.batchSize);

    const deliveries: PlatformEventDelivery[] = [];
    for (let index = 0; index < state.queue.length && deliveries.length < batchSize;) {
      const queued = state.queue[index]!;
      const delivery = state.deliveries.get(queued.event.id);
      if (!delivery || delivery.status === "acked" || delivery.status === "dead_lettered") {
        state.queue.splice(index, 1);
        continue;
      }
      if (delivery.status !== "pending" && delivery.status !== "retry") {
        index += 1;
        continue;
      }
      if (delivery.availableAt > availableAt) {
        index += 1;
        continue;
      }

      state.queue.splice(index, 1);
      delivery.status = "claimed";
      delivery.attempt += 1;
      delivery.queued = queued;
      const claimedAt = this.#now().toISOString();
      delivery.claimedAt = claimedAt;
      deliveries.push({
        event: queued.event,
        consumer: state.name,
        attempt: delivery.attempt,
        claimedAt,
      });
    }

    return deliveries;
  }

  async ack(
    consumer: string,
    eventId: string,
    options: PlatformEventAckOptions,
  ): Promise<void> {
    const state = this.#consumers.get(normalizeConsumerName(consumer));
    const delivery = state?.deliveries.get(eventId);
    if (!state || !delivery || !matchesDeliveryAttempt(delivery, options)) return;
    await this.#commitTerminalOffset(state, delivery.queued);
    delivery.status = "acked";
    delivery.queued = undefined;
    delivery.claimedAt = undefined;
  }

  async retry(
    consumer: string,
    eventId: string,
    options: PlatformEventRetryOptions,
  ): Promise<void> {
    const state = this.#consumers.get(normalizeConsumerName(consumer));
    const delivery = state?.deliveries.get(eventId);
    if (!state || !delivery || !matchesDeliveryAttempt(delivery, options)) return;
    const queued = delivery.queued;
    if (!queued) return;
    const availableAt = options.availableAt ?? this.#now().toISOString();
    delivery.status = "retry";
    delivery.availableAt = availableAt;
    delivery.queued = undefined;
    delivery.claimedAt = undefined;
    try {
      await this.#publishEvent(queued.event, {
        "frick-original-event-id": queued.event.id,
        "frick-retry-attempt": String(delivery.attempt + 1),
      });
      await this.#commitTerminalOffset(state, queued);
    } catch (error) {
      delivery.status = "claimed";
      delivery.availableAt = queued.availableAt;
      delivery.queued = queued;
      delivery.claimedAt = options.claimedAt;
      throw error;
    }
  }

  async deadLetter(
    consumer: string,
    eventId: string,
    options: PlatformEventDeadLetterOptions,
  ): Promise<void> {
    const state = this.#consumers.get(normalizeConsumerName(consumer));
    const delivery = state?.deliveries.get(eventId);
    if (!state || !delivery || !matchesDeliveryAttempt(delivery, options)) return;
    const queued = delivery.queued;

    await this.#ensureProducer(`${this.#topic}.dlq`);
    await this.#producer.send({
      topic: `${this.#topic}.dlq`,
      messages: [
        {
          key: queued?.event.tenantId ?? queued?.event.id ?? eventId,
          value: JSON.stringify({
            event: queued?.event ?? this.#retained.get(eventId),
            consumer: state.name,
            error: options.error,
            deadLetteredAt: this.#now().toISOString(),
          }),
        },
      ],
    });
    await this.#commitTerminalOffset(state, queued);
    delivery.status = "dead_lettered";
    delivery.queued = undefined;
    delivery.claimedAt = undefined;
  }

  async health(): Promise<PlatformEventHealth> {
    const consumers = Array.from(this.#consumers.values())
      .map((state) => {
        let pending = 0;
        let claimed = 0;
        let deadLettered = 0;
        for (const delivery of state.deliveries.values()) {
          if (delivery.status === "pending" || delivery.status === "retry") pending += 1;
          if (delivery.status === "claimed") claimed += 1;
          if (delivery.status === "dead_lettered") deadLettered += 1;
        }
        return {
          name: state.name,
          pending,
          claimed,
          deadLettered,
          lag: pending + claimed,
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
    const claimedEventIds = new Set<string>();
    for (const state of this.#consumers.values()) {
      for (const eventId of state.deliveries.keys()) {
        claimedEventIds.add(eventId);
      }
    }
    let ok = false;
    if (!this.#closed) {
      ok = await this.#checkBrokerHealth();
    }
    return {
      adapter: this.adapter,
      ok,
      pending: aggregate.pending,
      claimed: aggregate.claimed,
      deadLettered: aggregate.deadLettered,
      retained: this.#retained.size,
      unclaimed: Math.max(0, this.#retained.size - claimedEventIds.size),
      consumers,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    await Promise.allSettled(
      Array.from(this.#consumers.values()).map(async (state) => {
        try {
          if (state.running) await state.consumer.stop();
        } finally {
          if (state.connected) await state.consumer.disconnect();
        }
      }),
    ).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
    });
    if (this.#producerConnected) {
      try {
        await this.#producer.disconnect();
      } catch (error) {
        errors.push(error);
      } finally {
        this.#producerConnected = false;
      }
    }
    if (this.#adminConnected) {
      try {
        await this.#admin.disconnect();
      } catch (error) {
        errors.push(error);
      } finally {
        this.#adminConnected = false;
      }
    }
    this.#consumers.clear();
    this.#retained.clear();
    this.#idempotency.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, "Kafka platform event pipeline close failed");
    }
  }

  async #ensureProducer(topic = this.#topic): Promise<void> {
    await this.#ensureTopic(topic);
    if (!this.#producerConnected) {
      await this.#producer.connect();
      this.#producerConnected = true;
    }
  }

  async #ensureTopic(topic = this.#topic): Promise<void> {
    if (this.#readyTopics.has(topic)) return;
    try {
      if (!this.#adminConnected) {
        await this.#admin.connect();
        this.#adminConnected = true;
      }
      await this.#admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic }],
      });
      this.#lastError = undefined;
      this.#readyTopics.add(topic);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async #ensureConsumer(consumer: string): Promise<KafkaConsumerState> {
    const name = normalizeConsumerName(consumer);
    const existing = this.#consumers.get(name);
    if (existing) return existing;

    await this.#ensureTopic(this.#topic);
    const groupId = `${this.#consumerGroup}-${kafkaGroupSuffix(name)}`;
    const state: KafkaConsumerState = {
      name,
      groupId,
      consumer: this.#kafka.consumer({ groupId }),
      queue: [],
      deliveries: new Map(),
      offsets: new Map(),
      connected: false,
      running: false,
    };
    this.#consumers.set(name, state);

    try {
      await state.consumer.connect();
      state.connected = true;
      await state.consumer.subscribe({ topic: this.#topic, fromBeginning: true });
      await state.consumer.run({
        autoCommit: false,
        eachMessage: async (payload) => {
          await this.#recordKafkaMessage(state, payload);
          await payload.heartbeat();
        },
      });
      state.running = true;
      return state;
    } catch (error) {
      this.#consumers.delete(name);
      try {
        if (state.running) await state.consumer.stop();
      } catch {
        // Best-effort cleanup; preserve the startup error for the caller.
      }
      try {
        if (state.connected) await state.consumer.disconnect();
      } catch {
        // Best-effort cleanup; preserve the startup error for the caller.
      }
      state.running = false;
      state.connected = false;
      throw error;
    }
  }

  async #recordKafkaMessage(state: KafkaConsumerState, payload: EachMessagePayload): Promise<void> {
    const event = parseKafkaEvent(payload.message.value);
    if (!event) return;
    this.#rememberEvent(event);
    rememberIdempotency(this.#idempotency, event);
    const queued: KafkaQueuedEvent = {
      event,
      topic: payload.topic,
      partition: payload.partition,
      offset: payload.message.offset,
      availableAt: event.acceptedAt,
    };
    rememberSeenOffset(state, queued);
    const existing = state.deliveries.get(event.id);
    if (existing) {
      if (existing.status === "retry" || existing.status === "pending") {
        queued.availableAt = existing.availableAt;
        existing.queued = queued;
        state.queue.push(queued);
        return;
      }
      if (existing.status === "acked" || existing.status === "dead_lettered") {
        await this.#commitTerminalOffset(state, queued);
      }
      return;
    }
    enqueueEvent(state, queued);
  }

  async #publishEvent(
    event: PlatformEventEnvelope,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    try {
      await this.#ensureProducer(this.#topic);
      await this.#producer.send({
        topic: this.#topic,
        messages: [
          {
            key: event.tenantId ?? event.id,
            value: JSON.stringify(event),
            headers: {
              "frick-event-id": event.id,
              "frick-schema-version": String(event.schemaVersion),
              ...extraHeaders,
            },
          },
        ],
      });
      this.#lastError = undefined;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  #rememberEvent(event: PlatformEventEnvelope): void {
    if (this.#retained.has(event.id)) return;
    this.#retained.set(event.id, event);
    this.#sequence = Math.max(this.#sequence, event.sequence);
  }

  async #commitTerminalOffset(
    state: KafkaConsumerState,
    queued: KafkaQueuedEvent | undefined,
  ): Promise<void> {
    if (queued?.topic === undefined || queued.partition === undefined || queued.offset === undefined) {
      return;
    }
    const progress = partitionProgress(state, queued);
    progress.terminal.add(queued.offset);
    try {
      const next = nextContiguousCommit(progress);
      if (next === undefined) return;
      await state.consumer.commitOffsets([
        {
          topic: queued.topic,
          partition: queued.partition,
          offset: next.toString(),
        },
      ]);
      progress.committedNext = next;
      for (const offset of Array.from(progress.terminal)) {
        if (BigInt(offset) < next) progress.terminal.delete(offset);
      }
      for (const offset of Array.from(progress.seen)) {
        if (BigInt(offset) < next) progress.seen.delete(offset);
      }
    } catch (error) {
      progress.terminal.delete(queued.offset);
      throw error;
    }
  }

  async #checkBrokerHealth(): Promise<boolean> {
    try {
      await this.#ensureTopic(this.#topic);
      await this.#admin.fetchTopicMetadata({ topics: [this.#topic] });
      this.#lastError = undefined;
      return true;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Kafka platform event pipeline is closed");
    }
  }
}

function enqueueEvent(state: KafkaConsumerState, queued: KafkaQueuedEvent): void {
  const existing = state.deliveries.get(queued.event.id);
  if (existing) return;
  state.deliveries.set(queued.event.id, {
    status: "pending",
    attempt: 0,
    availableAt: queued.availableAt,
    claimedAt: undefined,
    queued,
  });
  state.queue.push(queued);
}

function matchesDeliveryAttempt(
  delivery: KafkaDeliveryState,
  attempt: { attempt: number; claimedAt: string },
): boolean {
  return (
    delivery.status === "claimed" &&
    delivery.attempt === attempt.attempt &&
    delivery.claimedAt === attempt.claimedAt
  );
}

function rememberIdempotency(
  idempotency: Map<string, PlatformEventPublishReceipt>,
  event: PlatformEventEnvelope,
): void {
  if (!event.idempotencyKey) return;
  const key = idempotencyScope(event.tenantId, event.idempotencyKey);
  if (idempotency.has(key)) return;
  idempotency.set(key, receiptFromEnvelope(event, false));
}

function rememberSeenOffset(state: KafkaConsumerState, queued: KafkaQueuedEvent): void {
  if (queued.topic === undefined || queued.partition === undefined || queued.offset === undefined) {
    return;
  }
  partitionProgress(state, queued).seen.add(queued.offset);
}

function partitionProgress(
  state: KafkaConsumerState,
  queued: KafkaQueuedEvent,
): KafkaPartitionOffsets {
  const key = `${queued.topic ?? ""}\u0000${queued.partition ?? 0}`;
  let progress = state.offsets.get(key);
  if (!progress) {
    progress = {
      seen: new Set(),
      terminal: new Set(),
      committedNext: undefined,
    };
    state.offsets.set(key, progress);
  }
  return progress;
}

function nextContiguousCommit(progress: KafkaPartitionOffsets): bigint | undefined {
  let cursor = progress.committedNext ?? minSeenOffset(progress);
  if (cursor === undefined) return undefined;
  let advanced = false;
  while (progress.terminal.has(cursor.toString())) {
    cursor += 1n;
    advanced = true;
  }
  if (!advanced) return undefined;
  if (progress.committedNext !== undefined && cursor <= progress.committedNext) {
    return undefined;
  }
  return cursor;
}

function minSeenOffset(progress: KafkaPartitionOffsets): bigint | undefined {
  let min: bigint | undefined;
  for (const offset of progress.seen) {
    const value = BigInt(offset);
    if (min === undefined || value < min) min = value;
  }
  return min;
}

function parseKafkaEvent(value: Buffer | string | null): PlatformEventEnvelope | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const event = parsed as Partial<PlatformEventEnvelope>;
  const sequence = event.sequence;
  if (
    typeof event.id !== "string" ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    typeof event.acceptedAt !== "string" ||
    typeof event.occurredAt !== "string" ||
    typeof event.family !== "string" ||
    !isPlatformEventFamily(event.family) ||
    typeof event.name !== "string" ||
    typeof event.source !== "string" ||
    event.schemaVersion !== 1 ||
    !isNullableString(event.tenantId) ||
    !isNullableString(event.accountId) ||
    !isNullableString(event.subjectId) ||
    !isNullableString(event.traceId) ||
    !isNullableString(event.idempotencyKey) ||
    !isJsonObject(event.payload) ||
    !isAttributeRecord(event.attributes)
  ) {
    return undefined;
  }
  try {
    const normalized = normalizePlatformEventInput({
      family: event.family,
      name: event.name,
      source: event.source,
      ...(event.tenantId ? { tenantId: event.tenantId } : {}),
      ...(event.accountId ? { accountId: event.accountId } : {}),
      ...(event.subjectId ? { subjectId: event.subjectId } : {}),
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      occurredAt: event.occurredAt,
      payload: event.payload,
      attributes: event.attributes,
    });
    return {
      ...normalized,
      id: event.id,
      sequence,
      acceptedAt: event.acceptedAt,
    };
  } catch {
    return undefined;
  }
}

function receiptFromEnvelope(
  event: PlatformEventEnvelope,
  duplicate: boolean,
): PlatformEventPublishReceipt {
  return {
    id: event.id,
    sequence: event.sequence,
    acceptedAt: event.acceptedAt,
    duplicate,
  };
}

function normalizeConsumerName(consumer: string): string {
  const name = consumer.trim();
  if (name.length === 0) {
    throw new Error("platform event consumer name cannot be empty");
  }
  return name;
}

function clampBatchSize(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value) || value <= 0) return 100;
  return Math.min(1000, Math.floor(value));
}

function idempotencyScope(tenantId: string | null, idempotencyKey: string): string {
  return `${tenantId ?? ""}\u0000${idempotencyKey}`;
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAttributeRecord(value: unknown): value is Record<string, string | number | boolean> {
  if (!isJsonObject(value)) return false;
  return Object.values(value).every((entry) => {
    return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean";
  });
}

function kafkaGroupSuffix(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "consumer";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${safe}-${hash}`;
}
