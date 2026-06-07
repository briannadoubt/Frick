/**
 * Postgres SqlDriver adapter — identity stores conformance (FR-120).
 *
 * Proves the account, session, password-reset, grant, and invitation stores —
 * all written against the `SqlDriver` seam with dialect-neutral SQL — run
 * unmodified on the Postgres adapter. Requires a live Postgres via
 * `FRICK_DATABASE_URL`; skipped otherwise (mirrors pg-sql-driver.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { foundationSchema } from "@fricken/protocol";
import { PgSqlDriver } from "../src/storage/pg-sql-driver.js";
import { runFrameworkMigrationsPostgres } from "../src/storage/pg-migrations.js";
import { FRAMEWORK_MIGRATIONS_PG } from "../src/storage/pg-framework-migrations.js";
import { AccountStore } from "../src/storage/account-store.js";
import { SessionStore } from "../src/storage/session-store.js";
import { PasswordResetTokenStore } from "../src/storage/password-reset-store.js";
import { GrantStore } from "../src/storage/grant-store.js";
import { InvitationStore } from "../src/storage/invitation-store.js";

const DATABASE_URL = process.env.FRICK_DATABASE_URL;
const skip = !DATABASE_URL;

let pool: Pool;
let testSchema: string;
let driver: PgSqlDriver;

beforeEach(async () => {
  if (skip) return;
  testSchema = `frick_pgident_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(`CREATE SCHEMA "${testSchema}"`);
  pool.on("connect", (client) => {
    client.query(`SET search_path TO "${testSchema}"`).catch(() => {});
  });
  await pool.query(`SET search_path TO "${testSchema}"`);
  await runFrameworkMigrationsPostgres(pool, {
    supportedSchemaRevision: foundationSchema.schemaRevision,
    migrations: FRAMEWORK_MIGRATIONS_PG,
  });
  driver = new PgSqlDriver(pool);
});

afterEach(async () => {
  if (skip) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  await pool.end();
});

const future = () => new Date(Date.now() + 60_000).toISOString();

describe.skipIf(skip)("PgSqlDriver — identity stores on Postgres (requires FRICK_DATABASE_URL)", () => {
  it("AccountStore create / readByIdentity / verifyPassword / setPassword / delete", async () => {
    const accounts = new AccountStore(driver);
    const created = await accounts.create({
      tenantId: "_default",
      userId: "user-ada",
      handle: "ada",
      displayName: "Ada",
      password: "supersecret",
    });
    expect(created.userId).toBe("user-ada");

    expect((await accounts.readByIdentity("_default", "ada"))?.displayName).toBe("Ada");
    expect(await accounts.verifyPassword("_default", "ada", "supersecret")).toBeDefined();
    expect(await accounts.verifyPassword("_default", "ada", "wrong")).toBeUndefined();

    expect(await accounts.setPassword("_default", "user-ada", "newpass")).toBe(true);
    expect(await accounts.verifyPassword("_default", "ada", "newpass")).toBeDefined();
    expect(await accounts.verifyPassword("_default", "ada", "supersecret")).toBeUndefined();

    expect(await accounts.delete("_default", "user-ada")).toBe(true);
    expect(await accounts.readByIdentity("_default", "ada")).toBeUndefined();
  });

  it("SessionStore create / readActive / deleteForUser / pruneExpired", async () => {
    const sessions = new SessionStore(driver);
    await sessions.create({
      sessionToken: "tok-live",
      tenantId: "_default",
      userId: "user-ada",
      deviceId: "d",
      replicaId: "r",
      expiresAt: future(),
    });
    expect((await sessions.readActive("tok-live"))?.userId).toBe("user-ada");

    // Expired session is filtered on read but stays until pruned.
    await sessions.create({
      sessionToken: "tok-dead",
      tenantId: "_default",
      userId: "user-ada",
      deviceId: "d",
      replicaId: "r",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expect(await sessions.readActive("tok-dead")).toBeUndefined();
    expect(await sessions.pruneExpired()).toBe(1);
    expect(await sessions.readAny("tok-dead")).toBeUndefined();

    expect(await sessions.deleteForUser("user-ada")).toBe(1);
    expect(await sessions.readActive("tok-live")).toBeUndefined();
  });

  it("PasswordResetTokenStore issue then single-use consume", async () => {
    const tokens = new PasswordResetTokenStore(driver);
    const issued = await tokens.issue({ tenantId: "_default", userId: "user-ada" });

    const consumed = await tokens.consume(issued.token);
    expect(consumed?.userId).toBe("user-ada");
    // Single-use: a second consume yields nothing.
    expect(await tokens.consume(issued.token)).toBeUndefined();
  });

  it("GrantStore isEmpty / create / hasActiveGrantFor / revoke", async () => {
    const grants = new GrantStore(driver);
    expect(await grants.isEmptyAsync()).toBe(true);

    const grant = await grants.create({
      id: "grant-1",
      tenantId: "_default",
      ownerUserId: "owner",
      recordType: "Note",
      recordId: "note-1",
      granteeUserId: "grantee",
      permission: "read",
      createdAt: new Date().toISOString(),
    });
    expect(grant.id).toBe("grant-1");
    expect(await grants.isEmptyAsync()).toBe(false);

    expect(
      await grants.hasActiveGrantFor({
        tenantId: "_default",
        granteeUserId: "grantee",
        recordType: "Note",
        recordId: "note-1",
        required: "read",
      }),
    ).toBe(true);

    await grants.revoke({ tenantId: "_default", id: "grant-1", now: new Date().toISOString() });
    expect(
      await grants.hasActiveGrantFor({
        tenantId: "_default",
        granteeUserId: "grantee",
        recordType: "Note",
        recordId: "note-1",
        required: "read",
      }),
    ).toBe(false);
  });

  it("InvitationStore create / getByToken / redeem", async () => {
    const invitations = new InvitationStore(driver);
    await invitations.create({
      id: "inv-1",
      tenantId: "_default",
      ownerUserId: "owner",
      recordType: "Note",
      recordId: "note-1",
      permission: "write",
      token: "invite-token",
      createdAt: new Date().toISOString(),
      expiresAt: future(),
    });

    expect((await invitations.getByToken("invite-token"))?.id).toBe("inv-1");

    const outcome = await invitations.redeem({
      token: "invite-token",
      tenantId: "_default",
      redeemerUserId: "grantee",
      now: new Date().toISOString(),
    });
    expect(outcome.kind).toBe("ok");
    // Already redeemed on a second attempt.
    const again = await invitations.redeem({
      token: "invite-token",
      tenantId: "_default",
      redeemerUserId: "grantee",
      now: new Date().toISOString(),
    });
    expect(again.kind).toBe("alreadyRedeemed");
  });
});
