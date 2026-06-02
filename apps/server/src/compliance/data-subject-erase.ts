import { encode } from "@msgpack/msgpack";
import { packStreamEvent } from "@fricken/protocol";
import type { FrickStore } from "../store.js";

/**
 * Report returned by `eraseDataSubject`. Each value is the row-count for the
 * named table, so an operator can sanity-check that the erase covered the
 * expected scope. Tables not present in `deleted` or `pseudonymized` are
 * untouched (e.g. blobs aren't touched in the foundation slice — admins
 * delete blobs via the dedicated route).
 */
export interface DataSubjectEraseReport {
  tenantId: string;
  userId: string;
  performedAt: string;
  deleted: Record<string, number>;
  pseudonymized: Record<string, number>;
}

/**
 * Erase / pseudonymize a user's PII. Strategy:
 *  - DELETE the rows that exist purely to enable an active session (auth
 *    sessions, push registrations, durable idempotency keys) — these are
 *    revocable identity surface, and keeping them after a GDPR-style erase
 *    would let the user keep authenticating with stale credentials.
 *  - PSEUDONYMIZE auth_accounts in place. Replacing the row entirely would
 *    cascade-break references from app-owned rows and stream events; instead
 *    we set `handle = "erased-<userId>"`, blank the password fingerprint so
 *    login fails, and rewrite display_name to a redaction marker.
 *  - PSEUDONYMIZE stream_events whose decoded payload has `senderId` equal
 *    to the erased user. Apps that use different author fields should add an
 *    app-specific erasure hook; the framework does not infer product shapes.
 *
 * Returns a report listing the row counts touched, so an admin endpoint
 * can return it verbatim.
 */
export function eraseDataSubject(
  store: FrickStore,
  tenantId: string,
  userId: string,
): DataSubjectEraseReport {
  const db = store.db;
  const deleted: Record<string, number> = {};
  const pseudonymized: Record<string, number> = {};

  // Delete revocable identity surface.
  deleted.auth_sessions = Number(
    db
      .prepare(`DELETE FROM auth_sessions WHERE tenant_id = ? AND user_id = ?`)
      .run(tenantId, userId).changes,
  );
  deleted.push_device_registrations = Number(
    db
      .prepare(
        `DELETE FROM push_device_registrations WHERE tenant_id = ? AND user_id = ?`,
      )
      .run(tenantId, userId).changes,
  );

  const authoredEvents = store.streams
    .listAll(tenantId)
    .filter((event) => (event.payload as { senderId?: unknown }).senderId === userId);
  const authoredEventIds = authoredEvents.map((event) => event.eventId);
  const oldSearchDocs = collectProjectedSearchDocs(store, tenantId, authoredEvents);

  // Durable idempotency keys aren't directly user-scoped by table shape. Scope
  // deletion to the exact stream events authored by the erased user so another
  // participant's request history survives the erase.
  deleted.idempotency_keys = deleteIdempotencyKeysForEvents(db, tenantId, authoredEventIds);

  // Pseudonymize auth_accounts. Foundation-schema columns are
  // `password_salt` and `password_hash`; blanking the hash to a sentinel
  // means scryptSync over any password produces a different output, so
  // login can never succeed against the erased row.
  const accountUpdate = db
    .prepare(
      `UPDATE auth_accounts
         SET handle = ?,
             display_name = ?,
             password_salt = '',
             password_hash = ''
         WHERE tenant_id = ? AND user_id = ?`,
    )
    .run(`erased-${userId}`, "Erased user", tenantId, userId);
  pseudonymized.auth_accounts = Number(accountUpdate.changes);

  // Remove existing search rows before rewriting stream payloads. For the
  // default SQLite FTS adapter this deletes canonical rows, and the FTS
  // triggers remove mirrored terms. Registered external adapters also get
  // targeted deletes for projected docs below.
  deleted.search_indexes = deleteSqliteSearchRowsForErasedEvents(
    db,
    tenantId,
    userId,
    authoredEventIds,
    oldSearchDocs.map((doc) => doc.docId),
  );
  for (const doc of oldSearchDocs) {
    store.searchAdapter.delete(tenantId, doc.indexName, doc.docId);
  }

  // Pseudonymize stream events authored by the user. The decoded events above
  // carry enough schema information to re-pack each row after replacing the
  // identity-bearing fields.
  let eventsPseudonymized = 0;
  for (const event of authoredEvents) {
    const newPayload = {
      ...event.payload,
      senderId: null,
      body: null,
    };
    const rewrittenEvent = {
      stream: event.stream,
      streamId: event.streamId,
      sequence: event.sequence,
      eventId: event.eventId,
      event: event.event,
      payload: newPayload,
    };
    const packed = packStreamEvent(store.schema, rewrittenEvent);
    db.prepare(
      `UPDATE stream_events
         SET packed = ?
         WHERE tenant_id = ? AND event_id = ?`,
    ).run(Buffer.from(encode(packed)), tenantId, event.eventId);
    eventsPseudonymized += 1;

    for (const doc of collectProjectedSearchDocs(store, tenantId, [rewrittenEvent])) {
      store.searchAdapter.upsert(tenantId, doc.indexName, {
        docId: doc.docId,
        text: doc.text,
        ...(doc.fields !== undefined ? { fields: doc.fields } : {}),
      });
    }
  }
  pseudonymized.stream_events = eventsPseudonymized;

  return {
    tenantId,
    userId,
    performedAt: new Date().toISOString(),
    deleted,
    pseudonymized,
  };
}

type EraseSearchEvent = {
  stream: string;
  streamId: string;
  sequence: number;
  eventId: string;
  event: string;
  payload: Record<string, unknown>;
};

interface ProjectedSearchDoc {
  indexName: string;
  docId: string;
  text: string;
  fields?: Record<string, string | number>;
}

function collectProjectedSearchDocs(
  store: FrickStore,
  tenantId: string,
  events: EraseSearchEvent[],
): ProjectedSearchDoc[] {
  const docs: ProjectedSearchDoc[] = [];
  for (const event of events) {
    for (const def of store.searchIndexes.list()) {
      if (def.source.kind !== "stream" || def.source.type !== event.stream) continue;
      const doc = def.project({
        tenantId,
        streamEvent: event,
      });
      if (!doc) continue;
      docs.push({
        indexName: def.name,
        docId: doc.docId,
        text: doc.text,
        ...(doc.fields !== undefined ? { fields: doc.fields } : {}),
      });
    }
  }
  return docs;
}

function deleteIdempotencyKeysForEvents(
  db: ReturnType<FrickStore["rawDatabase"]>,
  tenantId: string,
  eventIds: string[],
): number {
  if (eventIds.length === 0) return 0;
  const placeholders = eventIds.map(() => "?").join(", ");
  const result = db
    .prepare(
      `DELETE FROM idempotency_keys
         WHERE tenant_id = ?
           AND result_event_id IN (${placeholders})`,
    )
    .run(tenantId, ...eventIds);
  return Number(result.changes);
}

function deleteSqliteSearchRowsForErasedEvents(
  db: ReturnType<FrickStore["rawDatabase"]>,
  tenantId: string,
  userId: string,
  eventIds: string[],
  projectedDocIds: string[],
): number {
  if (!tableExists(db, "search_indexes")) return 0;
  const docIds = Array.from(new Set([...eventIds, ...projectedDocIds]));
  const clauses = [`json_extract(fields, '$.senderId') = ?`];
  const params: Array<string> = [userId];
  if (docIds.length > 0) {
    clauses.push(`doc_id IN (${docIds.map(() => "?").join(", ")})`);
    params.push(...docIds);
  }
  const result = db
    .prepare(
      `DELETE FROM search_indexes
         WHERE tenant_id = ?
           AND (${clauses.join(" OR ")})`,
    )
    .run(tenantId, ...params);
  return Number(result.changes);
}

function tableExists(db: ReturnType<FrickStore["rawDatabase"]>, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok?: number } | undefined;
  return row?.ok === 1;
}
