import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MediaPlaneError, P2PWebRTCAdapter } from "../src/calls/index.js";

/**
 * FR-81 — self-built P2P WebRTC media-plane adapter.
 *
 * Exercises the coturn-REST ephemeral TURN credential scheme, STUN-only
 * fallback, capabilities, idempotent allocate, and the issue-without-session
 * guard — all under an injected clock so credentials are deterministic.
 */

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const PARTICIPANT = { userId: "user-1", deviceId: "device-a" } as const;

describe("P2PWebRTCAdapter", () => {
  it("advertises p2p / max 2 participants / no region hint", () => {
    const adapter = new P2PWebRTCAdapter();
    expect(adapter.describe()).toEqual({
      transport: "p2p",
      maxParticipants: 2,
      supportsRegionHint: false,
    });
  });

  it("allocateSession is idempotent per call id and does no networking", async () => {
    const adapter = new P2PWebRTCAdapter();
    const first = await adapter.allocateSession("call-1");
    const second = await adapter.allocateSession("call-1");
    expect(first.mediaSessionId).toBe(second.mediaSessionId);
    expect(first.transport).toBe("p2p");
    // A different call id gets a distinct handle.
    const other = await adapter.allocateSession("call-2");
    expect(other.mediaSessionId).not.toBe(first.mediaSessionId);
  });

  it("issueJoinToken throws when no session is allocated", async () => {
    const adapter = new P2PWebRTCAdapter();
    await expect(adapter.issueJoinToken("missing", PARTICIPANT)).rejects.toBeInstanceOf(
      MediaPlaneError,
    );
  });

  it("returns STUN-only ICE servers (no creds) when no TURN is configured", async () => {
    const adapter = new P2PWebRTCAdapter({
      iceServers: [{ urls: "stun:stun.example.org:3478" }],
      now: () => 1_700_000_000_000,
    });
    await adapter.allocateSession("call-1");
    const grant = await adapter.issueJoinToken("call-1", PARTICIPANT);
    const ice = JSON.parse(grant.connection!.iceServers) as IceServer[];
    expect(ice).toEqual([{ urls: "stun:stun.example.org:3478" }]);
    expect(ice.every((s) => s.username === undefined && s.credential === undefined)).toBe(true);
  });

  it("mints ephemeral TURN credentials with the coturn REST convention", async () => {
    const sharedSecret = "s3cr3t";
    const now = 1_700_000_000_000; // fixed clock
    const ttlMs = 60_000;
    const adapter = new P2PWebRTCAdapter({
      iceServers: [{ urls: "stun:stun.example.org:3478" }],
      turn: { urls: ["turn:turn.example.org:3478", "turns:turn.example.org:5349"], sharedSecret, realm: "frick" },
      defaultTokenTtlMs: ttlMs,
      now: () => now,
    });
    await adapter.allocateSession("call-1");
    const grant = await adapter.issueJoinToken("call-1", PARTICIPANT);

    const ice = JSON.parse(grant.connection!.iceServers) as IceServer[];
    const turn = ice.find((s) => String(s.urls).includes("turn"))!;
    expect(turn).toBeDefined();

    const expirySeconds = Math.floor((now + ttlMs) / 1000);
    const expectedUsername = `${expirySeconds}:${PARTICIPANT.userId}`;
    expect(turn.username).toBe(expectedUsername);

    const expectedCredential = createHmac("sha1", sharedSecret)
      .update(expectedUsername)
      .digest("base64");
    expect(turn.credential).toBe(expectedCredential);

    // STUN entry remains credential-free alongside the TURN entry.
    const stun = ice.find((s) => String(s.urls).startsWith("stun:"))!;
    expect(stun.username).toBeUndefined();

    // Realm is echoed onto the connection metadata.
    expect(grant.connection!.turnRealm).toBe("frick");
  });

  it("derives expiresAt and the TURN expiry from the injected clock + ttl", async () => {
    const now = 1_700_000_000_000;
    const ttlMs = 120_000;
    const adapter = new P2PWebRTCAdapter({
      turn: { urls: "turn:turn.example.org:3478", sharedSecret: "k" },
      now: () => now,
    });
    await adapter.allocateSession("call-1");
    const grant = await adapter.issueJoinToken("call-1", PARTICIPANT, { ttlMs });

    expect(grant.expiresAt).toBe(new Date(now + ttlMs).toISOString());
    const ice = JSON.parse(grant.connection!.iceServers) as IceServer[];
    const turn = ice.find((s) => String(s.urls).includes("turn"))!;
    const expirySeconds = Math.floor((now + ttlMs) / 1000);
    expect(turn.username).toBe(`${expirySeconds}:${PARTICIPANT.userId}`);
  });

  it("releaseSession is idempotent and drops the handle", async () => {
    const adapter = new P2PWebRTCAdapter();
    await adapter.allocateSession("call-1");
    expect(adapter.hasSession("call-1")).toBe(true);
    await adapter.releaseSession("call-1");
    await adapter.releaseSession("call-1"); // no throw on repeat
    expect(adapter.hasSession("call-1")).toBe(false);
    await expect(adapter.issueJoinToken("call-1", PARTICIPANT)).rejects.toBeInstanceOf(
      MediaPlaneError,
    );
  });
});
