import { describe, expect, it } from "vitest";
import {
  createECDH,
  createDecipheriv,
  createHmac,
  type DecipherGCM,
} from "node:crypto";
import { encryptWebPushPayload } from "../src/push/web-push-adapter.js";

/**
 * Generate a fake browser subscription keypair the way a `PushSubscription`
 * exposes it: `p256dh` is the uncompressed public point (base64url) and
 * `auth` is a 16-byte secret (base64url). We keep the private key so the
 * test can decrypt and prove the round-trip.
 */
function makeSubscriptionKeys(): {
  p256dh: string;
  auth: string;
  privateKey: Buffer;
} {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.alloc(16);
  for (let i = 0; i < auth.length; i++) auth[i] = (i * 17 + 3) & 0xff;
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    privateKey: ecdh.getPrivateKey(),
  };
}

/** HKDF-SHA256, single block (≤ 32-byte output), mirroring RFC 5869. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const t = createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return t.subarray(0, length);
}

/**
 * Test-only RFC 8291 / RFC 8188 `aes128gcm` decryptor. Parses the header,
 * re-derives the content-encryption key + nonce from the subscription
 * private key, and AES-128-GCM decrypts the single record back to plaintext.
 */
function decryptWebPushPayload(
  body: Buffer,
  uaPublic: Buffer,
  uaPrivate: Buffer,
  authSecret: Buffer,
): { plaintext: Buffer; salt: Buffer; rs: number; keyid: Buffer } {
  // RFC 8188 §2.1 header: salt(16) || rs(4) || idlen(1) || keyid.
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20]!;
  const keyid = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const ecdhSecret = ecdh.computeSecret(keyid); // keyid = as_public

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublic,
    keyid,
  ]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const enc = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce) as DecipherGCM;
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(enc), decipher.final()]);

  // Strip the 0x02 last-record delimiter (single-record framing).
  const delimiter = record[record.length - 1];
  expect(delimiter).toBe(0x02);
  return { plaintext: record.subarray(0, record.length - 1), salt, rs, keyid };
}

describe("web push RFC 8291 payload encryption", () => {
  it("produces a well-formed aes128gcm body", async () => {
    const sub = makeSubscriptionKeys();
    const body = encryptWebPushPayload("hello world", sub.p256dh, sub.auth);

    // Header is salt(16) || rs(4) || idlen(1) || keyid + ciphertext.
    expect(body.length).toBeGreaterThan(21 + 65 + 16);
    const salt = body.subarray(0, 16);
    expect(salt.length).toBe(16);
    const rs = body.readUInt32BE(16);
    expect(rs).toBeGreaterThanOrEqual(body.length - 21 - 65);
    const idlen = body[20];
    expect(idlen).toBe(65); // uncompressed P-256 point
    const keyid = body.subarray(21, 21 + 65);
    expect(keyid[0]).toBe(0x04); // valid uncompressed point prefix
  });

  it("round-trips back to the plaintext", async () => {
    const sub = makeSubscriptionKeys();
    const uaPublic = Buffer.from(sub.p256dh, "base64url");
    const authSecret = Buffer.from(sub.auth, "base64url");
    const message = JSON.stringify({ title: "Hi", body: "You have a message" });

    const body = encryptWebPushPayload(message, sub.p256dh, sub.auth);
    const { plaintext, keyid } = decryptWebPushPayload(
      body,
      uaPublic,
      sub.privateKey,
      authSecret,
    );

    expect(plaintext.toString("utf8")).toBe(message);
    // keyid must be the ephemeral server public key, a valid P-256 point.
    expect(keyid.length).toBe(65);
    expect(keyid[0]).toBe(0x04);
  });

  it("uses a fresh ephemeral key + salt per call", async () => {
    const sub = makeSubscriptionKeys();
    const a = encryptWebPushPayload("same", sub.p256dh, sub.auth);
    const b = encryptWebPushPayload("same", sub.p256dh, sub.auth);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false); // salt
    expect(a.subarray(21, 21 + 65).equals(b.subarray(21, 21 + 65))).toBe(false); // keyid
  });

  it("rejects a malformed p256dh", async () => {
    const sub = makeSubscriptionKeys();
    expect(() => encryptWebPushPayload("x", "AAAA", sub.auth)).toThrow();
  });
});
