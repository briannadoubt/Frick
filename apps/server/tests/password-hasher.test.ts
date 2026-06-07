import { scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@fricken/protocol";
import { describe, expect, it } from "vitest";
import {
  Argon2PasswordHasher,
  ScryptPasswordHasher,
  createPasswordHasher,
  toStoredHash,
  type FrickPasswordHasher,
} from "../src/storage/password-hasher.js";
import { AccountStore } from "../src/storage/account-store.js";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { initializeStorage } from "../src/storage/schema.js";

function newAccountStore(hasher?: FrickPasswordHasher) {
  const db = new DatabaseSync(":memory:");
  initializeStorage(db, foundationSchema.schemaRevision);
  const driver = new SqliteSqlDriver(db);
  return { store: new AccountStore(driver, hasher), driver };
}

describe("FrickPasswordHasher — self-describing formats", () => {
  it("argon2 hashes are tagged, verify correctly, and reject wrong passwords", async () => {
    const hasher = new Argon2PasswordHasher();
    const stored = await hasher.hash("hunter2");
    expect(stored.startsWith("argon2$")).toBe(true);
    expect(await hasher.verify("hunter2", stored)).toBe(true);
    expect(await hasher.verify("nope", stored)).toBe(false);
  });

  it("scrypt hashes are tagged, verify correctly, and reject wrong passwords", async () => {
    const hasher = new ScryptPasswordHasher();
    const stored = await hasher.hash("hunter2");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await hasher.verify("hunter2", stored)).toBe(true);
    expect(await hasher.verify("nope", stored)).toBe(false);
  });

  it("a hasher can verify another algorithm's hash (cross-algorithm dispatch)", async () => {
    const argon2 = new Argon2PasswordHasher();
    const scrypt = new ScryptPasswordHasher();
    const scryptStored = await scrypt.hash("hunter2");
    // Argon2 hasher must still verify a scrypt hash so migration can detect it.
    expect(await argon2.verify("hunter2", scryptStored)).toBe(true);
    const argonStored = await argon2.hash("hunter2");
    expect(await scrypt.verify("hunter2", argonStored)).toBe(true);
  });

  it("createPasswordHasher defaults to argon2", async () => {
    const hasher = createPasswordHasher();
    expect(hasher.id).toBe("argon2");
    expect((await hasher.hash("x")).startsWith("argon2$")).toBe(true);
  });
});

describe("needsRehash", () => {
  it("argon2 hasher flags legacy and scrypt hashes for rehash", async () => {
    const argon2 = new Argon2PasswordHasher();
    const scryptStored = await new ScryptPasswordHasher().hash("pw");
    expect(argon2.needsRehash(scryptStored)).toBe(true);
    expect(argon2.needsRehash(toStoredHash("abc", "salt"))).toBe(true);
    // Its own fresh hash does not need rehashing.
    expect(argon2.needsRehash(await argon2.hash("pw"))).toBe(false);
  });

  it("argon2 hasher flags a weaker-parameter argon2 hash for rehash", async () => {
    const weak = new Argon2PasswordHasher({ memoryCost: 8192, timeCost: 1 });
    const strong = new Argon2PasswordHasher();
    const weakStored = await weak.hash("pw");
    expect(strong.needsRehash(weakStored)).toBe(true);
    expect(await strong.verify("pw", weakStored)).toBe(true);
  });

  it("scrypt hasher does not downgrade an argon2 hash", async () => {
    const scrypt = new ScryptPasswordHasher();
    const argonStored = await new Argon2PasswordHasher().hash("pw");
    expect(scrypt.needsRehash(argonStored)).toBe(false);
  });
});

describe("legacy scrypt compatibility", () => {
  it("verifies a hash produced by the pre-FR-35 bare scryptSync format", async () => {
    // Reproduce the old on-disk format: separate salt column + untagged digest.
    const salt = "abc123salt";
    const digest = scryptSync("hunter2", salt, 32).toString("base64url");
    const stored = toStoredHash(digest, salt);
    expect(stored.startsWith("legacy-scrypt$")).toBe(true);

    const hasher = createPasswordHasher();
    expect(await hasher.verify("hunter2", stored)).toBe(true);
    expect(await hasher.verify("wrong", stored)).toBe(false);
    expect(hasher.needsRehash(stored)).toBe(true);
  });
});

describe("AccountStore lazy migration", () => {
  it("re-hashes a legacy scrypt row to argon2 on next successful login", async () => {
    const { store, driver } = newAccountStore();
    // Seed a legacy row by writing the old two-column format directly.
    const salt = "legacysaltvalue";
    const digest = scryptSync("supersecret", salt, 32).toString("base64url");
    await driver.run(
      `INSERT INTO auth_accounts
         (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["u1", "_default", "ada", "Ada", salt, digest, new Date().toISOString()],
    );

    // Login succeeds against the legacy hash.
    expect(await store.verifyPassword("_default", "ada", "supersecret")).toBeDefined();

    // The row was transparently upgraded to a tagged argon2 hash with no salt.
    const row = await driver.get<{ password_hash: string; password_salt: string }>(
      "SELECT password_hash, password_salt FROM auth_accounts WHERE user_id = ?",
      ["u1"],
    );
    expect(row?.password_hash.startsWith("argon2$")).toBe(true);
    expect(row?.password_salt).toBe("");

    // And the upgraded credential still verifies.
    expect(await store.verifyPassword("_default", "ada", "supersecret")).toBeDefined();
    expect(await store.verifyPassword("_default", "ada", "wrong")).toBeUndefined();
  });

  it("does not rewrite the row when the stored hash already matches the active hasher", async () => {
    const { store, driver } = newAccountStore(createPasswordHasher("argon2"));
    await store.create({
      tenantId: "_default",
      userId: "u2",
      handle: "grace",
      displayName: "Grace",
      password: "topsecret",
    });
    const before = await driver.get<{ password_hash: string }>(
      "SELECT password_hash FROM auth_accounts WHERE user_id = ?",
      ["u2"],
    );
    expect(await store.verifyPassword("_default", "grace", "topsecret")).toBeDefined();
    const after = await driver.get<{ password_hash: string }>(
      "SELECT password_hash FROM auth_accounts WHERE user_id = ?",
      ["u2"],
    );
    expect(after?.password_hash).toBe(before?.password_hash);
  });

  it("scrypt-configured store re-hashes a legacy row to tagged scrypt", async () => {
    const { store, driver } = newAccountStore(createPasswordHasher("scrypt"));
    const salt = "anotherlegacysalt";
    const digest = scryptSync("pw123456", salt, 32).toString("base64url");
    await driver.run(
      `INSERT INTO auth_accounts
         (user_id, tenant_id, handle, display_name, password_salt, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["u3", "_default", "linus", "Linus", salt, digest, new Date().toISOString()],
    );
    expect(await store.verifyPassword("_default", "linus", "pw123456")).toBeDefined();
    const row = await driver.get<{ password_hash: string }>(
      "SELECT password_hash FROM auth_accounts WHERE user_id = ?",
      ["u3"],
    );
    expect(row?.password_hash.startsWith("scrypt$")).toBe(true);
  });
});
