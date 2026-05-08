import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decode, encode } from "@msgpack/msgpack";
import {
  applyPackedFields,
  demoManifest,
  demoProject,
  demoTasks,
  entityByName,
  packObject,
  type FrickManifest,
  type ObjectDelta,
  type PackedField,
  type PackedObject,
  type PlainObject,
  type QuerySpec,
} from "@frick/protocol";

export interface StoreOptions {
  path: string;
  manifest?: FrickManifest;
  seed?: boolean;
}

export class FrickStore {
  readonly manifest: FrickManifest;
  #db: DatabaseSync;

  constructor(options: StoreOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.manifest = options.manifest ?? demoManifest;
    this.#db = new DatabaseSync(options.path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        entity_id INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        data BLOB NOT NULL,
        updated_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entity_id, object_id)
      );
      CREATE TABLE IF NOT EXISTS ops (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id TEXT NOT NULL UNIQUE,
        mutation TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        fields BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    if (options.seed ?? true) {
      this.seedDemo();
    }
  }

  close(): void {
    this.#db.close();
  }

  seedDemo(): void {
    this.upsertObject("Project", demoProject, 0);
    for (const task of demoTasks) {
      this.upsertObject("Task", task, 0);
    }
  }

  upsertObject(entityName: string, object: PlainObject, seq: number): void {
    const packed = packObject(this.manifest, entityName, object);
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO objects (entity_id, object_id, data, updated_seq) VALUES (?, ?, ?, ?)",
      )
      .run(packed[0], packed[1], Buffer.from(encode(packed)), seq);
  }

  query(spec: QuerySpec): PlainObject[] {
    const entity = entityByName(this.manifest, spec.entity);
    const rows = this.#db
      .prepare("SELECT data FROM objects WHERE entity_id = ? ORDER BY object_id ASC")
      .all(entity.id) as { data: Uint8Array }[];
    const objects = rows.map((row) => this.#unpackObject(row.data));

    if (spec.entity === "Task" && spec.index === "byProject") {
      return objects
        .filter((object) => object.projectId === spec.args.projectId)
        .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
    }
    if (spec.entity === "Project" && spec.index === "all") {
      return objects.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    }
    return objects;
  }

  queryPacked(spec: QuerySpec): PackedObject[] {
    return this.query(spec).map((object) => packObject(this.manifest, spec.entity, object));
  }

  applyMutation(name: string, input: Record<string, unknown>): ObjectDelta {
    if (name === "task.toggle") {
      return this.#toggleTask(input);
    }
    if (name === "task.rename") {
      return this.#renameTask(input);
    }
    if (name === "task.create") {
      return this.#createTask(input);
    }
    throw new Error(`Unknown mutation: ${name}`);
  }

  #toggleTask(input: Record<string, unknown>): ObjectDelta {
    const taskId = requireString(input.taskId, "taskId");
    const done = requireBoolean(input.done, "done");
    return this.#patchObject("task.toggle", "Task", taskId, {
      done,
      updatedAt: new Date().toISOString(),
    });
  }

  #renameTask(input: Record<string, unknown>): ObjectDelta {
    const taskId = requireString(input.taskId, "taskId");
    const title = requireString(input.title, "title");
    return this.#patchObject("task.rename", "Task", taskId, {
      title,
      updatedAt: new Date().toISOString(),
    });
  }

  #createTask(input: Record<string, unknown>): ObjectDelta {
    const projectId = requireString(input.projectId, "projectId");
    const title = requireString(input.title, "title");
    const now = new Date().toISOString();
    const task = {
      id: `task-${randomUUID()}`,
      projectId,
      tenantId: "demo-tenant",
      title,
      done: false,
      updatedAt: now,
    };
    this.upsertObject("Task", task, 0);
    return this.#patchObject("task.create", "Task", task.id, task);
  }

  #patchObject(
    mutation: string,
    entityName: string,
    objectId: string,
    patch: PlainObject,
  ): ObjectDelta {
    const entity = entityByName(this.manifest, entityName);
    const current = this.readObject(entityName, objectId);
    if (!current) {
      throw new Error(`${entityName} ${objectId} does not exist`);
    }

    const next = { ...current, ...patch, id: objectId };
    const fields = Object.entries(patch).map<PackedField>(([fieldName, value]) => {
      const field = entity.fields.find((candidate) => candidate.name === fieldName);
      if (!field) {
        throw new Error(`Unknown field ${entityName}.${fieldName}`);
      }
      return [field.id, value];
    });

    const opId = `op-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const result = this.#db
      .prepare(
        "INSERT INTO ops (op_id, mutation, entity_id, object_id, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(opId, mutation, entity.id, objectId, Buffer.from(encode(fields)), createdAt);
    const seq = Number(result.lastInsertRowid);
    this.upsertObject(entityName, next, seq);

    return {
      seq,
      opId,
      mutation,
      entityId: entity.id,
      entityName,
      objectId,
      fields,
    };
  }

  readObject(entityName: string, objectId: string): PlainObject | undefined {
    const entity = entityByName(this.manifest, entityName);
    const row = this.#db
      .prepare("SELECT data FROM objects WHERE entity_id = ? AND object_id = ?")
      .get(entity.id, objectId) as { data: Uint8Array } | undefined;
    return row ? this.#unpackObject(row.data) : undefined;
  }

  #unpackObject(data: Uint8Array): PlainObject {
    const packed = decode(data) as PackedObject;
    const [entityId, objectId, fields] = packed;
    return applyPackedFields(this.manifest, entityId, { id: objectId }, fields);
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}
