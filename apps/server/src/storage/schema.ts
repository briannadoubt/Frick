import type { DatabaseSync } from "node:sqlite";

export function initializeStorage(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS schema_versions (
      schema_hash TEXT PRIMARY KEY,
      manifest BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS objects (
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      packed BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (object_type, object_id)
    );

    CREATE TABLE IF NOT EXISTS stream_events (
      stream_type TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      packed BLOB NOT NULL,
      replica_id TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (stream_type, stream_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      replica_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      result_event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (replica_id, request_id)
    );

    CREATE TABLE IF NOT EXISTS presence_leases (
      presence_type TEXT NOT NULL,
      presence_key TEXT NOT NULL,
      packed BLOB NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (presence_type, presence_key)
    );

    CREATE TABLE IF NOT EXISTS signal_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT NOT NULL,
      signal_key TEXT NOT NULL,
      packed BLOB NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blob_metadata (
      blob_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      storage_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blob_content (
      blob_id TEXT PRIMARY KEY,
      content BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (blob_id) REFERENCES blob_metadata(blob_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_inbox (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT,
      kind TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      last_message_body TEXT,
      last_message_at TEXT,
      last_message_sender_id TEXT,
      read_sequence INTEGER NOT NULL,
      unread_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS conversation_inbox_by_user
      ON conversation_inbox (user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      packed BLOB NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      replica_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS auth_sessions_by_user
      ON auth_sessions (user_id, expires_at DESC);

    CREATE TABLE IF NOT EXISTS auth_accounts (
      user_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
