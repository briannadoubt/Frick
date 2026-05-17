export const PLATFORM_EVENT_FAMILIES = [
  "analytics.user_event",
  "telemetry.client_error",
  "audit.dashboard_action",
  "jobs.lifecycle",
  "sync.lifecycle",
  "notifications.delivery",
  "dashboard.operator_action",
] as const;

export type PlatformEventFamily = (typeof PLATFORM_EVENT_FAMILIES)[number];

export interface PlatformEventInput {
  readonly family: PlatformEventFamily;
  readonly name: string;
  readonly source: string;
  readonly tenantId?: string;
  readonly accountId?: string;
  readonly subjectId?: string;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
  readonly occurredAt?: string;
  readonly payload?: Record<string, unknown>;
  readonly attributes?: Record<string, string | number | boolean>;
}

export interface PlatformEventEnvelope extends Required<Pick<PlatformEventInput, "family" | "name" | "source">> {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly acceptedAt: string;
  readonly occurredAt: string;
  readonly tenantId: string | null;
  readonly accountId: string | null;
  readonly subjectId: string | null;
  readonly traceId: string | null;
  readonly idempotencyKey: string | null;
  readonly payload: Record<string, unknown>;
  readonly attributes: Record<string, string | number | boolean>;
}

export interface PlatformEventPublishReceipt {
  readonly id: string;
  readonly sequence: number;
  readonly acceptedAt: string;
  readonly duplicate: boolean;
}

export interface PlatformEventDelivery {
  readonly event: PlatformEventEnvelope;
  readonly consumer: string;
  readonly attempt: number;
  readonly claimedAt: string;
}

export interface PlatformEventClaimOptions {
  readonly batchSize?: number;
  readonly availableAt?: string;
}

export interface PlatformEventRetryOptions {
  readonly error: string;
  readonly availableAt?: string;
}

export interface PlatformEventDeadLetterOptions {
  readonly error: string;
}

export interface PlatformEventHealth {
  readonly adapter: "memory" | "sqlite" | "kafka";
  readonly ok: boolean;
  readonly pending: number;
  readonly claimed: number;
  readonly deadLettered: number;
  readonly retained: number;
  readonly unclaimed: number;
  readonly consumers: readonly {
    readonly name: string;
    readonly pending: number;
    readonly claimed: number;
    readonly deadLettered: number;
    readonly lag: number;
  }[];
}

export interface PlatformEventPipeline {
  readonly adapter: PlatformEventHealth["adapter"];
  publish(input: PlatformEventInput): Promise<PlatformEventPublishReceipt>;
  claim(consumer: string, options?: PlatformEventClaimOptions): Promise<PlatformEventDelivery[]>;
  ack(consumer: string, eventId: string): Promise<void>;
  retry(consumer: string, eventId: string, options: PlatformEventRetryOptions): Promise<void>;
  deadLetter(consumer: string, eventId: string, options: PlatformEventDeadLetterOptions): Promise<void>;
  health(): Promise<PlatformEventHealth>;
  close(): Promise<void>;
}

export class PlatformEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformEventValidationError";
  }
}

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function normalizePlatformEventInput(
  input: PlatformEventInput,
  now: () => Date = () => new Date(),
): Omit<PlatformEventEnvelope, "id" | "sequence" | "acceptedAt"> {
  if (!isPlatformEventFamily(input.family)) {
    throw new PlatformEventValidationError(`Unknown platform event family ${JSON.stringify(input.family)}`);
  }
  const name = input.name.trim();
  if (!EVENT_NAME_PATTERN.test(name)) {
    throw new PlatformEventValidationError(`platform event name must match ${EVENT_NAME_PATTERN.toString()}`);
  }
  const source = input.source.trim();
  if (source.length === 0 || source.length > 120) {
    throw new PlatformEventValidationError("platform event source must be between 1 and 120 characters");
  }
  return {
    schemaVersion: 1,
    family: input.family,
    name,
    source,
    occurredAt: input.occurredAt ?? now().toISOString(),
    tenantId: input.tenantId ?? null,
    accountId: input.accountId ?? null,
    subjectId: input.subjectId ?? null,
    traceId: input.traceId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: cloneJsonObject(input.payload ?? {}),
    attributes: cloneJsonObject(input.attributes ?? {}) as Record<string, string | number | boolean>,
  };
}

export function isPlatformEventFamily(value: string): value is PlatformEventFamily {
  return (PLATFORM_EVENT_FAMILIES as readonly string[]).includes(value);
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
