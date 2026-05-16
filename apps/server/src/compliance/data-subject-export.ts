import type { FrickStore } from "../store.js";

/**
 * GDPR-style "export everything we know about this user" payload. Shape is
 * intentionally a single JSON document so an operator can hand it to a data-
 * subject request handler as-is. Blob content is excluded — only metadata is
 * returned here, and the blob bytes themselves stay behind the existing
 * `/blobs/:id/content` route so operators can verify before transmitting.
 */
export interface DataSubjectExport {
  tenantId: string;
  userId: string;
  generatedAt: string;
  account: Record<string, unknown> | null;
  sessions: Array<Record<string, unknown>>;
  conversations: Array<{ conversationId: string; role: string }>;
  messages: Array<Record<string, unknown>>;
  pushRegistrations: Array<Record<string, unknown>>;
  inbox: Array<Record<string, unknown>>;
  blobs: Array<Record<string, unknown>>;
}

/**
 * Walk every table that may store data about `userId` within `tenantId` and
 * return a single export document. Implementation is deliberately read-only;
 * the only mutation path is `eraseDataSubject` in the sibling file.
 */
export function exportDataSubject(
  store: FrickStore,
  tenantId: string,
  userId: string,
): DataSubjectExport {
  const db = store.db;

  const account = db
    .prepare(
      `SELECT user_id, tenant_id, handle, display_name, created_at
         FROM auth_accounts WHERE tenant_id = ? AND user_id = ?`,
    )
    .get(tenantId, userId) as Record<string, unknown> | undefined;

  const sessions = db
    .prepare(
      `SELECT user_id, device_id, replica_id, expires_at, created_at, last_seen_at
         FROM auth_sessions WHERE tenant_id = ? AND user_id = ?
         ORDER BY created_at ASC`,
    )
    .all(tenantId, userId) as Array<Record<string, unknown>>;

  const pushRegistrations = db
    .prepare(
      `SELECT registration_id, device_id, platform, environment, created_at, last_seen_at, revoked_at
         FROM push_device_registrations WHERE tenant_id = ? AND user_id = ?
         ORDER BY created_at ASC`,
    )
    .all(tenantId, userId) as Array<Record<string, unknown>>;

  const inbox = db
    .prepare(
      `SELECT conversation_id, title, kind, last_sequence, last_message_at,
              read_sequence, unread_count, updated_at
         FROM conversation_inbox WHERE tenant_id = ? AND user_id = ?
         ORDER BY updated_at DESC`,
    )
    .all(tenantId, userId) as Array<Record<string, unknown>>;

  const blobs = db
    .prepare(
      `SELECT blob_id, content_hash, byte_length, mime_type, storage_key, created_at
         FROM blob_metadata WHERE tenant_id = ? AND owner_id = ?
         ORDER BY created_at ASC`,
    )
    .all(tenantId, userId) as Array<Record<string, unknown>>;

  // Conversations: derive membership from inbox rows. Inbox is the
  // membership-of-record for messaging — every member has an inbox row
  // keyed on (tenant, conversation, user). Role is implicit "member" here;
  // foundation schema doesn't carry per-user roles in inbox, and a future
  // slice can join Conversation object fields in if richer roles land.
  const conversations = inbox.map((row) => ({
    conversationId: String((row as { conversation_id: string }).conversation_id),
    role: "member",
  }));

  // Messages: walk each conversation the user is in (bounded by their inbox
  // rows) and keep events whose decoded payload's `senderId` matches.
  // Going through `store.streams.read` instead of raw SQL means the schema-
  // aware msgpack unpacker handles payload decoding for us.
  const messages: Array<Record<string, unknown>> = [];
  for (const row of inbox) {
    const conversationId = String((row as { conversation_id: string }).conversation_id);
    const events = store.streams.read(tenantId, "MessageStream", conversationId, 0);
    for (const event of events) {
      const senderId = (event.payload as { senderId?: unknown }).senderId;
      if (senderId !== userId) continue;
      messages.push({
        streamType: event.stream,
        streamId: event.streamId,
        sequence: event.sequence,
        eventId: event.eventId,
        event: event.event,
        payload: event.payload,
      });
    }
  }

  return {
    tenantId,
    userId,
    generatedAt: new Date().toISOString(),
    account: account ?? null,
    sessions,
    conversations,
    messages,
    pushRegistrations,
    inbox,
    blobs,
  };
}
