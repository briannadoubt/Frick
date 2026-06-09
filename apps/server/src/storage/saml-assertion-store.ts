import type { SqlDriver } from "./sql-driver.js";

/**
 * SAML assertion-replay guard (FR-31).
 *
 * Each SAML assertion carries a unique `ID`. The SAML profile requires the SP
 * to reject a previously-seen assertion ID so a captured (still-signed,
 * still-in-window) assertion cannot be replayed against the ACS endpoint. This
 * store records every consumed assertion ID — scoped by provider id so two
 * IdPs that happen to mint colliding IDs don't alias — and reports whether an
 * ID has been seen before.
 *
 * `markSeen` is the security-critical operation: it must be a single atomic
 * insert whose success/failure tells the caller whether THIS request is the
 * first to consume the assertion. The composite PRIMARY KEY
 * `(provider_id, assertion_id)` makes a duplicate insert fail, so even two
 * concurrent submissions of the same assertion can't both win.
 *
 * Rows are kept until `expires_at` (the assertion's NotOnOrAfter, with a skew
 * pad supplied by the caller — see auth-saml-4); after that the assertion is no
 * longer acceptable on freshness grounds anyway, so the replay row can be GC'd
 * by `purgeExpired`. Because no global scheduler invokes `purgeExpired`,
 * `markSeen` opportunistically sweeps already-expired rows on each first
 * sighting so the table stays bounded by the number of *currently in-window*
 * assertions rather than growing with every successful SAML login.
 */
export class SamlAssertionStore {
  constructor(private readonly sql: SqlDriver) {}

  /**
   * Atomically record that `assertionId` (for `providerId`) has been consumed.
   * Returns true when this call was the FIRST to record it (the assertion is
   * fresh and may be accepted), or false when the ID was already present (a
   * replay — the caller MUST reject). `expiresAt` is the skew-padded replay TTL
   * (ISO 8601); the row is GC-eligible after it passes.
   */
  async markSeen(input: {
    providerId: string;
    assertionId: string;
    expiresAt: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      const result = await this.sql.run(
        `INSERT INTO auth_saml_seen_assertions
            (provider_id, assertion_id, seen_at, expires_at)
            VALUES (?, ?, ?, ?)`,
        [input.providerId, input.assertionId, now, input.expiresAt],
      );
      const won = Number(result.changes) > 0;
      if (won) {
        // auth-saml-4: opportunistically GC expired replay rows on the way in so
        // the table is bounded without depending on an external scheduler.
        // Best-effort — a failed sweep must never fail the login.
        try {
          await this.purgeExpired();
        } catch {
          // ignore
        }
      }
      // A successful insert means we won the race / first sighting.
      return won;
    } catch {
      // Unique-constraint violation (SQLite + Postgres both throw) → the
      // assertion ID was already recorded: this is a replay.
      return false;
    }
  }

  /** Whether an assertion ID has already been recorded (non-mutating peek). */
  async hasSeen(providerId: string, assertionId: string): Promise<boolean> {
    const row = await this.sql.get<{ assertion_id: string }>(
      "SELECT assertion_id FROM auth_saml_seen_assertions WHERE provider_id = ? AND assertion_id = ?",
      [providerId, assertionId],
    );
    return row !== undefined;
  }

  /** Garbage-collect replay rows whose assertion freshness window has passed. */
  async purgeExpired(): Promise<number> {
    const result = await this.sql.run(
      "DELETE FROM auth_saml_seen_assertions WHERE expires_at < ?",
      [new Date().toISOString()],
    );
    return Number(result.changes);
  }
}
