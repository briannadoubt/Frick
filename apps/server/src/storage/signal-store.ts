import { decode, encode } from "@msgpack/msgpack";
import {
  packSignalEnvelope,
  unpackSignalEnvelope,
  type FrickSchema,
  type PackedSignalEnvelope,
  type PlainObject,
} from "@fricken/protocol";
import { DEFAULT_APP_ID } from "../app-id.js";
import type { SqlDriver } from "./sql-driver.js";

interface SignalRow {
  id: number;
  packed: Uint8Array;
}

/**
 * App partitioning (FR-153): every method takes a trailing `appId` defaulting
 * to {@link DEFAULT_APP_ID}, so single-app callers are byte-for-byte
 * unaffected. enqueue() stamps `app_id`; drain() filters by it (and only
 * deletes rows it drained), so app A can neither read nor consume app B's
 * queued signals at the same (tenant, type, key).
 */
export class SignalStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly schema: FrickSchema,
  ) {}

  async enqueue(
    tenantId: string,
    type: string,
    key: string,
    value: PlainObject,
    ttlMs: number,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    const packed = packSignalEnvelope(this.schema, type, key, value);
    await this.sql.run(
      `INSERT INTO signal_outbox (app_id, tenant_id, signal_type, signal_key, packed, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      [appId, tenantId, type, key, Buffer.from(encode(packed)), Date.now() + ttlMs],
    );
  }

  async drain(
    tenantId: string,
    type: string,
    key: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<PlainObject[]> {
    // server-storage-4: read-then-delete MUST be a single atomic statement, or
    // two concurrent drains can both SELECT the same rows before either DELETEs
    // and each return the same payloads — at-least-once instead of at-most-once
    // delivery. A single `DELETE … RETURNING` reads and deletes in one statement
    // (supported by both SQLite and Postgres), so each row is claimed by exactly
    // one drain. RETURNING does not guarantee row order on either dialect, so we
    // re-impose the original `id ASC` order in JS after the fact.
    const rows = await this.sql.all<SignalRow>(
      `DELETE FROM signal_outbox
          WHERE app_id = ? AND tenant_id = ? AND signal_type = ? AND signal_key = ? AND expires_at > ?
          RETURNING id, packed`,
      [appId, tenantId, type, key, Date.now()],
    );
    if (rows.length === 0) {
      return [];
    }

    rows.sort((a, b) => Number(a.id) - Number(b.id));
    return rows.map((row) =>
      unpackSignalEnvelope(this.schema, decode(row.packed) as PackedSignalEnvelope).value,
    );
  }
}
