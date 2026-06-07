/**
 * Structured diagnostics snapshot data model (FR-76).
 *
 * A single, serializable shape that captures "what is this Frick instance
 * doing right now" for operators and SDK devtools. The hardening spec
 * (~lines 1275-1311) enumerates the surfaces a diagnostics snapshot must
 * expose; this module is the canonical TypeScript definition shared by the
 * server assembler, the CLI (`frick inspect diagnostics` / `frick doctor`),
 * and — eventually — client SDKs and a visual devtools panel.
 *
 * Design notes:
 *   - Every field is plain JSON (no class instances, no Buffers) so a snapshot
 *     round-trips through `JSON.stringify` losslessly and can travel over the
 *     wire or land on disk unchanged.
 *   - Surfaces that only exist on a *running* gateway (live connection state,
 *     active subscriptions, in-flight pending appends) are optional: a
 *     store-driven assembler (the CLI, with no HTTP server up) legitimately
 *     omits them. Consumers must treat `undefined` as "not observed here",
 *     distinct from an empty array which means "observed, and empty".
 *   - Secrets are never embedded. Recent error envelopes carry codes/messages
 *     but assemblers are responsible for redacting any sensitive payload before
 *     it reaches this shape.
 */

/** Schema identity + computed hash — the "who am I" of a diagnostics snapshot. */
export interface DiagnosticsSchemaIdentity {
  schemaId: string;
  schemaVersion: string;
  schemaRevision: number;
  schemaHash: string;
}

/**
 * Compatibility verdict between the snapshot's live schema and whatever the
 * database was last migrated to. `matched` false is the canonical
 * "schema mismatch" signal an operator debugs.
 */
export interface DiagnosticsSchemaCompatibility {
  matched: boolean;
  /** Schema revision the running instance is built against. */
  expectedRevision: number;
  /** Schema revision the database was last migrated to, if known. */
  appliedRevision?: number;
  detail?: string;
}

/** One active subscription, as tracked by a running sync gateway. */
export interface DiagnosticsSubscription {
  /** Stream or object family the subscription targets. */
  target: string;
  tenantId?: string;
  /** Connection / client id owning the subscription, when known. */
  connectionId?: string;
  /** Highest sequence delivered to this subscriber, if cursored. */
  deliveredThrough?: number;
}

/** A known stream cursor head — highest sequence + event count for a stream. */
export interface DiagnosticsCursor {
  stream: string;
  streamId: string;
  tenantId?: string;
  headSequence: number;
  count: number;
}

/** Lifecycle of an append the client has issued but not yet had acknowledged. */
export type DiagnosticsPendingAppendState = "queued" | "inflight" | "acked" | "nacked";

export interface DiagnosticsPendingAppend {
  requestId: string;
  stream: string;
  streamId?: string;
  tenantId?: string;
  state: DiagnosticsPendingAppendState;
  /** ISO timestamp the append entered its current state. */
  since?: string;
  attempts?: number;
}

/** Last ack/nack recorded for a request id. */
export interface DiagnosticsAck {
  requestId: string;
  outcome: "ack" | "nack";
  at: string;
  /** Error code when `outcome` is `nack`. */
  code?: string;
}

/**
 * A recent error envelope. Mirrors the wire error shape (code + message) but is
 * pre-redacted: no secret/PII field values, no auth tokens.
 */
export interface DiagnosticsErrorEnvelope {
  code: string;
  message: string;
  at: string;
  tenantId?: string;
  /** Free-form, already-redacted context. Never contains secrets. */
  context?: Record<string, unknown>;
}

/** WebSocket / transport connection state for a running client or gateway. */
export interface DiagnosticsConnectionState {
  status: "connected" | "connecting" | "disconnected" | "closed";
  transport?: "websocket" | "http" | "sse";
  /** Number of active connections (gateway) or reconnect attempts (client). */
  activeConnections?: number;
  reconnectAttempts?: number;
  /** ISO timestamp the current connection was established. */
  connectedSince?: string;
  lastError?: string;
}

/** Local cache metadata + size (client cache, or server idempotency cache). */
export interface DiagnosticsCacheMetadata {
  /** Logical name, e.g. `idempotency` or `clientCache`. */
  name: string;
  size: number;
  capacity?: number;
  evictions?: number;
}

/** Sync timing: when did data last move, and how fresh is this snapshot. */
export interface DiagnosticsSyncTiming {
  /** ISO timestamp the snapshot was assembled. */
  snapshotAt: string;
  /** ISO timestamp of the last successful sync / write, if observed. */
  lastSuccessfulSyncAt?: string;
  /** ISO timestamp the instance started, if known. */
  startedAt?: string;
  uptimeSeconds?: number;
}

/** Negotiated capabilities + server limits, as already modeled in capabilities.ts. */
export interface DiagnosticsCapabilities {
  transports: string[];
  encodings: string[];
  primitives: string[];
  experimental: string[];
  /** Bounded runtime limits keyed by name. */
  limits: Record<string, number>;
}

/**
 * The full diagnostics snapshot. Assembled from a running server/store; safe to
 * serialize, log (post-redaction), or ship to a devtools client.
 */
export interface DiagnosticsSnapshot {
  /** Snapshot schema version — bump when this shape changes incompatibly. */
  diagnosticsVersion: 1;
  /** Where the snapshot was taken: a store-driven CLI, or a live gateway. */
  source: "cli" | "server";
  env?: string;

  schema: DiagnosticsSchemaIdentity;
  compatibility?: DiagnosticsSchemaCompatibility;

  subscriptions?: DiagnosticsSubscription[];
  cursors?: DiagnosticsCursor[];
  pendingAppends?: DiagnosticsPendingAppend[];
  recentAcks?: DiagnosticsAck[];
  recentErrors: DiagnosticsErrorEnvelope[];

  connection?: DiagnosticsConnectionState;
  caches: DiagnosticsCacheMetadata[];
  syncTiming: DiagnosticsSyncTiming;
  capabilities?: DiagnosticsCapabilities;
}

/** The current diagnostics snapshot version, for assemblers to stamp. */
export const DIAGNOSTICS_VERSION = 1 as const;

const SECRET_KEY_PATTERN =
  /(token|password|secret|api[-_]?key|authorization|cookie|bearer|credential)/i;

/** Value substituted for a redacted error-context field. */
export const REDACTED_DIAGNOSTICS_VALUE = "<redacted>";

/**
 * Heuristic redaction for free-form error context bags. Masks values under keys
 * that look like secrets (token/password/secret/key/authorization/cookie). This
 * complements schema-driven sensitivity redaction: error context is, by
 * definition, unstructured, so a name-based pass is the pragmatic safety net.
 *
 * Returns a new object — the input is never mutated.
 */
export function redactDiagnosticsContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (context === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED_DIAGNOSTICS_VALUE : value;
  }
  return out;
}
