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
import type { DatabaseSync } from "node:sqlite";
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
 *
 * Every method is tenant-scoped. A driver MUST NOT let one tenant read, write,
 * or delete another tenant's bytes — the filesystem driver enforces this by
 * rooting each tenant under its own subdirectory and sanitizing identifiers
 * before they ever touch a path.
 */
export type FrickBlobDriver = "sqlite" | "filesystem";

export interface BlobBytesDriver {
  /** Persist (or overwrite) the bytes for `(tenantId, blobId)`. */
  write(tenantId: string, blobId: string, content: Uint8Array): void;
  /** Read the bytes for `(tenantId, blobId)`, or `undefined` if absent. */
  read(tenantId: string, blobId: string): Uint8Array | undefined;
  /** Delete the bytes for `(tenantId, blobId)`. No-op when absent. */
  delete(tenantId: string, blobId: string): void;
  /** Whether bytes exist for `(tenantId, blobId)`. */
  exists(tenantId: string, blobId: string): boolean;
}

interface BlobContentRow {
  content: Uint8Array;
}

/**
 * Default driver. Stores blob bytes in the SQLite `blob_content` table. This is
 * the historical behavior preserved verbatim: every SQL statement matches what
 * `BlobStore` issued before the seam was introduced, so the `sqlite` driver is
 * a pure refactor with no behavioral change.
 *
 * The blob-bytes driver is intentionally sync (it implements the pre-existing
 * `BlobBytesDriver` sync interface used by external filesystem and S3 adapters).
 * It receives the raw `DatabaseSync` handle so it can stay synchronous — this is
 * safe because `BlobStore` calls these methods from async contexts but the SQLite
 * driver's `async` wrappers are trivially synchronous underneath anyway.
 */
export class SqliteBlobBytesDriver implements BlobBytesDriver {
  constructor(private readonly db: DatabaseSync) {}

  write(tenantId: string, blobId: string, content: Uint8Array): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blob_content (blob_id, content, updated_at, tenant_id)
          VALUES (?, ?, ?, ?)`,
      )
      .run(blobId, Buffer.from(content), new Date().toISOString(), tenantId);
  }

  read(tenantId: string, blobId: string): Uint8Array | undefined {
    const row = this.db
      .prepare("SELECT content FROM blob_content WHERE tenant_id = ? AND blob_id = ?")
      .get(tenantId, blobId) as BlobContentRow | undefined;
    return row ? Buffer.from(row.content) : undefined;
  }

  delete(tenantId: string, blobId: string): void {
    this.db
      .prepare("DELETE FROM blob_content WHERE tenant_id = ? AND blob_id = ?")
      .run(tenantId, blobId);
  }

  exists(tenantId: string, blobId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM blob_content WHERE tenant_id = ? AND blob_id = ?")
      .get(tenantId, blobId) as { ok?: number } | undefined;
    return row?.ok === 1;
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

  write(tenantId: string, blobId: string, content: Uint8Array): void {
    const target = this.#pathFor(tenantId, blobId);
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

  read(tenantId: string, blobId: string): Uint8Array | undefined {
    const target = this.#pathFor(tenantId, blobId);
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

  delete(tenantId: string, blobId: string): void {
    const target = this.#pathFor(tenantId, blobId);
    rmSync(target, { force: true });
  }

  exists(tenantId: string, blobId: string): boolean {
    const target = this.#pathFor(tenantId, blobId);
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
  #pathFor(tenantId: string, blobId: string): string {
    const tenantSegment = encodeSegment(tenantId);
    const blobSegment = encodeSegment(blobId);
    const fanout = blobSegment.slice(0, 2);
    return join(this.#root, tenantSegment, fanout, blobSegment);
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
  db: DatabaseSync | SqlDriver;
  blobStoragePath?: string | undefined;
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
  // Unwrap SqliteSqlDriver → DatabaseSync if needed.
  const rawDb =
    options.db instanceof DatabaseSync
      ? options.db
      : (options.db as { rawDb?: DatabaseSync }).rawDb;
  if (!rawDb) {
    throw new FrickBlobStorageError(
      "SqliteBlobBytesDriver requires a DatabaseSync handle; the provided SqlDriver does not expose rawDb",
    );
  }
  return new SqliteBlobBytesDriver(rawDb);
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
