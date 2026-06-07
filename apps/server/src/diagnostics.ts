/**
 * Server-side diagnostics snapshot assembler (FR-76).
 *
 * Turns a live {@link FrickStore} (and optional runtime metadata supplied by a
 * running gateway) into the shared {@link DiagnosticsSnapshot} shape defined in
 * `@fricken/protocol`. This is the single place that knows how to read each
 * diagnostics surface out of the store; both the CLI (`frick inspect
 * diagnostics` / `frick doctor`) and the server's inspection endpoint consume
 * it so their output never drifts.
 *
 * The store-driven path is the lowest common denominator: schema identity,
 * schema/migration compatibility, idempotency cache metadata, recent error
 * envelopes (from the DevTools event feed), and capabilities/limits. Surfaces
 * that only exist on a running sync gateway — live connection state, active
 * subscriptions, in-flight pending appends — are passed in via `runtime` and
 * left `undefined` when absent.
 *
 * Redaction: recent error envelopes are derived from the DevTools event feed,
 * whose `fields` bags are operator-authored and could in principle carry a
 * stray token. Every envelope's context is run through
 * `redactDiagnosticsContext` before it lands in the snapshot.
 */
import {
  DIAGNOSTICS_VERSION,
  redactDiagnosticsContext,
  type DiagnosticsCapabilities,
  type DiagnosticsConnectionState,
  type DiagnosticsCursor,
  type DiagnosticsErrorEnvelope,
  type DiagnosticsPendingAppend,
  type DiagnosticsSchemaCompatibility,
  type DiagnosticsSnapshot,
  type DiagnosticsSubscription,
} from "@fricken/protocol";
import type { FrickStore } from "./store.js";

/** A specific stream cursor the caller wants probed into the snapshot. */
export interface DiagnosticsCursorProbe {
  tenantId?: string;
  stream: string;
  streamId: string;
}

/**
 * Runtime surfaces only a live gateway can observe. The store-driven CLI passes
 * none of these; the HTTP inspection endpoint can pass live connection/sub
 * state assembled from the gateway.
 */
export interface DiagnosticsRuntime {
  source?: "cli" | "server";
  startedAt?: string;
  uptimeSeconds?: number;
  lastSuccessfulSyncAt?: string;
  connection?: DiagnosticsConnectionState;
  subscriptions?: DiagnosticsSubscription[];
  pendingAppends?: DiagnosticsPendingAppend[];
  capabilities?: DiagnosticsCapabilities;
}

export interface AssembleDiagnosticsOptions {
  env?: string;
  /** Max recent error envelopes to surface. Default 20. */
  recentErrorLimit?: number;
  /** Specific cursors to probe (the store can't cheaply enumerate every stream). */
  cursors?: DiagnosticsCursorProbe[];
  runtime?: DiagnosticsRuntime;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

/** DevTools event kinds (or status codes) that count as an error for diagnostics. */
function isErrorEvent(kind: string, fields: Record<string, unknown>): boolean {
  if (/(\.failed|\.dead_lettered|\.error|\.rejected|\.denied|\.refused)$/.test(kind)) return true;
  if (kind === "http.request") {
    const status = Number(fields.status);
    return Number.isFinite(status) && status >= 400;
  }
  return false;
}

function errorCodeFor(kind: string, fields: Record<string, unknown>): string {
  if (typeof fields.errorCode === "string") return fields.errorCode;
  if (kind === "http.request") {
    const status = Number(fields.status);
    return Number.isFinite(status) ? `http.${status}` : kind;
  }
  return kind;
}

function errorMessageFor(kind: string, fields: Record<string, unknown>): string {
  if (typeof fields.message === "string") return fields.message;
  if (kind === "http.request") {
    const method = typeof fields.method === "string" ? fields.method : "";
    const path = typeof fields.path === "string" ? fields.path : "";
    return `${method} ${path}`.trim() || kind;
  }
  return kind;
}

/**
 * Assemble a {@link DiagnosticsSnapshot} from a running store. Async because
 * migration/cursor/error reads go through the {@link SqlDriver} seam.
 */
export async function assembleDiagnosticsSnapshot(
  store: FrickStore,
  options: AssembleDiagnosticsOptions = {},
): Promise<DiagnosticsSnapshot> {
  const now = options.now ?? (() => new Date());
  const snapshotAt = now().toISOString();
  const runtime = options.runtime ?? {};
  const source = runtime.source ?? "cli";

  const schema = store.schema;

  // Schema/migration compatibility: compare the running revision against the
  // newest applied migration. Missing/empty ledger => unmatched.
  let compatibility: DiagnosticsSchemaCompatibility;
  try {
    const applied = await store.listAppliedMigrations();
    const last = applied[applied.length - 1];
    const appliedRevision = last?.schemaRevision;
    compatibility = {
      matched: appliedRevision === schema.schemaRevision,
      expectedRevision: schema.schemaRevision,
      ...(appliedRevision !== undefined ? { appliedRevision } : {}),
      ...(appliedRevision === undefined
        ? { detail: "no applied migrations recorded" }
        : appliedRevision !== schema.schemaRevision
          ? { detail: `database at revision ${appliedRevision}, instance expects ${schema.schemaRevision}` }
          : {}),
    };
  } catch (error) {
    compatibility = {
      matched: false,
      expectedRevision: schema.schemaRevision,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // Cursors: only the stream heads the caller explicitly asked for.
  const cursors: DiagnosticsCursor[] = [];
  for (const probe of options.cursors ?? []) {
    try {
      const head = await store.streamHead(probe.tenantId ?? "_default", probe.stream, probe.streamId);
      cursors.push({
        stream: probe.stream,
        streamId: probe.streamId,
        ...(probe.tenantId !== undefined ? { tenantId: probe.tenantId } : {}),
        headSequence: head.headSequence,
        count: head.count,
      });
    } catch {
      // A probe for a nonexistent stream simply contributes no cursor.
    }
  }

  // Recent error envelopes from the DevTools feed, redacted.
  const recentErrors: DiagnosticsErrorEnvelope[] = [];
  const errorLimit = options.recentErrorLimit ?? 20;
  try {
    // Over-fetch and filter: the feed mixes successful + error events.
    const rows = await store.devtoolsEvents.list({ limit: Math.max(errorLimit * 5, errorLimit) });
    for (const row of rows) {
      if (recentErrors.length >= errorLimit) break;
      if (!isErrorEvent(row.kind, row.fields)) continue;
      const context = redactDiagnosticsContext(row.fields);
      recentErrors.push({
        code: errorCodeFor(row.kind, row.fields),
        message: errorMessageFor(row.kind, row.fields),
        at: row.occurredAt,
        ...(row.tenantId ? { tenantId: row.tenantId } : {}),
        ...(context !== undefined ? { context } : {}),
      });
    }
  } catch {
    // No DevTools feed (e.g. table missing) => no recent errors surfaced.
  }

  const snapshot: DiagnosticsSnapshot = {
    diagnosticsVersion: DIAGNOSTICS_VERSION,
    source,
    ...(options.env !== undefined ? { env: options.env } : {}),
    schema: {
      schemaId: schema.schemaId,
      schemaVersion: schema.schemaVersion,
      schemaRevision: schema.schemaRevision,
      schemaHash: schema.hash,
    },
    compatibility,
    cursors,
    recentErrors,
    caches: [
      {
        name: "idempotency",
        size: store.idempotencyCache.size,
        capacity: store.idempotencyCache.capacity,
        evictions: store.idempotencyCache.evictions,
      },
    ],
    syncTiming: {
      snapshotAt,
      ...(runtime.lastSuccessfulSyncAt !== undefined
        ? { lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt }
        : {}),
      ...(runtime.startedAt !== undefined ? { startedAt: runtime.startedAt } : {}),
      ...(runtime.uptimeSeconds !== undefined ? { uptimeSeconds: runtime.uptimeSeconds } : {}),
    },
    ...(runtime.subscriptions !== undefined ? { subscriptions: runtime.subscriptions } : {}),
    ...(runtime.pendingAppends !== undefined ? { pendingAppends: runtime.pendingAppends } : {}),
    ...(runtime.connection !== undefined ? { connection: runtime.connection } : {}),
    ...(runtime.capabilities !== undefined ? { capabilities: runtime.capabilities } : {}),
  };

  return snapshot;
}
