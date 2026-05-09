import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encode } from "@msgpack/msgpack";
import { foundationSchema, validateSchema, type FrickSchema, type PlainObject } from "@frick/protocol";
import { BlobStore, type BlobMetadata, type BlobMetadataInput } from "./storage/blob-store.js";
import { JobStore, type StoredJob } from "./storage/job-store.js";
import { ObjectStore } from "./storage/object-store.js";
import { PresenceStore } from "./storage/presence-store.js";
import { initializeStorage } from "./storage/schema.js";
import { SignalStore } from "./storage/signal-store.js";
import { StreamStore, type AppendInput, type StoredEvent } from "./storage/stream-store.js";

export interface StoreOptions {
  path: string;
  schema?: FrickSchema;
  seed?: boolean;
}

export class FrickStore {
  readonly schema: FrickSchema;
  readonly objects: ObjectStore;
  readonly streams: StreamStore;
  readonly presence: PresenceStore;
  readonly signals: SignalStore;
  readonly blobs: BlobStore;
  readonly jobs: JobStore;

  readonly #db: DatabaseSync;

  constructor(options: StoreOptions) {
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }

    this.schema = validateSchema(options.schema ?? foundationSchema);
    this.#db = new DatabaseSync(options.path);
    initializeStorage(this.#db);
    this.#recordSchema();

    this.objects = new ObjectStore(this.#db, this.schema);
    this.streams = new StreamStore(this.#db, this.schema);
    this.presence = new PresenceStore(this.#db, this.schema);
    this.signals = new SignalStore(this.#db, this.schema);
    this.blobs = new BlobStore(this.#db);
    this.jobs = new JobStore(this.#db);

    if (options.seed ?? true) {
      this.seedFoundation();
    }
  }

  close(): void {
    this.#db.close();
  }

  seedFoundation(): void {
    this.upsertObject("User", "user-ada", {
      displayName: "Ada Lovelace",
      avatarBlobId: undefined,
    });
    this.upsertObject("User", "user-grace", {
      displayName: "Grace Hopper",
      avatarBlobId: undefined,
    });
    this.upsertObject("Conversation", "conversation-general", {
      kind: "channel",
      title: "Foundation General",
      createdBy: "user-ada",
      lastMessageEventId: undefined,
    });
    this.upsertObject("RoomMember", "member-general-ada", {
      conversationId: "conversation-general",
      userId: "user-ada",
      role: "owner",
    });
    this.upsertObject("RoomMember", "member-general-grace", {
      conversationId: "conversation-general",
      userId: "user-grace",
      role: "member",
    });
  }

  upsertObject(type: string, id: string, value: PlainObject, version = 0): void {
    this.objects.upsert(type, id, value, version);
  }

  readObject(type: string, id: string): PlainObject | undefined {
    return this.objects.read(type, id);
  }

  listObjects(type: string): PlainObject[] {
    return this.objects.list(type);
  }

  appendEvent(input: AppendInput): StoredEvent {
    return this.streams.append(input);
  }

  readEvents(stream: string, streamId: string, after: number): StoredEvent[] {
    return this.streams.read(stream, streamId, after);
  }

  setPresence(type: string, key: string, value: PlainObject, ttlMs: number): void {
    this.presence.set(type, key, value, ttlMs);
  }

  readPresence(type: string, key: string): PlainObject | undefined {
    return this.presence.read(type, key);
  }

  clearPresence(type: string, key: string): void {
    this.presence.clear(type, key);
  }

  enqueueSignal(type: string, key: string, value: PlainObject, ttlMs = 30_000): void {
    this.signals.enqueue(type, key, value, ttlMs);
  }

  drainSignals(type: string, key: string): PlainObject[] {
    return this.signals.drain(type, key);
  }

  createBlobMetadata(metadata: BlobMetadataInput): void {
    this.blobs.create(metadata);
  }

  readBlobMetadata(blobId: string): BlobMetadata | undefined {
    return this.blobs.read(blobId);
  }

  enqueueJob(type: string, value: PlainObject): void {
    this.jobs.enqueue(type, value);
  }

  nextJob(type: string): StoredJob | undefined {
    return this.jobs.next(type);
  }

  #recordSchema(): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO schema_versions (schema_hash, manifest, created_at)
          VALUES (?, ?, ?)`,
      )
      .run(this.schema.hash, Buffer.from(encode(this.schema)), new Date().toISOString());
  }
}
