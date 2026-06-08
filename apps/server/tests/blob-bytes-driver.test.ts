import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FilesystemBlobBytesDriver,
  FrickBlobStorageError,
  S3BlobBytesDriver,
  SqlBlobBytesDriver,
  createBlobBytesDriver,
  type S3LikeClient,
} from "../src/storage/blob-bytes-driver.js";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { FrickStore } from "../src/store.js";
import { loadFrickConfig } from "../src/config.js";

const HELLO = new TextEncoder().encode("hello blob");
const WORLD = new TextEncoder().encode("world blob");

/**
 * Normalise a driver/store read result to a plain `Uint8Array` so byte-content
 * assertions don't trip over the `Buffer` vs `Uint8Array` distinction `toEqual`
 * draws (the s3 path returns a plain `Uint8Array`, like the real AWS SDK's
 * `transformToByteArray()`; the filesystem/SQLite paths return `Buffer`).
 */
function asBytes(value: Uint8Array | undefined): Uint8Array | undefined {
  return value === undefined ? undefined : new Uint8Array(value);
}

describe("FilesystemBlobBytesDriver", () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "frick-blobs-"));
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips bytes (write/read/exists/delete)", async () => {
    const driver = new FilesystemBlobBytesDriver(root);

    expect(driver.exists("tenant-a", "blob-1")).toBe(false);
    expect(driver.read("tenant-a", "blob-1")).toBeUndefined();

    driver.write("tenant-a", "blob-1", HELLO);
    expect(driver.exists("tenant-a", "blob-1")).toBe(true);
    expect(driver.read("tenant-a", "blob-1")).toEqual(Buffer.from(HELLO));

    driver.delete("tenant-a", "blob-1");
    expect(driver.exists("tenant-a", "blob-1")).toBe(false);
    expect(driver.read("tenant-a", "blob-1")).toBeUndefined();
  });

  it("overwrites existing bytes for the same id", async () => {
    const driver = new FilesystemBlobBytesDriver(root);
    driver.write("tenant-a", "blob-1", HELLO);
    driver.write("tenant-a", "blob-1", WORLD);
    expect(driver.read("tenant-a", "blob-1")).toEqual(Buffer.from(WORLD));
  });

  it("delete on a missing blob is a no-op", async () => {
    const driver = new FilesystemBlobBytesDriver(root);
    expect(() => driver.delete("tenant-a", "missing")).not.toThrow();
  });

  it("isolates tenants — one tenant cannot read another's bytes", async () => {
    const driver = new FilesystemBlobBytesDriver(root);
    // Same blobId in two different tenants must not collide or leak.
    driver.write("tenant-a", "shared-id", HELLO);
    driver.write("tenant-b", "shared-id", WORLD);

    expect(driver.read("tenant-a", "shared-id")).toEqual(Buffer.from(HELLO));
    expect(driver.read("tenant-b", "shared-id")).toEqual(Buffer.from(WORLD));

    // tenant-b's blob is invisible to tenant-c, and a tenant only sees its own.
    expect(driver.read("tenant-c", "shared-id")).toBeUndefined();
    expect(driver.exists("tenant-c", "shared-id")).toBe(false);

    // Deleting one tenant's copy leaves the other intact.
    driver.delete("tenant-a", "shared-id");
    expect(driver.exists("tenant-a", "shared-id")).toBe(false);
    expect(driver.read("tenant-b", "shared-id")).toEqual(Buffer.from(WORLD));
  });

  it("confines a path-traversal-shaped id to the storage root", async () => {
    const driver = new FilesystemBlobBytesDriver(root);
    // A blobId crafted to escape the tenant dir must stay confined; bytes are
    // recoverable only via the same (tenantId, blobId) pair, and nothing is
    // written outside the configured root.
    //
    // The naive escape target depends on where the OS hands us a temp root:
    // on a Linux runner `<tmp>/frick-blobs-*/../../etc/passwd` resolves to the
    // real `/etc/passwd`, which already exists, so a bare `existsSync(...) ===
    // false` check is environment-dependent (green on macOS, red on Linux).
    // Snapshot the target instead and assert the write neither *creates* nor
    // *modifies* it — that is the real confinement property, and it holds
    // regardless of the tmp layout.
    const escapeTarget = join(root, "..", "..", "etc", "passwd");
    const before = existsSync(escapeTarget) ? readFileSync(escapeTarget) : undefined;

    driver.write("tenant-a", "../../etc/passwd", HELLO);
    expect(driver.read("tenant-a", "../../etc/passwd")).toEqual(Buffer.from(HELLO));

    const after = existsSync(escapeTarget) ? readFileSync(escapeTarget) : undefined;
    expect(after).toEqual(before);
    // Everything written lives under the root.
    expect(readdirSync(root).length).toBeGreaterThan(0);
  });

  it("fails fast when the storage path is not a writable directory", async () => {
    // Create a regular file, then point the driver root *inside* that file's
    // path. mkdir can't create a directory beneath a file (ENOTDIR), so
    // construction must throw rather than start broken.
    const blocker = join(root, "blocker-file");
    writeFileSync(blocker, "not a directory");
    expect(() => new FilesystemBlobBytesDriver(join(blocker, "nested"))).toThrow(
      FrickBlobStorageError,
    );
  });
});

describe("createBlobBytesDriver", () => {
  let root: string;
  let db: SqliteSqlDriver;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "frick-blobs-factory-"));
    db = new SqliteSqlDriver(new DatabaseSync(":memory:"));
  });

  afterEach(async () => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults to the seam-backed sql driver", async () => {
    const driver = createBlobBytesDriver({ driver: "sqlite", db });
    expect(driver).toBeInstanceOf(SqlBlobBytesDriver);
  });

  it("builds the filesystem driver when a path is provided", async () => {
    const driver = createBlobBytesDriver({
      driver: "filesystem",
      db,
      blobStoragePath: root,
    });
    expect(driver).toBeInstanceOf(FilesystemBlobBytesDriver);
  });

  it("fails clearly when filesystem is selected without a path", async () => {
    expect(() => createBlobBytesDriver({ driver: "filesystem", db })).toThrow(
      /requires FRICK_BLOB_STORAGE_PATH/,
    );
    expect(() =>
      createBlobBytesDriver({ driver: "filesystem", db, blobStoragePath: "   " }),
    ).toThrow(FrickBlobStorageError);
  });
});

describe("FrickStore blob driver wiring", () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "frick-blobs-store-"));
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it("default sqlite driver keeps blob bytes in SQLite (behavior unchanged)", async () => {
    const store = new FrickStore({ path: ":memory:" });
    try {
      await store.blobs.create("tenant-a", {
        blobId: "blob-1",
        ownerId: "user-1",
        contentHash: "hash",
        byteLength: HELLO.byteLength,
        mimeType: "text/plain",
      });
      await store.blobs.writeContent("tenant-a", "blob-1", HELLO);

      expect(await store.blobs.readContent("tenant-a", "blob-1")).toEqual(Buffer.from(HELLO));
      // No files are written to disk under the default driver.
      expect(readdirSync(root).length).toBe(0);

      // Bytes physically live in the SQLite blob_content table.
      const row = store
        .rawDatabase()
        .prepare("SELECT content FROM blob_content WHERE tenant_id = ? AND blob_id = ?")
        .get("tenant-a", "blob-1") as { content: Uint8Array } | undefined;
      expect(row).toBeDefined();
      expect(Buffer.from(row!.content)).toEqual(Buffer.from(HELLO));
    } finally {
      store.close();
    }
  });

  it("filesystem driver moves bytes to disk and keeps metadata in SQLite", async () => {
    const store = new FrickStore({
      path: ":memory:",
      blobDriver: "filesystem",
      blobStoragePath: root,
    });
    try {
      await store.blobs.create("tenant-a", {
        blobId: "blob-1",
        ownerId: "user-1",
        contentHash: "hash",
        byteLength: HELLO.byteLength,
        mimeType: "text/plain",
      });
      await store.blobs.writeContent("tenant-a", "blob-1", HELLO);

      // Bytes round-trip via the store facade.
      expect(await store.blobs.readContent("tenant-a", "blob-1")).toEqual(Buffer.from(HELLO));
      // Bytes are on disk, not in SQLite.
      expect(readdirSync(root).length).toBeGreaterThan(0);
      const row = store
        .rawDatabase()
        .prepare("SELECT content FROM blob_content WHERE tenant_id = ? AND blob_id = ?")
        .get("tenant-a", "blob-1");
      expect(row).toBeUndefined();
      // Metadata still lives in SQLite.
      expect((await store.blobs.read("tenant-a", "blob-1"))?.mimeType).toBe("text/plain");
    } finally {
      store.close();
    }
  });

  it("filesystem driver isolates tenants through the store facade", async () => {
    const store = new FrickStore({
      path: ":memory:",
      blobDriver: "filesystem",
      blobStoragePath: root,
    });
    try {
      await store.blobs.writeContent("tenant-a", "shared", HELLO);
      await store.blobs.writeContent("tenant-b", "shared", WORLD);
      expect(await store.blobs.readContent("tenant-a", "shared")).toEqual(Buffer.from(HELLO));
      expect(await store.blobs.readContent("tenant-b", "shared")).toEqual(Buffer.from(WORLD));
      expect(await store.blobs.readContent("tenant-c", "shared")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("loadFrickConfig blob driver", () => {
  it("defaults the blob driver to sqlite", async () => {
    const config = loadFrickConfig({}, { env: {}, warn: () => {} });
    expect(config.blobDriver).toBe("sqlite");
  });

  it("parses FRICK_BLOB_DRIVER=filesystem with a storage path", async () => {
    const config = loadFrickConfig(
      {},
      {
        env: {
          FRICK_BLOB_DRIVER: "filesystem",
          FRICK_BLOB_STORAGE_PATH: "/tmp/frick-blobs",
        },
        warn: () => {},
      },
    );
    expect(config.blobDriver).toBe("filesystem");
    expect(config.blobStoragePath).toBe("/tmp/frick-blobs");
  });

  it("rejects an invalid blob driver value", async () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_BLOB_DRIVER: "gcs" }, warn: () => {} }),
    ).toThrow(/FRICK_BLOB_DRIVER must be one of sqlite, filesystem, s3/);
  });

  it("fails fast when filesystem is selected without a path", async () => {
    expect(() =>
      loadFrickConfig(
        { blobStoragePath: "   " },
        { env: { FRICK_BLOB_DRIVER: "filesystem" }, warn: () => {} },
      ),
    ).toThrow(/FRICK_BLOB_DRIVER=filesystem requires FRICK_BLOB_STORAGE_PATH/);
  });

  it("parses FRICK_BLOB_DRIVER=s3 with bucket/region/endpoint/prefix", async () => {
    const config = loadFrickConfig(
      {},
      {
        env: {
          FRICK_BLOB_DRIVER: "s3",
          FRICK_BLOB_S3_BUCKET: "frick-blobs",
          FRICK_BLOB_S3_REGION: "us-east-1",
          FRICK_BLOB_S3_ENDPOINT: "https://minio.local",
          FRICK_BLOB_S3_PREFIX: "blobs/",
        },
        warn: () => {},
      },
    );
    expect(config.blobDriver).toBe("s3");
    expect(config.blobS3Bucket).toBe("frick-blobs");
    expect(config.blobS3Region).toBe("us-east-1");
    expect(config.blobS3Endpoint).toBe("https://minio.local");
    expect(config.blobS3Prefix).toBe("blobs/");
  });

  it("fails fast when s3 is selected without a bucket", async () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_BLOB_DRIVER: "s3" }, warn: () => {} }),
    ).toThrow(/FRICK_BLOB_DRIVER=s3 requires FRICK_BLOB_S3_BUCKET/);
  });
});

/**
 * Fake in-memory S3 client implementing {@link S3LikeClient}. Proves the
 * S3 driver round-trips bytes, isolates tenants, and maps missing keys to
 * `undefined`/`false` — all without touching real AWS. `headObject` and
 * `getObject` model real S3 by returning "absent" rather than throwing.
 */
class FakeS3Client implements S3LikeClient {
  readonly store = new Map<string, Uint8Array>();
  /** Records every key touched, so tests can assert on prefixing/isolation. */
  readonly keysSeen = new Set<string>();

  async putObject(key: string, body: Uint8Array): Promise<void> {
    this.keysSeen.add(key);
    // Copy so a later mutation of the caller's buffer can't corrupt our store.
    this.store.set(key, Uint8Array.from(body));
  }

  async getObject(key: string): Promise<Uint8Array | undefined> {
    this.keysSeen.add(key);
    const bytes = this.store.get(key);
    return bytes ? Uint8Array.from(bytes) : undefined;
  }

  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }

  async headObject(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}

describe("S3BlobBytesDriver", () => {
  it("round-trips bytes (write/read/exists/delete)", async () => {
    const client = new FakeS3Client();
    const driver = new S3BlobBytesDriver(client);

    expect(await driver.exists("tenant-a", "blob-1")).toBe(false);
    expect(await driver.read("tenant-a", "blob-1")).toBeUndefined();

    await driver.write("tenant-a", "blob-1", HELLO);
    expect(await driver.exists("tenant-a", "blob-1")).toBe(true);
    expect(asBytes(await driver.read("tenant-a", "blob-1"))).toEqual(HELLO);

    await driver.delete("tenant-a", "blob-1");
    expect(await driver.exists("tenant-a", "blob-1")).toBe(false);
    expect(await driver.read("tenant-a", "blob-1")).toBeUndefined();
  });

  it("overwrites existing bytes for the same id", async () => {
    const driver = new S3BlobBytesDriver(new FakeS3Client());
    await driver.write("tenant-a", "blob-1", HELLO);
    await driver.write("tenant-a", "blob-1", WORLD);
    expect(asBytes(await driver.read("tenant-a", "blob-1"))).toEqual(WORLD);
  });

  it("returns undefined for a missing key (no throw)", async () => {
    const driver = new S3BlobBytesDriver(new FakeS3Client());
    expect(await driver.read("tenant-a", "never-written")).toBeUndefined();
    expect(await driver.exists("tenant-a", "never-written")).toBe(false);
    // delete on a missing key is a no-op
    await expect(driver.delete("tenant-a", "never-written")).resolves.toBeUndefined();
  });

  it("isolates tenants — one tenant cannot read another's bytes", async () => {
    const driver = new S3BlobBytesDriver(new FakeS3Client());
    await driver.write("tenant-a", "shared-id", HELLO);
    await driver.write("tenant-b", "shared-id", WORLD);

    expect(asBytes(await driver.read("tenant-a", "shared-id"))).toEqual(HELLO);
    expect(asBytes(await driver.read("tenant-b", "shared-id"))).toEqual(WORLD);
    expect(await driver.read("tenant-c", "shared-id")).toBeUndefined();
    expect(await driver.exists("tenant-c", "shared-id")).toBe(false);

    // Deleting one tenant's copy leaves the other intact.
    await driver.delete("tenant-a", "shared-id");
    expect(await driver.exists("tenant-a", "shared-id")).toBe(false);
    expect(asBytes(await driver.read("tenant-b", "shared-id"))).toEqual(WORLD);
  });

  it("derives distinct, prefixed keys per (tenant, blob)", async () => {
    const client = new FakeS3Client();
    const driver = new S3BlobBytesDriver(client, { prefix: "blobs/" });
    await driver.write("tenant-a", "shared-id", HELLO);
    await driver.write("tenant-b", "shared-id", WORLD);

    const keys = [...client.store.keys()];
    expect(keys).toHaveLength(2);
    // Every key lives under the configured prefix and the two tenants get
    // different keys for the same blobId (no cross-tenant collision).
    for (const key of keys) {
      expect(key.startsWith("blobs/")).toBe(true);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("confines a path-traversal-shaped id to a deterministic key", async () => {
    const client = new FakeS3Client();
    const driver = new S3BlobBytesDriver(client, { prefix: "blobs" });
    // A blobId crafted to escape must still encode to a confined key and round
    // trip only via the same (tenantId, blobId) pair.
    await driver.write("tenant-a", "../../etc/passwd", HELLO);
    expect(asBytes(await driver.read("tenant-a", "../../etc/passwd"))).toEqual(HELLO);
    for (const key of client.store.keys()) {
      expect(key.startsWith("blobs/")).toBe(true);
      // The raw traversal characters never appear in the derived key.
      expect(key.includes("..")).toBe(false);
    }
  });

  it("wraps client failures in FrickBlobStorageError", async () => {
    const failing: S3LikeClient = {
      putObject: async () => {
        throw new Error("boom");
      },
      getObject: async () => {
        throw new Error("boom");
      },
      deleteObject: async () => {
        throw new Error("boom");
      },
      headObject: async () => {
        throw new Error("boom");
      },
    };
    const driver = new S3BlobBytesDriver(failing);
    await expect(driver.write("t", "b", HELLO)).rejects.toBeInstanceOf(FrickBlobStorageError);
    await expect(driver.read("t", "b")).rejects.toBeInstanceOf(FrickBlobStorageError);
    await expect(driver.delete("t", "b")).rejects.toBeInstanceOf(FrickBlobStorageError);
    await expect(driver.exists("t", "b")).rejects.toBeInstanceOf(FrickBlobStorageError);
  });
});

describe("createBlobBytesDriver s3 wiring", () => {
  let db: SqliteSqlDriver;

  beforeEach(() => {
    db = new SqliteSqlDriver(new DatabaseSync(":memory:"));
  });

  afterEach(() => {
    db.close();
  });

  it("returns the injected pre-built s3 driver", () => {
    const s3 = new S3BlobBytesDriver(new FakeS3Client());
    const driver = createBlobBytesDriver({ driver: "s3", db, s3Driver: s3 });
    expect(driver).toBe(s3);
  });

  it("fails clearly when s3 is selected without an injected driver", () => {
    expect(() => createBlobBytesDriver({ driver: "s3", db })).toThrow(
      /createS3BlobBytesDriver/,
    );
  });
});

describe("FrickStore s3 blob driver wiring", () => {
  it("routes blob bytes through an injected s3 driver, metadata stays in SQLite", async () => {
    const s3 = new S3BlobBytesDriver(new FakeS3Client());
    const store = new FrickStore({
      path: ":memory:",
      blobDriver: "s3",
      blobS3Driver: s3,
    });
    try {
      await store.blobs.create("tenant-a", {
        blobId: "blob-1",
        ownerId: "user-1",
        contentHash: "hash",
        byteLength: HELLO.byteLength,
        mimeType: "text/plain",
      });
      await store.blobs.writeContent("tenant-a", "blob-1", HELLO);

      // Bytes round-trip via the store facade.
      expect(asBytes(await store.blobs.readContent("tenant-a", "blob-1"))).toEqual(HELLO);
      // Bytes are NOT in the SQLite blob_content table.
      const row = store
        .rawDatabase()
        .prepare("SELECT content FROM blob_content WHERE tenant_id = ? AND blob_id = ?")
        .get("tenant-a", "blob-1");
      expect(row).toBeUndefined();
      // Metadata still lives in SQLite.
      expect((await store.blobs.read("tenant-a", "blob-1"))?.mimeType).toBe("text/plain");
    } finally {
      store.close();
    }
  });

  it("isolates tenants through the store facade", async () => {
    const store = new FrickStore({
      path: ":memory:",
      blobDriver: "s3",
      blobS3Driver: new S3BlobBytesDriver(new FakeS3Client()),
    });
    try {
      await store.blobs.writeContent("tenant-a", "shared", HELLO);
      await store.blobs.writeContent("tenant-b", "shared", WORLD);
      expect(asBytes(await store.blobs.readContent("tenant-a", "shared"))).toEqual(HELLO);
      expect(asBytes(await store.blobs.readContent("tenant-b", "shared"))).toEqual(WORLD);
      expect(await store.blobs.readContent("tenant-c", "shared")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
