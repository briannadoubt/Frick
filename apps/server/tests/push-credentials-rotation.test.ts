/**
 * FR-61: multi-key push credential rotation (overlap window).
 *
 * Rotating `FRICK_PUSH_CRED_KEY` used to require re-saving every tenant's
 * credentials in lockstep — a blob written under the old key was unreadable the
 * instant the env var changed. The overlap window keeps the previous key(s) in
 * `FRICK_PUSH_CRED_KEY_PREVIOUS` so old blobs still decrypt while every new
 * write uses the new primary. These tests pin that contract.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptCredential,
  encryptCredential,
} from "../src/push/credentials.js";

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

describe("push credential rotation (overlap window)", () => {
  it("decrypts an old-key blob after the new key becomes primary", () => {
    const oldKey = freshKey();
    const newKey = freshKey();

    // 1. Encrypt under the old key (the deploy before rotation).
    const oldEnv = { FRICK_PUSH_CRED_KEY: oldKey };
    const wrapped = encryptCredential({ secret: "rotate-me", n: 1 }, oldEnv);
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    // 2. Rotate: new key is primary, old key kept in the overlap window.
    const overlapEnv = {
      FRICK_PUSH_CRED_KEY: newKey,
      FRICK_PUSH_CRED_KEY_PREVIOUS: oldKey,
    };
    const unwrapped = decryptCredential<{ secret: string; n: number }>(
      wrapped.ciphertext,
      overlapEnv,
    );
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    expect(unwrapped.value).toEqual({ secret: "rotate-me", n: 1 });
  });

  it("encrypts new writes under the new primary, not any overlap key", () => {
    const oldKey = freshKey();
    const newKey = freshKey();
    const overlapEnv = {
      FRICK_PUSH_CRED_KEY: newKey,
      FRICK_PUSH_CRED_KEY_PREVIOUS: oldKey,
    };

    const wrapped = encryptCredential({ fresh: true }, overlapEnv);
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    // A deploy that has fully retired the old key (no overlap list) must still
    // read the new blob — proving it was written under the new primary.
    const newOnly = decryptCredential<{ fresh: boolean }>(wrapped.ciphertext, {
      FRICK_PUSH_CRED_KEY: newKey,
    });
    expect(newOnly.ok).toBe(true);
    if (!newOnly.ok) return;
    expect(newOnly.value).toEqual({ fresh: true });

    // The old key alone (post-rollback) must NOT read it.
    const oldOnly = decryptCredential(wrapped.ciphertext, {
      FRICK_PUSH_CRED_KEY: oldKey,
    });
    expect(oldOnly.ok).toBe(false);
  });

  it("once the old key is retired, old blobs no longer decrypt", () => {
    const oldKey = freshKey();
    const newKey = freshKey();

    const wrapped = encryptCredential({ secret: "stale" }, {
      FRICK_PUSH_CRED_KEY: oldKey,
    });
    if (!wrapped.ok) throw new Error("encrypt failed");

    // Overlap window dropped: only the new primary remains.
    const retiredEnv = { FRICK_PUSH_CRED_KEY: newKey };
    const result = decryptCredential(wrapped.ciphertext, retiredEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("push.credentials.corrupt");
  });

  it("tries multiple overlap keys in order", () => {
    const key1 = freshKey();
    const key2 = freshKey();
    const primary = freshKey();

    // Blob written under the oldest key (key2).
    const wrapped = encryptCredential({ gen: 2 }, { FRICK_PUSH_CRED_KEY: key2 });
    if (!wrapped.ok) throw new Error("encrypt failed");

    const env = {
      FRICK_PUSH_CRED_KEY: primary,
      FRICK_PUSH_CRED_KEY_PREVIOUS: `${key1}, ${key2}`,
    };
    const unwrapped = decryptCredential<{ gen: number }>(wrapped.ciphertext, env);
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    expect(unwrapped.value).toEqual({ gen: 2 });
  });

  it("skips blank / invalid entries in the overlap list", () => {
    const oldKey = freshKey();
    const newKey = freshKey();
    const wrapped = encryptCredential({ ok: 1 }, { FRICK_PUSH_CRED_KEY: oldKey });
    if (!wrapped.ok) throw new Error("encrypt failed");

    const env = {
      FRICK_PUSH_CRED_KEY: newKey,
      // Stray comma, blank, and a wrong-size key shouldn't break decryption.
      FRICK_PUSH_CRED_KEY_PREVIOUS: `, ,${Buffer.from("short").toString("base64")},${oldKey}`,
    };
    const unwrapped = decryptCredential<{ ok: number }>(wrapped.ciphertext, env);
    expect(unwrapped.ok).toBe(true);
  });
});
