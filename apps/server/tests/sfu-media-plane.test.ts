import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FakeSfuBackend,
  LocalMediaPlacement,
  MediaPlaneError,
  SfuMediaPlaneAdapter,
  type SfuTransportParams,
} from "../src/calls/index.js";

/**
 * FR-83 — self-hosted single-box mediasoup SFU media-plane adapter.
 *
 * Every test drives the deterministic {@link FakeSfuBackend} — mediasoup is
 * never built or imported. Exercises capabilities, idempotent allocate (one
 * router per call), join-token transport creation + ICE/DTLS params + the HMAC
 * auth nonce under an injected clock, the no-session guard, idempotent release,
 * a full two-participant produce/consume flow, and `LocalMediaPlacement`.
 */

const ANNOUNCED_IP = "203.0.113.7";
const SECRET = "sfu-secret-at-least-16-bytes";
const A = { userId: "user-a", deviceId: "device-a" } as const;
const B = { userId: "user-b", deviceId: "device-b" } as const;

function makeAdapter(overrides: Partial<{ now: () => number; ttl: number }> = {}) {
  const backend = new FakeSfuBackend();
  const adapter = new SfuMediaPlaneAdapter({
    backend,
    announcedIp: ANNOUNCED_IP,
    mediaCodecs: [{ kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 }],
    tokenSecret: SECRET,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.ttl !== undefined ? { defaultTokenTtlMs: overrides.ttl } : {}),
  });
  return { backend, adapter };
}

describe("SfuMediaPlaneAdapter", () => {
  it("advertises sfu / no region hint / no hard cap by default", () => {
    const { adapter } = makeAdapter();
    expect(adapter.describe()).toEqual({ transport: "sfu", supportsRegionHint: false });
  });

  it("surfaces a configurable soft participant cap", () => {
    const adapter = new SfuMediaPlaneAdapter({
      backend: new FakeSfuBackend(),
      announcedIp: ANNOUNCED_IP,
      mediaCodecs: [],
      tokenSecret: SECRET,
      softMaxParticipants: 50,
    });
    expect(adapter.describe()).toEqual({
      transport: "sfu",
      supportsRegionHint: false,
      maxParticipants: 50,
    });
  });

  it("requires placement or announcedIp", () => {
    expect(
      () =>
        new SfuMediaPlaneAdapter({
          backend: new FakeSfuBackend(),
          mediaCodecs: [],
          tokenSecret: SECRET,
        }),
    ).toThrow(MediaPlaneError);
  });

  it("allocateSession is idempotent — one router per call — and carries bootstrap", async () => {
    const { backend, adapter } = makeAdapter();
    const first = await adapter.allocateSession("call-1");
    const second = await adapter.allocateSession("call-1");

    expect(first.transport).toBe("sfu");
    expect(first.mediaSessionId).toBe(second.mediaSessionId);
    // Idempotent: still exactly one router.
    expect(backend.hasRouter("call-1")).toBe(true);

    const conn = first.connection!;
    expect(conn["announcedIp"]).toBe(ANNOUNCED_IP);
    expect(conn["homeNodeId"]).toBe("local");
    const caps = JSON.parse(conn["routerRtpCapabilities"]!) as { codecs: unknown[] };
    expect(Array.isArray(caps.codecs)).toBe(true);

    // A different call gets a distinct router.
    const other = await adapter.allocateSession("call-2");
    expect(other.mediaSessionId).not.toBe(first.mediaSessionId);
  });

  it("issueJoinToken throws when no session is allocated", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.issueJoinToken("missing", A)).rejects.toBeInstanceOf(MediaPlaneError);
  });

  it("issueJoinToken creates send+recv transports and returns ICE/DTLS params + HMAC nonce", async () => {
    const now = 1_700_000_000_000;
    const ttl = 60_000;
    const { backend, adapter } = makeAdapter({ now: () => now, ttl });
    await adapter.allocateSession("call-1");

    const grant = await adapter.issueJoinToken("call-1", A);

    // Two transports created on the router (send + recv).
    expect(backend.transportCount("call-1")).toBe(2);

    expect(grant.callId).toBe("call-1");
    expect(grant.userId).toBe(A.userId);
    expect(grant.expiresAt).toBe(new Date(now + ttl).toISOString());

    const send = JSON.parse(grant.connection!.sendTransport) as SfuTransportParams;
    const recv = JSON.parse(grant.connection!.recvTransport) as SfuTransportParams;
    expect(send.id).not.toBe(recv.id);
    expect(send.iceParameters.usernameFragment).toBeTruthy();
    expect(send.iceCandidates[0]!.ip).toBe(ANNOUNCED_IP);
    expect(send.dtlsParameters.fingerprints.length).toBeGreaterThan(0);
    expect(grant.connection!.announcedIp).toBe(ANNOUNCED_IP);

    // Token is `<expirySeconds>.<base64url HMAC-SHA256(secret, callId:userId:deviceId:expirySeconds)>`.
    const expirySeconds = Math.floor((now + ttl) / 1000);
    const expectedMac = createHmac("sha256", SECRET)
      .update(`call-1:${A.userId}:${A.deviceId}:${expirySeconds}`)
      .digest("base64url");
    expect(grant.token).toBe(`${expirySeconds}.${expectedMac}`);
  });

  it("releaseSession closes the router and is idempotent", async () => {
    const { backend, adapter } = makeAdapter();
    await adapter.allocateSession("call-1");
    await adapter.issueJoinToken("call-1", A);
    expect(backend.hasRouter("call-1")).toBe(true);

    await adapter.releaseSession("call-1");
    await adapter.releaseSession("call-1"); // no throw on repeat
    expect(backend.hasRouter("call-1")).toBe(false);
    expect(adapter.hasSession("call-1")).toBe(false);
    await expect(adapter.issueJoinToken("call-1", A)).rejects.toBeInstanceOf(MediaPlaneError);
  });

  it("produce/consume throw without an allocated session", async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.produce("missing", A, "tok", "t", "audio", {}),
    ).rejects.toBeInstanceOf(MediaPlaneError);
    await expect(
      adapter.consume("missing", A, "tok", "t", "p", {}),
    ).rejects.toBeInstanceOf(MediaPlaneError);
    await expect(
      adapter.connectTransport("missing", A, "tok", "t", { fingerprints: [] }),
    ).rejects.toBeInstanceOf(MediaPlaneError);
  });

  it("full two-participant flow: A allocates, A+B join, A produces, B consumes A, release tears down", async () => {
    const { backend, adapter } = makeAdapter({ now: () => 1_700_000_000_000 });

    // A allocates the session (one router).
    await adapter.allocateSession("call-1");

    // A and B each get send+recv transports.
    const grantA = await adapter.issueJoinToken("call-1", A);
    const grantB = await adapter.issueJoinToken("call-1", B);
    expect(backend.transportCount("call-1")).toBe(4);

    const aSend = JSON.parse(grantA.connection!.sendTransport) as SfuTransportParams;
    const bRecv = JSON.parse(grantB.connection!.recvTransport) as SfuTransportParams;

    // A connects its send transport (DTLS) and produces audio.
    await adapter.connectTransport("call-1", A, grantA.token, aSend.id, aSend.dtlsParameters);
    expect(backend.isTransportConnected("call-1", aSend.id)).toBe(true);
    const producer = await adapter.produce("call-1", A, grantA.token, aSend.id, "audio", { codecs: [] });
    expect(producer.kind).toBe("audio");
    expect(backend.producerCount("call-1")).toBe(1);

    // B connects its recv transport and consumes A's producer.
    await adapter.connectTransport("call-1", B, grantB.token, bRecv.id, bRecv.dtlsParameters);
    const consumer = await adapter.consume("call-1", B, grantB.token, bRecv.id, producer.id, { codecs: [] });
    expect(consumer.producerId).toBe(producer.id);
    expect(consumer.kind).toBe("audio");

    // Release tears everything down.
    await adapter.releaseSession("call-1");
    expect(backend.hasRouter("call-1")).toBe(false);
    expect(backend.transportCount("call-1")).toBe(0);
  });

  // -- audit regressions ---------------------------------------------------

  it("rejects an empty/weak token secret at construction (sfu-media-7)", () => {
    const opts = {
      backend: new FakeSfuBackend(),
      announcedIp: ANNOUNCED_IP,
      mediaCodecs: [],
    };
    expect(() => new SfuMediaPlaneAdapter({ ...opts, tokenSecret: "" })).toThrow(MediaPlaneError);
    expect(() => new SfuMediaPlaneAdapter({ ...opts, tokenSecret: "short" })).toThrow(
      MediaPlaneError,
    );
    // A sufficiently long secret is accepted.
    expect(() => new SfuMediaPlaneAdapter({ ...opts, tokenSecret: SECRET })).not.toThrow();
  });

  it("verifyJoinToken accepts a fresh token and rejects forged/expired/foreign ones (sfu-media-1)", async () => {
    const now = 1_700_000_000_000;
    const { adapter } = makeAdapter({ now: () => now, ttl: 60_000 });
    await adapter.allocateSession("call-1");
    const grant = await adapter.issueJoinToken("call-1", A);

    // Valid: the token the adapter just minted for A on call-1.
    expect(() => adapter.verifyJoinToken("call-1", A, grant.token)).not.toThrow();

    // Forged signature.
    const [exp] = grant.token.split(".");
    expect(() => adapter.verifyJoinToken("call-1", A, `${exp}.deadbeef`)).toThrow(MediaPlaneError);

    // Wrong identity (B presenting A's token).
    expect(() => adapter.verifyJoinToken("call-1", B, grant.token)).toThrow(MediaPlaneError);

    // Wrong call.
    expect(() => adapter.verifyJoinToken("call-2", A, grant.token)).toThrow(MediaPlaneError);

    // Expired: mint a short-lived token, then verify with the same secret under
    // a clock past its expiry. (Same SECRET → signature still matches, so the
    // failure is the expiry check, not the MAC.)
    const minter = makeAdapter({ now: () => now, ttl: 1_000 }).adapter;
    await minter.allocateSession("call-1");
    const staleGrant = await minter.issueJoinToken("call-1", A);
    const late = makeAdapter({ now: () => now + 10_000 }).adapter;
    expect(() => late.verifyJoinToken("call-1", A, staleGrant.token)).toThrow(/expired/);
  });

  it("binds transports to their owner — B cannot act on A's transport (sfu-media-2)", async () => {
    const now = 1_700_000_000_000;
    const { adapter } = makeAdapter({ now: () => now, ttl: 60_000 });
    await adapter.allocateSession("call-1");
    const grantA = await adapter.issueJoinToken("call-1", A);
    const grantB = await adapter.issueJoinToken("call-1", B);
    const aSend = JSON.parse(grantA.connection!.sendTransport) as SfuTransportParams;
    const aRecv = JSON.parse(grantA.connection!.recvTransport) as SfuTransportParams;
    const bSend = JSON.parse(grantB.connection!.sendTransport) as SfuTransportParams;

    // B (valid token) cannot connect/produce/consume on A's transport.
    await expect(
      adapter.connectTransport("call-1", B, grantB.token, aSend.id, aSend.dtlsParameters),
    ).rejects.toBeInstanceOf(MediaPlaneError);
    await expect(
      adapter.produce("call-1", B, grantB.token, aSend.id, "audio", {}),
    ).rejects.toBeInstanceOf(MediaPlaneError);
    await expect(
      adapter.consume("call-1", B, grantB.token, aRecv.id, "producer-x", {}),
    ).rejects.toBeInstanceOf(MediaPlaneError);

    // Producing onto a *recv* transport (even your own) is rejected.
    await expect(
      adapter.produce("call-1", B, grantB.token, JSON.parse(grantB.connection!.recvTransport).id, "audio", {}),
    ).rejects.toBeInstanceOf(MediaPlaneError);

    // B acting on B's own send transport with a valid token is fine.
    await expect(
      adapter.connectTransport("call-1", B, grantB.token, bSend.id, bSend.dtlsParameters),
    ).resolves.toBeUndefined();
  });

  it("rejects ops presenting an invalid token even on an owned transport (sfu-media-1)", async () => {
    const { adapter } = makeAdapter({ now: () => 1_700_000_000_000 });
    await adapter.allocateSession("call-1");
    const grantA = await adapter.issueJoinToken("call-1", A);
    const aSend = JSON.parse(grantA.connection!.sendTransport) as SfuTransportParams;
    await expect(
      adapter.connectTransport("call-1", A, "not-a-real-token", aSend.id, aSend.dtlsParameters),
    ).rejects.toBeInstanceOf(MediaPlaneError);
  });

  it("closes a participant's transports on leave and reuses (no leak) on rejoin (sfu-media-3)", async () => {
    const { backend, adapter } = makeAdapter({ now: () => 1_700_000_000_000 });
    await adapter.allocateSession("call-1");

    await adapter.issueJoinToken("call-1", A);
    expect(backend.transportCount("call-1")).toBe(2);

    // Rejoin: the prior pair is replaced, not leaked → still 2.
    await adapter.issueJoinToken("call-1", A);
    expect(backend.transportCount("call-1")).toBe(2);

    // A second participant adds their own pair.
    await adapter.issueJoinToken("call-1", B);
    expect(backend.transportCount("call-1")).toBe(4);

    // A leaves → only A's two transports are reclaimed.
    await adapter.leaveParticipant("call-1", A);
    expect(backend.transportCount("call-1")).toBe(2);

    // Repeated join/leave churn never grows the transport count past 2.
    for (let i = 0; i < 5; i++) {
      await adapter.issueJoinToken("call-1", A);
      await adapter.leaveParticipant("call-1", A);
    }
    expect(backend.transportCount("call-1")).toBe(2); // only B remains
  });
});

describe("LocalMediaPlacement", () => {
  it("always homes the call on this node at the configured announced IP", async () => {
    const placement = new LocalMediaPlacement({ announcedIp: ANNOUNCED_IP });
    expect(await placement.placeFor("call-1")).toEqual({
      nodeId: "local",
      announcedIp: ANNOUNCED_IP,
    });
    // Same answer for any call (single-box).
    expect(await placement.placeFor("call-2")).toEqual({
      nodeId: "local",
      announcedIp: ANNOUNCED_IP,
    });
  });

  it("honors a custom node id", async () => {
    const placement = new LocalMediaPlacement({ nodeId: "box-7", announcedIp: "10.0.0.1" });
    expect((await placement.placeFor("c")).nodeId).toBe("box-7");
  });
});
