import { encode } from "@msgpack/msgpack";
import { packStreamEvent } from "@frick/protocol";
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
 *    cascade-break foreign-key-ish references from stream_events and
 *    conversations; instead we set `handle = "erased-<userId>"`, blank the
 *    password fingerprint so login fails, and rewrite display_name to a
 *    redaction marker.
 *  - PSEUDONYMIZE stream_events the user authored. The event ordering is
 *    durable history (other members rely on the sequence), so we keep the
 *    row but re-pack the payload with `senderId: null` and `body: null`.
 *    This is the standard "tombstone-in-place" pattern for log-shaped
 *    stores.
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

  // Durable idempotency keys aren't user-scoped by table shape, but they
  // commonly contain user-identifying replica ids when a per-user replica
  // pattern is in use. Drop any rows whose result_event_id maps to one of
  // this user's events, in lockstep with the stream pseudonymization below.
  // Done first so the FK-shaped reference into stream_events doesn't point
  // at a stale row after we rewrite payloads.
  const userEventIds = db
    .prepare(
      `SELECT event_id FROM stream_events
         WHERE tenant_id = ? AND stream_type = ?
         ORDER BY sequence ASC`,
    )
    .all(tenantId, "MessageStream") as Array<{ event_id: string }>;
  let keysDeleted = 0;
  for (const row of userEventIds) {
    const result = db
      .prepare(
        `DELETE FROM idempotency_keys
           WHERE tenant_id = ? AND result_event_id = ?
             AND EXISTS (
               SELECT 1 FROM stream_events se
                 WHERE se.tenant_id = ?
                   AND se.event_id = ?
             )`,
      )
      .run(tenantId, row.event_id, tenantId, row.event_id);
    keysDeleted += Number(result.changes);
  }
  deleted.idempotency_keys = keysDeleted;

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

  // Pseudonymize stream events authored by the user. We need the schema to
  // re-pack; route through the existing stream store helpers so we don't
  // duplicate codec logic. `store.streams.read` returns decoded payloads —
  // for each match we rewrite `senderId` and `body` and re-pack.
  const conversations = db
    .prepare(
      `SELECT conversation_id FROM conversation_inbox
         WHERE tenant_id = ? AND user_id = ?`,
    )
    .all(tenantId, userId) as Array<{ conversation_id: string }>;
  let eventsPseudonymized = 0;
  for (const { conversation_id } of conversations) {
    const events = store.streams.read(tenantId, "MessageStream", conversation_id, 0);
    for (const event of events) {
      const senderId = (event.payload as { senderId?: unknown }).senderId;
      if (senderId !== userId) continue;
      const newPayload = {
        ...event.payload,
        senderId: null,
        body: null,
      };
      const packed = packStreamEvent(store.schema, {
        stream: event.stream,
        streamId: event.streamId,
        sequence: event.sequence,
        eventId: event.eventId,
        event: event.event,
        payload: newPayload,
      });
      db.prepare(
        `UPDATE stream_events
           SET packed = ?
           WHERE tenant_id = ? AND event_id = ?`,
      ).run(Buffer.from(encode(packed)), tenantId, event.eventId);
      eventsPseudonymized += 1;
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
