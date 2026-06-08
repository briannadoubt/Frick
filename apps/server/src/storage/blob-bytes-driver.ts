import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_APP_ID } from "../app-id.js";
import type { SqlDriver } from "./sql-driver.js";

/**
 * Blob-bytes storage seam (FR-53). This mirrors the durable-storage driver
 * selector pattern (`FrickDbDriver` / `parseDbDriver` in `config.ts`, FR-21):
 * blob *metadata* always lives in SQLite, but the raw *bytes* can be served by
 * a selectable driver.
 *
 * - `sqlite` (default): bytes live in the SQLite `blob_content` table, exactly
 *   as before this seam existed. Behavior is byte-for-byte unchanged.
 * - `filesystem`: bytes live under `FRICK_BLOB_STORAGE_PATH`, in
 *   tenant-isolated, id-keyed files. Metadata still lives in SQLite.
 * - `s3` (FR-54): bytes live in an S3-compatible object store under a
 *   tenant-isolated key prefix. Metadata still lives in SQLite. The AWS SDK is
 *   an *optional* dependency, imported lazily by `createS3BlobBytesDriver`; the
 *   driver itself only depends on a tiny injected client interface
 *   ({@link S3LikeClient}) so it stays testable without real AWS.
 *
 * Every method is tenant-scoped. A driver MUST NOT let one tenant read, write,
 * or delete another tenant's bytes — the filesystem driver enforces this by
 * rooting each tenant under its own subdirectory and sanitizing identifiers
 * before they ever touch a path; the S3 driver enforces it by deriving every
 * object key from a content-addressed, per-tenant prefix.
 */
export type FrickBlobDriver = "sqlite" | "filesystem" | "s3";

export interface BlobBytesDriver {
  /**
   * Persist (or overwrite) the bytes for `(appId, tenantId, blobId)`. `appId`
   * is optional and defaults to {@link DEFAULT_APP_ID} (FR-153), so single-app
   * callers are byte-for-byte unaffected; a multi-app server's two apps storing
   * the same blob id never collide because the app partitions the bytes.
   */
  write(
    tenantId: string,
    blobId: string,
    content: Uint8Array,
    appId?: string,
  ): void | Promise<void>;
  /** Read the bytes for `(appId, tenantId, blobId)`, or `undefined` if absent. */
  read(
    tenantId: string,
    blobId: string,
    appId?: string,
  ): (Uint8Array | undefined) | Promise<Uint8Array | undefined>;
  /** Delete the bytes for `(appId, tenantId, blobId)`. No-op when absent. */
  delete(tenantId: string, blobId: string, appId?: string): void | Promise<void>;
  /** Whether bytes exist for `(appId, tenantId, blobId)`. */
  exists(tenantId: string, blobId: string, appId?: string): boolean | Promise<boolean>;
}

interface BlobContentRow {
  content: Uint8Array;
}

/**
 * Default driver. Stores blob bytes in the `blob_content` table via the async
 * {@link SqlDriver}, so it runs on both SQLite and Postgres. (Historically this
 * was SQLite-only and took a raw `DatabaseSync`; it now goes through the seam
 * like every other store — `INSERT … ON CONFLICT … DO UPDATE` is portable.)
 *
 * The `BlobBytesDriver` interface allows sync OR async returns, so synchronous
 * adapters (filesystem, S3) still satisfy it; this one is async.
 */
export class SqlBlobBytesDriver implements BlobBytesDriver {
  constructor(private readonly sql: SqlDriver) {}

  async write(
    tenantId: string,
    blobId: string,
    content: Uint8Array,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    await this.sql.run(
      `INSERT INTO blob_content (app_id, blob_id, content, updated_at, tenant_id)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (blob_id) DO UPDATE SET
            app_id = excluded.app_id,
            content = excluded.content,
            updated_at = excluded.updated_at,
            tenant_id = excluded.tenant_id`,
      [appId, blobId, Buffer.from(content), new Date().toISOString(), tenantId],
    );
  }

  async read(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<Uint8Array | undefined> {
    const row = await this.sql.get<BlobContentRow>(
      "SELECT content FROM blob_content WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
      [appId, tenantId, blobId],
    );
    return row ? Buffer.from(row.content) : undefined;
  }

  async delete(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    await this.sql.run(
      "DELETE FROM blob_content WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
      [appId, tenantId, blobId],
    );
  }

  async exists(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<boolean> {
    const row = await this.sql.get<{ ok?: number }>(
      "SELECT 1 AS ok FROM blob_content WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
      [appId, tenantId, blobId],
    );
    return Number(row?.ok ?? 0) === 1;
  }
}

export class FrickBlobStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrickBlobStorageError";
  }
}

/**
 * Filesystem driver (FR-53). Stores blob bytes under a configured root,
 * partitioned per tenant:
 *
 *   <root>/<tenantSegment>/<aa>/<blobSegment>
 *
 * where `<tenantSegment>` and `<blobSegment>` are content-addressed,
 * collision-free encodings of the tenant and blob ids and `<aa>` is a two-char
 * fan-out prefix so a single directory never accumulates an unbounded number of
 * entries. Encoding the identifiers (rather than using them raw) means an id
 * containing `/`, `..`, or other path metacharacters can never escape its
 * tenant directory — the path is a deterministic function of the id, not the id
 * itself, so cross-tenant traversal is structurally impossible.
 *
 * Metadata stays in SQLite; only the bytes live here.
 */
export class FilesystemBlobBytesDriver implements BlobBytesDriver {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    // Fail fast (FR-53): the configured root must be creatable and writable.
    // We surface the failure here, at construction, so a misconfigured
    // `filesystem` driver never starts the server in a half-broken state.
    try {
      mkdirSync(this.#root, { recursive: true });
    } catch (error) {
      throw new FrickBlobStorageError(
        `blob storage path is not creatable: ${this.#root} (${describeError(error)})`,
      );
    }
    assertDirectory(this.#root);
    assertWritable(this.#root);
  }

  write(tenantId: string, blobId: string, content: Uint8Array, appId: string = DEFAULT_APP_ID): void {
    const target = this.#pathFor(tenantId, blobId, appId);
    mkdirSync(dirnameOf(target), { recursive: true });
    // Write to a temp sibling then rename, so a concurrent reader never
    // observes a partially-written file and a crash mid-write leaves the old
    // bytes intact rather than a truncated file.
    const tmp = `${target}.${process.pid}.${randomSuffix()}.tmp`;
    try {
      writeFileSync(tmp, Buffer.from(content), { mode: 0o600 });
      renameSync(tmp, target);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort cleanup of the temp file
      }
      throw new FrickBlobStorageError(
        `failed to write blob bytes for ${blobId}: ${describeError(error)}`,
      );
    }
  }

  read(tenantId: string, blobId: string, appId: string = DEFAULT_APP_ID): Uint8Array | undefined {
    const target = this.#pathFor(tenantId, blobId, appId);
    try {
      return readFileSync(target);
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw new FrickBlobStorageError(
        `failed to read blob bytes for ${blobId}: ${describeError(error)}`,
      );
    }
  }

  delete(tenantId: string, blobId: string, appId: string = DEFAULT_APP_ID): void {
    const target = this.#pathFor(tenantId, blobId, appId);
    rmSync(target, { force: true });
  }

  exists(tenantId: string, blobId: string, appId: string = DEFAULT_APP_ID): boolean {
    const target = this.#pathFor(tenantId, blobId, appId);
    try {
      accessSync(target, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Map `(tenantId, blobId)` to an absolute on-disk path. Identifiers are
   * hashed into hex segments so the result is always confined to
   * `<root>/<tenant>/...` regardless of the characters in the input — there is
   * no way for a crafted id to climb out of its tenant directory.
   */
  #pathFor(tenantId: string, blobId: string, appId: string = DEFAULT_APP_ID): string {
    const tenantSegment = encodeSegment(tenantId);
    const blobSegment = encodeSegment(blobId);
    const fanout = blobSegment.slice(0, 2);
    // App partitioning (FR-153): non-default apps live under their own encoded
    // segment so two apps' identically-named blobs never collide on disk. The
    // `_default` app keeps the historical `<root>/<tenant>/...` layout, so
    // existing single-app deployments' on-disk paths are byte-for-byte
    // unchanged after upgrade.
    if (appId === DEFAULT_APP_ID) {
      return join(this.#root, tenantSegment, fanout, blobSegment);
    }
    return join(this.#root, encodeSegment(appId), tenantSegment, fanout, blobSegment);
  }
}

/**
 * Build the configured blob-bytes driver. SQLite is the default and needs the
 * raw `DatabaseSync` handle (the bytes driver is synchronous). The filesystem
 * driver requires a non-empty storage path and validates it (writable directory)
 * at construction.
 *
 * Accepts either a raw `DatabaseSync` or a `SqlDriver` (from which the raw
 * handle is extracted via `rawDb` when it is a `SqliteSqlDriver`).
 */
export function createBlobBytesDriver(options: {
  driver: FrickBlobDriver;
  db: SqlDriver;
  blobStoragePath?: string | undefined;
  /**
   * Pre-built S3 bytes driver. The S3 driver needs the AWS SDK, which is
   * imported asynchronously by {@link createS3BlobBytesDriver}; the store
   * constructor is synchronous and cannot await, so when `driver === "s3"` the
   * already-constructed driver is injected here (the server builds it during
   * its async `listen()` setup and threads it through `StoreOptions`).
   */
  s3Driver?: BlobBytesDriver | undefined;
}): BlobBytesDriver {
  if (options.driver === "filesystem") {
    const path = options.blobStoragePath?.trim();
    if (!path) {
      throw new FrickBlobStorageError(
        "the filesystem blob driver requires FRICK_BLOB_STORAGE_PATH to be set to a writable directory",
      );
    }
    return new FilesystemBlobBytesDriver(path);
  }
  if (options.driver === "s3") {
    if (!options.s3Driver) {
      throw new FrickBlobStorageError(
        "the s3 blob driver must be constructed via createS3BlobBytesDriver and passed " +
          "to the store as blobS3Driver (the AWS SDK is imported asynchronously)",
      );
    }
    return options.s3Driver;
  }
  // Default: store bytes in `blob_content` via the seam — works on SQLite and
  // Postgres without reaching for a raw handle.
  return new SqlBlobBytesDriver(options.db);
}

/**
 * Minimal S3-compatible client surface the {@link S3BlobBytesDriver} needs
 * (FR-54). The real `@aws-sdk/client-s3` is adapted to this shape by
 * {@link createS3BlobBytesDriver}; tests inject a fake in-memory implementation.
 * Keeping the driver behind this tiny interface (rather than the SDK's
 * command-object API) is what makes the AWS dependency optional and the driver
 * unit-testable without network access — exactly how {@link RedisClusterBus}
 * decouples from `ioredis`.
 *
 * `getObject`/`headObject` MUST signal a missing key by returning `undefined`
 * (not throwing) so the driver can map it to an absent blob.
 */
export interface S3LikeClient {
  /** Persist (or overwrite) the bytes at `key`. */
  putObject(key: string, body: Uint8Array): Promise<void>;
  /** Read the bytes at `key`, or `undefined` when the key does not exist. */
  getObject(key: string): Promise<Uint8Array | undefined>;
  /** Delete the bytes at `key`. No-op when absent. */
  deleteObject(key: string): Promise<void>;
  /** Whether an object exists at `key`. */
  headObject(key: string): Promise<boolean>;
}

/**
 * Object-storage / S3-compatible blob-bytes driver (FR-54). Stores blob bytes
 * in an S3 bucket under a tenant-isolated key prefix:
 *
 *   <prefix>/<tenantSegment>/<aa>/<blobSegment>
 *
 * where `<tenantSegment>`/`<blobSegment>` are the same content-addressed,
 * collision-free encodings the filesystem driver uses and `<aa>` is a two-char
 * fan-out. Because every key is a deterministic hash of the identifiers, an id
 * containing `/`, `..`, or other metacharacters can never address another
 * tenant's objects — cross-tenant access is structurally impossible.
 *
 * Metadata stays in SQLite; only the bytes live in object storage. The driver
 * is fully async (every method returns a Promise), which the
 * {@link BlobBytesDriver} interface permits.
 */
export class S3BlobBytesDriver implements BlobBytesDriver {
  readonly #client: S3LikeClient;
  readonly #prefix: string;

  constructor(client: S3LikeClient, options: { prefix?: string } = {}) {
    this.#client = client;
    // Normalise the optional key prefix to a single trailing-slash-free segment
    // chain so `#keyFor` can join unconditionally.
    this.#prefix = (options.prefix ?? "")
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join("/");
  }

  async write(
    tenantId: string,
    blobId: string,
    content: Uint8Array,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    try {
      await this.#client.putObject(this.#keyFor(tenantId, blobId, appId), content);
    } catch (error) {
      throw new FrickBlobStorageError(
        `failed to write blob bytes for ${blobId}: ${describeError(error)}`,
      );
    }
  }

  async read(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<Uint8Array | undefined> {
    try {
      return await this.#client.getObject(this.#keyFor(tenantId, blobId, appId));
    } catch (error) {
      throw new FrickBlobStorageError(
        `failed to read blob bytes for ${blobId}: ${describeError(error)}`,
      );
    }
  }

  async delete(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    try {
      await this.#client.deleteObject(this.#keyFor(tenantId, blobId, appId));
    } catch (error) {
      throw new FrickBlobStorageError(
        `failed to delete blob bytes for ${blobId}: ${describeError(error)}`,
      );
    }
  }

  async exists(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<boolean> {
    try {
      return await this.#client.headObject(this.#keyFor(tenantId, blobId, appId));
    } catch (error) {
      throw new FrickBlobStorageError(
        `failed to stat blob bytes for ${blobId}: ${describeError(error)}`,
      );
    }
  }

  /**
   * Map `(tenantId, blobId)` to a bucket key. Identifiers are encoded into hex
   * segments (see {@link encodeSegment}) so the key is always confined to this
   * tenant's prefix regardless of the input characters.
   */
  #keyFor(tenantId: string, blobId: string, appId: string = DEFAULT_APP_ID): string {
    const tenantSegment = encodeSegment(tenantId);
    const blobSegment = encodeSegment(blobId);
    const fanout = blobSegment.slice(0, 2);
    // App partitioning (FR-153): non-default apps get their own encoded key
    // segment so two apps' blobs never address the same object. The `_default`
    // app keeps the historical key layout — existing buckets are unchanged.
    const appSegment = appId === DEFAULT_APP_ID ? "" : encodeSegment(appId);
    const parts = [this.#prefix, appSegment, tenantSegment, fanout, blobSegment].filter(
      (part) => part.length > 0,
    );
    return parts.join("/");
  }
}

/** Configuration for {@link createS3BlobBytesDriver}. */
export interface S3BlobBytesDriverConfig {
  /** Target bucket. Required. */
  bucket: string;
  /** AWS region. Optional for S3-compatible stores that ignore it. */
  region?: string | undefined;
  /**
   * Custom endpoint for S3-compatible stores (MinIO, R2, Spaces, …). Omit for
   * real AWS S3.
   */
  endpoint?: string | undefined;
  /** Key prefix every object lives under. Optional. */
  prefix?: string | undefined;
  /**
   * Force path-style addressing (`<endpoint>/<bucket>/<key>` instead of
   * `<bucket>.<endpoint>/<key>`). Most S3-compatible stores need this; defaults
   * to true when a custom `endpoint` is set, false otherwise.
   */
  forcePathStyle?: boolean | undefined;
  /** Optional static credentials; omit to use the AWS default chain. */
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}

/**
 * Build an {@link S3BlobBytesDriver} backed by the real AWS SDK. `@aws-sdk/client-s3`
 * is imported dynamically so it stays an *optional* dependency — deployments
 * using the sqlite/filesystem drivers never load it. Mirrors
 * {@link createRedisClusterBus}'s lazy-import-of-an-optional-SDK pattern.
 */
export async function createS3BlobBytesDriver(
  config: S3BlobBytesDriverConfig,
): Promise<S3BlobBytesDriver> {
  const bucket = config.bucket?.trim();
  if (!bucket) {
    throw new FrickBlobStorageError(
      "the s3 blob driver requires FRICK_BLOB_S3_BUCKET to be set to a bucket name",
    );
  }

  let sdk: {
    S3Client: new (config: Record<string, unknown>) => S3RawClient;
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    GetObjectCommand: new (input: Record<string, unknown>) => unknown;
    DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
    HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
  };
  try {
    sdk = (await import("@aws-sdk/client-s3")) as unknown as typeof sdk;
  } catch (error) {
    throw new FrickBlobStorageError(
      `the s3 blob driver requires the optional "@aws-sdk/client-s3" dependency to be installed: ${describeError(error)}`,
    );
  }

  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } =
    sdk;
  const clientConfig: Record<string, unknown> = {};
  if (config.region) clientConfig.region = config.region;
  if (config.endpoint) clientConfig.endpoint = config.endpoint;
  clientConfig.forcePathStyle = config.forcePathStyle ?? Boolean(config.endpoint);
  if (config.accessKeyId && config.secretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }
  const raw = new S3Client(clientConfig);

  const client: S3LikeClient = {
    async putObject(key, body) {
      await raw.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    },
    async getObject(key) {
      try {
        const out = await raw.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = out?.Body as
          | { transformToByteArray?: () => Promise<Uint8Array> }
          | undefined;
        if (!body?.transformToByteArray) return undefined;
        return await body.transformToByteArray();
      } catch (error) {
        if (isS3NotFound(error)) return undefined;
        throw error;
      }
    },
    async deleteObject(key) {
      await raw.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async headObject(key) {
      try {
        await raw.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (isS3NotFound(error)) return false;
        throw error;
      }
    },
  };

  return new S3BlobBytesDriver(client, { ...(config.prefix ? { prefix: config.prefix } : {}) });
}

/** Minimal shape of the AWS `S3Client` we drive via `send(command)`. */
interface S3RawClient {
  send(command: unknown): Promise<{ Body?: unknown } | undefined>;
}

/**
 * Whether an AWS SDK error denotes a missing key. S3 surfaces this as
 * `NoSuchKey` / `NotFound` names or a 404 HTTP status; either maps to "absent".
 */
function isS3NotFound(error: unknown): boolean {
  const e = error as
    | { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
    | undefined;
  const name = e?.name ?? e?.Code;
  return (
    name === "NoSuchKey" ||
    name === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Deterministically encode an identifier into a filesystem-safe segment. We
 * keep a sanitized, length-bounded prefix of the original id for human
 * readability when browsing the store, and append a SHA-256 suffix to keep the
 * mapping collision-free and unambiguous. Crucially, the result contains only
 * `[a-z0-9_-]` and a single `.` separator, so it can never include `/` or `..`.
 */
function encodeSegment(id: string): string {
  const hash = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32);
  const readable = id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return readable ? `${readable}.${hash}` : hash;
}

function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function assertDirectory(dir: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dir);
  } catch (error) {
    throw new FrickBlobStorageError(
      `blob storage path is not accessible: ${dir} (${describeError(error)})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new FrickBlobStorageError(`blob storage path is not a directory: ${dir}`);
  }
}

function assertWritable(dir: string): void {
  try {
    accessSync(dir, fsConstants.W_OK);
  } catch (error) {
    throw new FrickBlobStorageError(
      `blob storage path is not writable: ${dir} (${describeError(error)})`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
