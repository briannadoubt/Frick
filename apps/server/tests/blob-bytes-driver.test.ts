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
  SqliteBlobBytesDriver,
  createBlobBytesDriver,
} from "../src/storage/blob-bytes-driver.js";
import { FrickStore } from "../src/store.js";
import { loadFrickConfig } from "../src/config.js";

const HELLO = new TextEncoder().encode("hello blob");
const WORLD = new TextEncoder().encode("world blob");

describe("FilesystemBlobBytesDriver", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "frick-blobs-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips bytes (write/read/exists/delete)", () => {
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

  it("overwrites existing bytes for the same id", () => {
    const driver = new FilesystemBlobBytesDriver(root);
    driver.write("tenant-a", "blob-1", HELLO);
    driver.write("tenant-a", "blob-1", WORLD);
    expect(driver.read("tenant-a", "blob-1")).toEqual(Buffer.from(WORLD));
  });

  it("delete on a missing blob is a no-op", () => {
    const driver = new FilesystemBlobBytesDriver(root);
    expect(() => driver.delete("tenant-a", "missing")).not.toThrow();
  });

  it("isolates tenants — one tenant cannot read another's bytes", () => {
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

  it("confines a path-traversal-shaped id to the storage root", () => {
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

  it("fails fast when the storage path is not a writable directory", () => {
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
  let db: DatabaseSync;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "frick-blobs-factory-"));
    db = new DatabaseSync(":memory:");
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults to the sqlite driver", () => {
    const driver = createBlobBytesDriver({ driver: "sqlite", db });
    expect(driver).toBeInstanceOf(SqliteBlobBytesDriver);
  });

  it("builds the filesystem driver when a path is provided", () => {
    const driver = createBlobBytesDriver({
      driver: "filesystem",
      db,
      blobStoragePath: root,
    });
    expect(driver).toBeInstanceOf(FilesystemBlobBytesDriver);
  });

  it("fails clearly when filesystem is selected without a path", () => {
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "frick-blobs-store-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("default sqlite driver keeps blob bytes in SQLite (behavior unchanged)", () => {
    const store = new FrickStore({ path: ":memory:" });
    try {
      store.blobs.create("tenant-a", {
        blobId: "blob-1",
        ownerId: "user-1",
        contentHash: "hash",
        byteLength: HELLO.byteLength,
        mimeType: "text/plain",
      });
      store.blobs.writeContent("tenant-a", "blob-1", HELLO);

      expect(store.blobs.readContent("tenant-a", "blob-1")).toEqual(Buffer.from(HELLO));
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

  it("filesystem driver moves bytes to disk and keeps metadata in SQLite", () => {
    const store = new FrickStore({
      path: ":memory:",
      blobDriver: "filesystem",
      blobStoragePath: root,
    });
    try {
      store.blobs.create("tenant-a", {
        blobId: "blob-1",
        ownerId: "user-1",
        contentHash: "hash",
        byteLength: HELLO.byteLength,
        mimeType: "text/plain",
      });
      store.blobs.writeContent("tenant-a", "blob-1", HELLO);

      // Bytes round-trip via the store facade.
      expect(store.blobs.readContent("tenant-a", "blob-1")).toEqual(Buffer.from(HELLO));
      // Bytes are on disk, not in SQLite.
      expect(readdirSync(root).length).toBeGreaterThan(0);
      const row = store
        .rawDatabase()
        .prepare("SELECT content FROM blob_content WHERE tenant_id = ? AND blob_id = ?")
        .get("tenant-a", "blob-1");
      expect(row).toBeUndefined();
      // Metadata still lives in SQLite.
      expect(store.blobs.read("tenant-a", "blob-1")?.mimeType).toBe("text/plain");
    } finally {
      store.close();
    }
  });

  it("filesystem driver isolates tenants through the store facade", () => {
    const store = new FrickStore({
      path: ":memory:",
      blobDriver: "filesystem",
      blobStoragePath: root,
    });
    try {
      store.blobs.writeContent("tenant-a", "shared", HELLO);
      store.blobs.writeContent("tenant-b", "shared", WORLD);
      expect(store.blobs.readContent("tenant-a", "shared")).toEqual(Buffer.from(HELLO));
      expect(store.blobs.readContent("tenant-b", "shared")).toEqual(Buffer.from(WORLD));
      expect(store.blobs.readContent("tenant-c", "shared")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("loadFrickConfig blob driver", () => {
  it("defaults the blob driver to sqlite", () => {
    const config = loadFrickConfig({}, { env: {}, warn: () => {} });
    expect(config.blobDriver).toBe("sqlite");
  });

  it("parses FRICK_BLOB_DRIVER=filesystem with a storage path", () => {
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

  it("rejects an invalid blob driver value", () => {
    expect(() =>
      loadFrickConfig({}, { env: { FRICK_BLOB_DRIVER: "s3" }, warn: () => {} }),
    ).toThrow(/FRICK_BLOB_DRIVER must be one of sqlite, filesystem/);
  });

  it("fails fast when filesystem is selected without a path", () => {
    expect(() =>
      loadFrickConfig(
        { blobStoragePath: "   " },
        { env: { FRICK_BLOB_DRIVER: "filesystem" }, warn: () => {} },
      ),
    ).toThrow(/FRICK_BLOB_DRIVER=filesystem requires FRICK_BLOB_STORAGE_PATH/);
  });
});
