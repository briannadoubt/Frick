import type { DatabaseSync } from "node:sqlite";
import { decode, encode } from "@msgpack/msgpack";
import type { PlainObject } from "@frick/protocol";

export interface StoredJob {
  id: number;
  name: string;
  value: PlainObject;
}

interface JobRow {
  id: number;
  job_type: string;
  packed: Uint8Array;
}

export class JobStore {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(tenantId: string, type: string, value: PlainObject): void {
    this.db
      .prepare(
        `INSERT INTO jobs (tenant_id, job_type, packed, status, created_at)
          VALUES (?, ?, ?, 'queued', ?)`,
      )
      .run(tenantId, type, Buffer.from(encode(value)), new Date().toISOString());
  }

  next(tenantId: string, type: string): StoredJob | undefined {
    const row = this.db
      .prepare(
        `SELECT id, job_type, packed FROM jobs
          WHERE tenant_id = ? AND job_type = ? AND status = 'queued'
          ORDER BY id ASC
          LIMIT 1`,
      )
      .get(tenantId, type) as JobRow | undefined;
    if (!row) {
      return undefined;
    }

    this.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(row.id);
    return {
      id: Number(row.id),
      name: row.job_type,
      value: decode(row.packed) as PlainObject,
    };
  }
}
