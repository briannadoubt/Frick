import type { DatabaseSync } from "node:sqlite";

export interface ConversationInboxRow {
  conversationId: string;
  userId: string;
  title?: string;
  kind: string;
  lastSequence: number;
  lastMessageBody?: string;
  lastMessageAt?: string;
  lastMessageSenderId?: string;
  readSequence: number;
  unreadCount: number;
  updatedAt: string;
}

interface InboxRow {
  conversation_id: string;
  user_id: string;
  title: string | null;
  kind: string;
  last_sequence: number;
  last_message_body: string | null;
  last_message_at: string | null;
  last_message_sender_id: string | null;
  read_sequence: number;
  unread_count: number;
  updated_at: string;
}

export class InboxStore {
  constructor(private readonly db: DatabaseSync) {}

  upsert(row: ConversationInboxRow): void {
    this.db
      .prepare(
        `INSERT INTO conversation_inbox
          (
            conversation_id,
            user_id,
            title,
            kind,
            last_sequence,
            last_message_body,
            last_message_at,
            last_message_sender_id,
            read_sequence,
            unread_count,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id, user_id) DO UPDATE SET
            title = excluded.title,
            kind = excluded.kind,
            last_sequence = excluded.last_sequence,
            last_message_body = excluded.last_message_body,
            last_message_at = excluded.last_message_at,
            last_message_sender_id = excluded.last_message_sender_id,
            read_sequence = excluded.read_sequence,
            unread_count = excluded.unread_count,
            updated_at = excluded.updated_at`,
      )
      .run(
        row.conversationId,
        row.userId,
        row.title ?? null,
        row.kind,
        row.lastSequence,
        row.lastMessageBody ?? null,
        row.lastMessageAt ?? null,
        row.lastMessageSenderId ?? null,
        row.readSequence,
        row.unreadCount,
        row.updatedAt,
      );
  }

  read(conversationId: string, userId: string): ConversationInboxRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversation_inbox WHERE conversation_id = ? AND user_id = ?")
      .get(conversationId, userId) as InboxRow | undefined;
    return row ? mapInboxRow(row) : undefined;
  }

  listForUser(userId: string): ConversationInboxRow[] {
    const rows = this.db
      .prepare("SELECT * FROM conversation_inbox WHERE user_id = ? ORDER BY updated_at DESC, conversation_id ASC")
      .all(userId) as unknown as InboxRow[];
    return rows.map(mapInboxRow);
  }

  repairInvalidReadCursors(): void {
    this.db
      .prepare(
        `UPDATE conversation_inbox
          SET read_sequence = last_sequence,
              unread_count = 0,
              updated_at = ?
          WHERE read_sequence > last_sequence`,
      )
      .run(new Date().toISOString());
  }
}

function mapInboxRow(row: InboxRow): ConversationInboxRow {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    kind: row.kind,
    lastSequence: Number(row.last_sequence),
    readSequence: Number(row.read_sequence),
    unreadCount: Number(row.unread_count),
    updatedAt: row.updated_at,
    ...(row.title ? { title: row.title } : {}),
    ...(row.last_message_body ? { lastMessageBody: row.last_message_body } : {}),
    ...(row.last_message_at ? { lastMessageAt: row.last_message_at } : {}),
    ...(row.last_message_sender_id ? { lastMessageSenderId: row.last_message_sender_id } : {}),
  };
}
