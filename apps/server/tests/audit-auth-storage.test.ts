import { DatabaseSync } from "node:sqlite";
import { foundationSchema } from "@fricken/protocol";
import { describe, expect, it } from "vitest";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { runFrameworkMigrations } from "../src/storage/migrations.js";
import { RefreshTokenStore } from "../src/storage/refresh-token-store.js";
import { PasswordResetTokenStore } from "../src/storage/password-reset-store.js";
import { SamlAssertionStore } from "../src/storage/saml-assertion-store.js";

/**
 * Storage-layer regression tests for the auth audit fixes:
 *   - auth-core-3: refresh-token reuse / family detection
 *   - auth-core-8: single-outstanding password-reset token per user
 *   - auth-saml-4: replay row opportunistic GC
 */

function newDriver(): SqliteSqlDriver {
  const db = new DatabaseSync(":memory:");
  runFrameworkMigrations(db, { supportedSchemaRevision: foundationSchema.schemaRevision });
  return new SqliteSqlDriver(db);
}

describe("auth-core-3: refresh-token reuse / family detection", () => {
  it("revokes the entire rotation family when an already-rotated token is replayed", async () => {
    const store = new RefreshTokenStore(newDriver());
    const first = await store.issue({
      tenantId: "t1",
      userId: "u1",
      deviceId: "d1",
      replicaId: "r1",
    });

    // Legit rotation: first -> second.
    const second = await store.rotate(first.token);
    expect(second).toBeDefined();
    // Rotate again to get a third live token in the same family.
    const third = await store.rotate(second!.token);
    expect(third).toBeDefined();
    // The current (third) token is live.
    expect(await store.readActive(third!.token)).toBeDefined();

    // Reuse the ALREADY-rotated `first` token: this is the theft signal. It must
    // fail AND burn the whole family — including the otherwise-live `third`.
    const reuse = await store.rotate(first.token);
    expect(reuse).toBeUndefined();

    // The live descendant is now revoked too (family burned), forcing re-login.
    expect(await store.readActive(third!.token)).toBeUndefined();
    expect(await store.rotate(third!.token)).toBeUndefined();
  });

  it("a normal single rotation still issues a usable fresh token (no false positive)", async () => {
    const store = new RefreshTokenStore(newDriver());
    const issued = await store.issue({
      tenantId: "t1",
      userId: "u1",
      deviceId: "d1",
      replicaId: "r1",
    });
    const rotated = await store.rotate(issued.token);
    expect(rotated).toBeDefined();
    expect(rotated!.token).not.toBe(issued.token);
    // The fresh token is live; the old one is dead.
    expect(await store.readActive(rotated!.token)).toBeDefined();
    expect(await store.readActive(issued.token)).toBeUndefined();
  });
});

describe("auth-core-8: issuing a reset token invalidates prior outstanding tokens", () => {
  it("only the most recently issued token verifies", async () => {
    const store = new PasswordResetTokenStore(newDriver());
    const oldToken = await store.issue({ tenantId: "t1", userId: "u1" });
    // A second issuance for the same user must consume the first.
    const newToken = await store.issue({ tenantId: "t1", userId: "u1" });

    // The old (possibly-leaked) token no longer verifies.
    expect(await store.consume(oldToken.token)).toBeUndefined();
    // The newest token still works.
    const consumed = await store.consume(newToken.token);
    expect(consumed).toEqual({ tenantId: "t1", userId: "u1" });
  });

  it("does not affect a different user's outstanding token", async () => {
    const store = new PasswordResetTokenStore(newDriver());
    const userA = await store.issue({ tenantId: "t1", userId: "userA" });
    await store.issue({ tenantId: "t1", userId: "userB" });
    // Re-issuing for userB must not invalidate userA's token.
    await store.issue({ tenantId: "t1", userId: "userB" });
    expect(await store.consume(userA.token)).toEqual({ tenantId: "t1", userId: "userA" });
  });
});

describe("auth-saml-4: replay store bounds itself via opportunistic GC", () => {
  it("does not let expired replay rows accumulate (opportunistic GC)", async () => {
    const driver = newDriver();
    const store = new SamlAssertionStore(driver);

    // Record an in-window assertion (it must survive its own GC sweep).
    expect(
      await store.markSeen({
        providerId: "p1",
        assertionId: "live-assertion",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(true);

    // Several already-expired assertions: each is swept on the way in (the win
    // triggers purgeExpired), so they never accumulate.
    for (let i = 0; i < 3; i++) {
      await store.markSeen({
        providerId: "p1",
        assertionId: `expired-${i}`,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
    }

    const remaining = await driver.all<{ c: number }>(
      "SELECT COUNT(*) AS c FROM auth_saml_seen_assertions",
    );
    // Only the in-window row remains; the expired rows were GC'd.
    expect(Number(remaining[0]!.c)).toBe(1);
    expect(await store.hasSeen("p1", "live-assertion")).toBe(true);
  });

  it("a duplicate (replay) is still rejected", async () => {
    const store = new SamlAssertionStore(newDriver());
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(await store.markSeen({ providerId: "p1", assertionId: "a1", expiresAt })).toBe(true);
    // Same id again -> replay.
    expect(await store.markSeen({ providerId: "p1", assertionId: "a1", expiresAt })).toBe(false);
  });
});
