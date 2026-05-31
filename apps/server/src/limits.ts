/**
 * Bounded runtime limits for the Frick server.
 *
 * These keep memory and per-connection state from growing unbounded under
 * abusive or buggy clients. All fields have sensible defaults — most
 * callers can rely on {@link DEFAULT_FRICK_LIMITS} or pass a partial override
 * to {@link mergeLimits}.
 */
import { FrickConfigError } from "./config.js";

export interface FrickLimits {
  /** Maximum size of a parsed JSON HTTP body, in bytes. */
  maxHttpBodyBytes: number;
  /** Maximum encoded payload size for a stream append, in bytes. */
  maxStreamAppendPayloadBytes: number;
  /** Maximum byte length of an uploaded blob body. */
  maxBlobBytes: number;
  /**
   * Maximum total bytes of blob content owned by a single principal, keyed by
   * `(tenantId, ownerId)`. Enforced on upload: a new blob (or a re-upload that
   * grows an existing blob) is rejected with `blob.quotaExceeded` when it would
   * push the owner's summed `byte_length` over this cap. The default is
   * effectively unlimited ({@link Number.MAX_SAFE_INTEGER}), so existing
   * deployments keep their prior unbounded behavior until an operator opts in
   * via `FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL` or a per-tenant override.
   */
  maxBlobBytesPerPrincipal: number;
  /** Maximum number of concurrent subscriptions allowed per websocket connection. */
  maxSubscriptionsPerConnection: number;
  /** Maximum page size for stream pagination. */
  maxStreamPageSize: number;
  /** Maximum UTF-8 byte length of a POST /search q value. */
  maxSearchQueryBytes: number;
  /** Maximum number of exact-match filter fields on a POST /search request. */
  maxSearchFilterFields: number;
  /** Maximum UTF-8 byte length of each POST /search filter key. */
  maxSearchFilterKeyBytes: number;
  /** Maximum UTF-8 byte length of each POST /search filter stringified value. */
  maxSearchFilterValueBytes: number;
  /** Maximum number of unacknowledged appends queued per client. */
  maxPendingAppendsPerClient: number;
  /** Maximum bytes per inbound WebSocket frame before msgpack decode. */
  maxWebSocketFrameBytes: number;
  /** Maximum concurrently accepted WebSocket connections. */
  maxWebSocketConnections: number;
  /**
   * Maximum concurrent WebSocket connections allowed for a single
   * authenticated principal, keyed by `(tenantId, userId)`. Enforced at
   * connect/handshake independently of the global
   * {@link FrickLimits.maxWebSocketConnections} cap, so one abusive principal
   * cannot exhaust the connection budget for others. Unauthenticated
   * (pre-handshake) connections are not counted against any principal.
   */
  maxConnectionsPerPrincipal: number;
  /** Maximum bytes ws may buffer for an outbound client before the server closes it. */
  maxWebSocketOutboundBufferedBytes: number;
  /** Maximum concurrently open Server-Sent Events connections. */
  maxSseConnections: number;
  /** Maximum bytes an SSE response may buffer before the server closes it. */
  maxSseOutboundBufferedBytes: number;
  /** Maximum auth attempts per fixed window for one route + tenant + identity/IP bucket. */
  maxAuthAttemptsPerWindow: number;
  /** Fixed auth-attempt rate-limit window, in milliseconds. */
  authRateLimitWindowMs: number;
  /** Lower bound (inclusive) for presence record TTL, in seconds. */
  presenceTtlMinSeconds: number;
  /** Upper bound (inclusive) for presence record TTL, in seconds. */
  presenceTtlMaxSeconds: number;
  /** Lower bound (inclusive) for signal envelope TTL, in seconds. */
  signalTtlMinSeconds: number;
  /** Upper bound (inclusive) for signal envelope TTL, in seconds. */
  signalTtlMaxSeconds: number;
  /** How often the server sends Ping frames on an idle websocket, in seconds. */
  heartbeatIntervalSeconds: number;
  /** How long the server waits for any client frame before terminating, in seconds. */
  heartbeatTimeoutSeconds: number;
}

export const DEFAULT_FRICK_LIMITS: FrickLimits = Object.freeze({
  maxHttpBodyBytes: 5_000_000,
  maxStreamAppendPayloadBytes: 256_000,
  maxBlobBytes: 25_000_000,
  // Effectively unlimited by default — per-principal blob quota is opt-in.
  maxBlobBytesPerPrincipal: Number.MAX_SAFE_INTEGER,
  maxSubscriptionsPerConnection: 256,
  maxStreamPageSize: 500,
  maxSearchQueryBytes: 4_096,
  maxSearchFilterFields: 16,
  maxSearchFilterKeyBytes: 128,
  maxSearchFilterValueBytes: 512,
  maxPendingAppendsPerClient: 1_000,
  maxWebSocketFrameBytes: 524_288,
  maxWebSocketConnections: 10_000,
  maxConnectionsPerPrincipal: 64,
  maxWebSocketOutboundBufferedBytes: 1_048_576,
  maxSseConnections: 10_000,
  maxSseOutboundBufferedBytes: 1_048_576,
  maxAuthAttemptsPerWindow: 30,
  authRateLimitWindowMs: 300_000,
  presenceTtlMinSeconds: 5,
  presenceTtlMaxSeconds: 600,
  signalTtlMinSeconds: 1,
  signalTtlMaxSeconds: 120,
  heartbeatIntervalSeconds: 25,
  heartbeatTimeoutSeconds: 60,
}) as FrickLimits;

export function mergeLimits(overrides?: Partial<FrickLimits>): FrickLimits {
  if (!overrides) {
    return { ...DEFAULT_FRICK_LIMITS };
  }
  return { ...DEFAULT_FRICK_LIMITS, ...overrides };
}

/**
 * Read the subset of {@link FrickLimits} that is configurable via environment
 * variables. Returns only the fields whose env var is set, so callers can
 * layer explicit `createFrickServer({ limits })` overrides on top. Unset or
 * empty values are omitted (the framework default then applies).
 *
 * Values must be positive integers, matching the `FRICK_*` positive-integer
 * env convention in `config.ts`; invalid values throw {@link FrickConfigError}.
 */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<FrickLimits> {
  const overrides: Partial<FrickLimits> = {};
  const maxConnectionsPerPrincipal = parsePositiveIntegerEnv(
    env.FRICK_MAX_CONNECTIONS_PER_PRINCIPAL,
    "FRICK_MAX_CONNECTIONS_PER_PRINCIPAL",
  );
  if (maxConnectionsPerPrincipal !== undefined) {
    overrides.maxConnectionsPerPrincipal = maxConnectionsPerPrincipal;
  }
  const maxBlobBytesPerPrincipal = parsePositiveIntegerEnv(
    env.FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL,
    "FRICK_MAX_BLOB_BYTES_PER_PRINCIPAL",
  );
  if (maxBlobBytesPerPrincipal !== undefined) {
    overrides.maxBlobBytesPerPrincipal = maxBlobBytesPerPrincipal;
  }
  return overrides;
}

function parsePositiveIntegerEnv(value: string | undefined, varName: string): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new FrickConfigError(`${varName} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

/**
 * Thrown when a runtime limit is exceeded. The wire shape always uses the
 * existing {@link import("@frick/protocol").FrickErrorEnvelope} — callers
 * translate this error into the appropriate `rateLimit.exceeded`,
 * `blob.tooLarge`, `blob.quotaExceeded`, or `stream.appendRejected` envelope.
 */
export class FrickLimitError extends Error {
  readonly limit: keyof FrickLimits;
  readonly actualValue: number;
  readonly configuredMax: number;

  constructor(params: { limit: keyof FrickLimits; actualValue: number; configuredMax: number; message?: string }) {
    super(
      params.message ??
        `Limit ${params.limit} exceeded: actual=${params.actualValue} max=${params.configuredMax}`,
    );
    this.name = "FrickLimitError";
    this.limit = params.limit;
    this.actualValue = params.actualValue;
    this.configuredMax = params.configuredMax;
  }
}

/**
 * Clamp `seconds` into [min, max]. Returns the clamped value.
 * `silentClampLogger` is called when a clamp actually occurred so callers
 * can warn — pass `undefined` to skip logging.
 */
export function clampTtlSeconds(
  seconds: number,
  min: number,
  max: number,
  silentClampLogger?: (clampedFrom: number, clampedTo: number) => void,
): number {
  if (!Number.isFinite(seconds)) {
    silentClampLogger?.(seconds, max);
    return max;
  }
  if (seconds < min) {
    silentClampLogger?.(seconds, min);
    return min;
  }
  if (seconds > max) {
    silentClampLogger?.(seconds, max);
    return max;
  }
  return seconds;
}
