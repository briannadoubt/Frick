import { createHmac, timingSafeEqual } from "node:crypto";

import {
  MediaPlaneError,
  type AllocateSessionOptions,
  type IssueJoinTokenOptions,
  type MediaJoinGrant,
  type MediaParticipant,
  type MediaPlaneAdapter,
  type MediaPlaneCapabilities,
  type MediaSession,
} from "./media-plane.js";
import { LocalMediaPlacement, type MediaPlacement } from "./media-placement.js";
import {
  type ConsumerHandle,
  type DtlsParameters,
  type MediaKind,
  type ProducerHandle,
  type RtpCapabilities,
  type RtpParameters,
  type SfuBackend,
  type SfuCodec,
  type TransportHandle,
} from "./sfu-backend.js";

/**
 * FR-83 — self-hosted, single-box **mediasoup SFU** {@link MediaPlaneAdapter}.
 *
 * A sibling of {@link FakeMediaPlaneAdapter} / `P2PWebRTCAdapter`: the control
 * plane drives it through the exact same four-method seam. Unlike P2P, media is
 * forwarded by a server-side SFU (one mediasoup router per call), so this adapter
 * provisions real server-side media state through an injected {@link SfuBackend}.
 *
 * It is **opt-in**: wire it via the existing `calls: { mediaPlane }` server
 * option. Nothing default changes. The native mediasoup dependency is isolated
 * inside {@link MediasoupSfuBackend} (lazy `import("mediasoup")`); this adapter
 * and all its tests run against the deterministic {@link FakeSfuBackend}.
 *
 * **What the grant carries.** Because `MediaJoinGrant` only has `token: string`
 * + `connection?: Record<string,string>`, all structured SFU params are
 * JSON-serialized into `connection`:
 *  - `allocateSession` → `MediaSession.connection` carries the *bootstrap*: the
 *    router RTP capabilities (so the client can `Device.load()`), the home node,
 *    and the announced media address.
 *  - `issueJoinToken` → `connection` carries the participant's **send** and
 *    **recv** WebRtcTransport params (id, ICE params/candidates, DTLS params),
 *    each JSON-serialized; `token` is a short-lived HMAC auth nonce
 *    (`HMAC(secret, callId:userId:deviceId:expiry)`, coturn-REST-style) the
 *    client presents on its produce/consume calls.
 *
 * **Produce/consume.** The server-side produce/consume lifecycle is exposed as
 * methods on this adapter (a thin companion to the four-method seam): a client
 * connects its transports ({@link connectTransport}), produces its tracks
 * ({@link produce}), and consumes other participants' producers
 * ({@link consume}). These drive the same {@link SfuBackend}. The browser-side
 * driver that calls them is FR-15 client work (see CHANGELOG / follow-up).
 */

/** Structured transport bootstrap a client needs to build one mediasoup transport. */
export interface SfuTransportParams {
  readonly id: string;
  readonly iceParameters: TransportHandle["iceParameters"];
  readonly iceCandidates: readonly TransportHandle["iceCandidates"][number][];
  readonly dtlsParameters: DtlsParameters;
}

export interface SfuMediaPlaneOptions {
  /** Drives the mediasoup lifecycle. Inject {@link FakeSfuBackend} in tests. */
  readonly backend: SfuBackend;
  /**
   * Resolves the home node + announced media IP for a call. Defaults to a
   * {@link LocalMediaPlacement} built from {@link announcedIp} (single-box).
   * FR-154 injects the bus-coordinated impl here.
   */
  readonly placement?: MediaPlacement;
  /**
   * Announced media IP advertised in ICE candidates. Used to build the default
   * {@link LocalMediaPlacement} when {@link placement} is omitted. Required when
   * {@link placement} is not supplied.
   */
  readonly announcedIp?: string;
  /** Media codecs the per-call routers are configured with. */
  readonly mediaCodecs: readonly SfuCodec[];
  /** HMAC secret for minting the short-lived join auth nonce. Never sent to clients. */
  readonly tokenSecret: string;
  /** Default join-token lifetime in ms. Defaults to 5 minutes. */
  readonly defaultTokenTtlMs?: number;
  /** Injectable clock for deterministic `expiresAt` + nonce expiry. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Optional *soft* participant cap surfaced in {@link describe}. No hard cap by
   * default (an SFU is bounded only by capacity).
   */
  readonly softMaxParticipants?: number;
}

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Minimum acceptable byte-length for the HMAC token secret. An empty or very
 * short secret makes the minted join nonce trivially forgeable (HMAC with a
 * guessable/empty key), so the adapter fails closed at construction rather than
 * issuing weak credentials (sfu-media-7).
 */
const MIN_TOKEN_SECRET_BYTES = 16;

interface AllocatedSession extends MediaSession {
  readonly ordinal: number;
}

/**
 * The per-participant media resources minted for one (userId,deviceId) on a
 * call's router. We bind the send/recv transport ids to their owner so the
 * control plane can assert a participant only acts on *their own* transports
 * (calls-media-1 / sfu-media-2), and so we can close exactly these on leave /
 * re-join without leaking router-level transports (sfu-media-3).
 */
interface ParticipantMedia {
  readonly userId: string;
  readonly deviceId: string;
  sendTransportId: string;
  recvTransportId: string;
  /** Producer ids the participant created on their send transport. */
  readonly producerIds: Set<string>;
  /** Consumer ids delivered onto the participant's recv transport. */
  readonly consumerIds: Set<string>;
}

export class SfuMediaPlaneAdapter implements MediaPlaneAdapter {
  readonly #backend: SfuBackend;
  readonly #placement: MediaPlacement;
  readonly #mediaCodecs: readonly SfuCodec[];
  readonly #tokenSecret: string;
  readonly #defaultTokenTtlMs: number;
  readonly #now: () => number;
  readonly #softMax: number | undefined;
  readonly #sessions = new Map<string, AllocatedSession>();
  /**
   * Per-call, per-participant media bindings, keyed by callId then by
   * `${userId}:${deviceId}`. Used to enforce transport ownership and to tear a
   * participant's transports/producers/consumers down on leave/re-join.
   */
  readonly #participants = new Map<string, Map<string, ParticipantMedia>>();
  #counter = 0;

  constructor(options: SfuMediaPlaneOptions) {
    this.#backend = options.backend;
    if (options.placement) {
      this.#placement = options.placement;
    } else if (options.announcedIp !== undefined) {
      this.#placement = new LocalMediaPlacement({ announcedIp: options.announcedIp });
    } else {
      throw new MediaPlaneError(
        "SfuMediaPlaneAdapter requires either `placement` or `announcedIp`",
      );
    }
    // Fail closed on an empty/weak token secret rather than silently minting
    // forgeable join nonces (sfu-media-7).
    if (Buffer.byteLength(options.tokenSecret ?? "", "utf8") < MIN_TOKEN_SECRET_BYTES) {
      throw new MediaPlaneError(
        `SfuMediaPlaneAdapter requires a tokenSecret of at least ${MIN_TOKEN_SECRET_BYTES} bytes`,
      );
    }
    this.#mediaCodecs = options.mediaCodecs;
    this.#tokenSecret = options.tokenSecret;
    this.#defaultTokenTtlMs = options.defaultTokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#softMax = options.softMaxParticipants;
  }

  describe(): MediaPlaneCapabilities {
    return {
      transport: "sfu",
      supportsRegionHint: false,
      ...(this.#softMax !== undefined ? { maxParticipants: this.#softMax } : {}),
    };
  }

  async allocateSession(
    callId: string,
    _options: AllocateSessionOptions = {},
  ): Promise<MediaSession> {
    void _options;
    // Idempotent per call id: ensureRouter is itself idempotent, but we also
    // cache the public session so the bootstrap connection metadata is stable.
    const existing = this.#sessions.get(callId);
    if (existing) {
      return this.#publicSession(existing);
    }
    const router = await this.#backend.ensureRouter(callId);
    const rtpCapabilities = await this.#backend.getRouterRtpCapabilities(callId);
    const home = await this.#placement.placeFor(callId);
    const ordinal = ++this.#counter;
    const session: AllocatedSession = {
      callId,
      mediaSessionId: router.id,
      transport: "sfu",
      connection: {
        // Bootstrap the client needs before joining: load these into the
        // mediasoup-client Device, then connect transports to `announcedIp`.
        routerRtpCapabilities: JSON.stringify(rtpCapabilities),
        homeNodeId: home.nodeId,
        announcedIp: home.announcedIp,
      },
      ordinal,
    };
    this.#sessions.set(callId, session);
    return this.#publicSession(session);
  }

  async issueJoinToken(
    callId: string,
    participant: MediaParticipant,
    options: IssueJoinTokenOptions = {},
  ): Promise<MediaJoinGrant> {
    const session = this.#sessions.get(callId);
    if (!session) {
      throw new MediaPlaneError(
        `Cannot issue a join token: no media session allocated for call ${callId}`,
      );
    }
    const home = await this.#placement.placeFor(callId);

    // Idempotent per (callId,userId,deviceId): a rejoining participant releases
    // their previously-minted transports/producers/consumers before we mint a
    // fresh pair, so repeated join/leave can't leak router-level transports
    // (sfu-media-3).
    await this.#closeParticipantMedia(callId, participant.userId, participant.deviceId);

    // Create the participant's send + recv transports on the call's router.
    const send = await this.#backend.createWebRtcTransport({
      callId,
      announcedIp: home.announcedIp,
      direction: "send",
    });
    const recv = await this.#backend.createWebRtcTransport({
      callId,
      announcedIp: home.announcedIp,
      direction: "recv",
    });

    // Record the owning identity for each transport so connect/produce/consume
    // can assert the actor owns the transport they operate on (sfu-media-2).
    this.#participantsFor(callId).set(this.#participantKey(participant.userId, participant.deviceId), {
      userId: participant.userId,
      deviceId: participant.deviceId,
      sendTransportId: send.id,
      recvTransportId: recv.id,
      producerIds: new Set(),
      consumerIds: new Set(),
    });

    const ttlMs = options.ttlMs ?? this.#defaultTokenTtlMs;
    const expiryMs = this.#now() + ttlMs;
    const token = this.#mintNonce(callId, participant, expiryMs);

    return {
      callId,
      mediaSessionId: session.mediaSessionId,
      userId: participant.userId,
      deviceId: participant.deviceId,
      token,
      expiresAt: new Date(expiryMs).toISOString(),
      connection: {
        sendTransport: JSON.stringify(this.#transportParams(send)),
        recvTransport: JSON.stringify(this.#transportParams(recv)),
        routerRtpCapabilities: session.connection!["routerRtpCapabilities"]!,
        announcedIp: home.announcedIp,
      },
    };
  }

  async releaseSession(callId: string): Promise<void> {
    // Idempotent — closeRouter tears down the router + its transports/producers/
    // consumers and is a no-op for an unknown call.
    await this.#backend.closeRouter(callId);
    this.#sessions.delete(callId);
    this.#participants.delete(callId);
  }

  /**
   * Tear down a single participant's media (transports + their producers/
   * consumers) without ending the whole call. Called by the control plane on
   * `leave` so a participant's send/recv transports are reclaimed immediately
   * instead of lingering until the call ends (sfu-media-3). Idempotent.
   */
  async leaveParticipant(callId: string, participant: MediaParticipant): Promise<void> {
    await this.#closeParticipantMedia(callId, participant.userId, participant.deviceId);
  }

  /**
   * Re-derive the join nonce for `(callId, actor)` and verify it matches `token`
   * (constant-time) and has not expired. Throws {@link MediaPlaneError} on a
   * malformed, forged, or expired token. This is the credential check the
   * documented contract promised but never enforced (calls-token-1 /
   * sfu-media-1): produce/consume/connect now require a valid nonce, so expiry
   * and the `callId:userId:deviceId` binding are actually enforced.
   */
  verifyJoinToken(callId: string, actor: MediaParticipant, token: string): void {
    const dot = token.indexOf(".");
    if (dot <= 0) {
      throw new MediaPlaneError("Malformed SFU join token");
    }
    const expirySeconds = Number(token.slice(0, dot));
    if (!Number.isFinite(expirySeconds) || !Number.isInteger(expirySeconds)) {
      throw new MediaPlaneError("Malformed SFU join token expiry");
    }
    if (this.#now() >= expirySeconds * 1000) {
      throw new MediaPlaneError("SFU join token has expired");
    }
    const expected = this.#mintNonce(callId, actor, expirySeconds * 1000);
    const got = Buffer.from(token, "utf8");
    const want = Buffer.from(expected, "utf8");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new MediaPlaneError("SFU join token failed verification");
    }
  }

  // -- produce/consume companion -------------------------------------------
  //
  // These are the server-side half of the SFU media path. A client, after
  // building its transports from the join grant, calls connect → produce →
  // consume through the control surface that forwards to these. They throw if
  // the call has no allocated session (mirrors the four-method seam).

  /** Complete a transport's DTLS handshake with the client's dtlsParameters. */
  async connectTransport(
    callId: string,
    actor: MediaParticipant,
    token: string,
    transportId: string,
    dtlsParameters: DtlsParameters,
  ): Promise<void> {
    this.#requireSession(callId);
    this.verifyJoinToken(callId, actor, token);
    // A participant may only connect a transport they own (their own send or
    // recv transport) — never another participant's (sfu-media-2).
    this.#requireOwnedTransport(callId, actor, transportId);
    await this.#backend.connectTransport({ callId, transportId, dtlsParameters });
  }

  /** Start producing one of a participant's tracks on its send transport. */
  async produce(
    callId: string,
    actor: MediaParticipant,
    token: string,
    transportId: string,
    kind: MediaKind,
    rtpParameters: RtpParameters,
  ): Promise<ProducerHandle> {
    this.#requireSession(callId);
    this.verifyJoinToken(callId, actor, token);
    // Producing is only allowed on the actor's own *send* transport: this stops
    // B from attaching a producer to A's transport (calls-media-1).
    const media = this.#requireOwnedTransport(callId, actor, transportId);
    if (transportId !== media.sendTransportId) {
      throw new MediaPlaneError(
        `Transport ${transportId} is not the actor's send transport on call ${callId}`,
      );
    }
    const producer = await this.#backend.produce({ callId, transportId, kind, rtpParameters });
    media.producerIds.add(producer.id);
    return producer;
  }

  /** Consume another participant's producer onto this participant's recv transport. */
  async consume(
    callId: string,
    actor: MediaParticipant,
    token: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities,
  ): Promise<ConsumerHandle> {
    this.#requireSession(callId);
    this.verifyJoinToken(callId, actor, token);
    // Consuming is only allowed onto the actor's own *recv* transport: this
    // stops B from steering consumers onto A's recv transport (sfu-media-2).
    const media = this.#requireOwnedTransport(callId, actor, transportId);
    if (transportId !== media.recvTransportId) {
      throw new MediaPlaneError(
        `Transport ${transportId} is not the actor's recv transport on call ${callId}`,
      );
    }
    const consumer = await this.#backend.consume({ callId, transportId, producerId, rtpCapabilities });
    media.consumerIds.add(consumer.id);
    return consumer;
  }

  /** Test/inspection helper: is a session currently allocated for this call? */
  hasSession(callId: string): boolean {
    return this.#sessions.has(callId);
  }

  /** The codecs configured on this adapter (also passed to a real backend). */
  get mediaCodecs(): readonly SfuCodec[] {
    return this.#mediaCodecs;
  }

  // -- internals -----------------------------------------------------------

  /**
   * Mint a short-lived auth nonce binding the participant to the call + expiry,
   * coturn-REST-style: `base64(HMAC-SHA256(secret, "callId:userId:deviceId:expirySeconds"))`.
   * The server re-derives and checks it (and the expiry) on produce/consume.
   */
  #mintNonce(callId: string, participant: MediaParticipant, expiryMs: number): string {
    const expirySeconds = Math.floor(expiryMs / 1000);
    const message = `${callId}:${participant.userId}:${participant.deviceId}:${expirySeconds}`;
    const mac = createHmac("sha256", this.#tokenSecret).update(message).digest("base64url");
    return `${expirySeconds}.${mac}`;
  }

  #participantKey(userId: string, deviceId: string): string {
    return `${userId}:${deviceId}`;
  }

  #participantsFor(callId: string): Map<string, ParticipantMedia> {
    let map = this.#participants.get(callId);
    if (!map) {
      map = new Map();
      this.#participants.set(callId, map);
    }
    return map;
  }

  /**
   * Resolve the actor's media binding and assert `transportId` is one of *their*
   * transports. Throws if the actor has no live binding on the call or the
   * transport belongs to a different participant.
   */
  #requireOwnedTransport(
    callId: string,
    actor: MediaParticipant,
    transportId: string,
  ): ParticipantMedia {
    const media = this.#participants
      .get(callId)
      ?.get(this.#participantKey(actor.userId, actor.deviceId));
    if (!media) {
      throw new MediaPlaneError(
        `${actor.userId}/${actor.deviceId} has no media session on call ${callId}`,
      );
    }
    if (transportId !== media.sendTransportId && transportId !== media.recvTransportId) {
      throw new MediaPlaneError(
        `Transport ${transportId} is not owned by ${actor.userId}/${actor.deviceId} on call ${callId}`,
      );
    }
    return media;
  }

  /**
   * Close a participant's send/recv transports (and their producers/consumers)
   * on the backend and drop the binding. Idempotent: a no-op when the
   * participant has no live binding.
   */
  async #closeParticipantMedia(callId: string, userId: string, deviceId: string): Promise<void> {
    const map = this.#participants.get(callId);
    const key = this.#participantKey(userId, deviceId);
    const media = map?.get(key);
    if (!media || !map) {
      return;
    }
    map.delete(key);
    // Closing a transport tears down its producers/consumers, but close them
    // explicitly too so a backend that doesn't cascade still reclaims them.
    for (const consumerId of media.consumerIds) {
      await this.#backend.closeConsumer(callId, consumerId);
    }
    for (const producerId of media.producerIds) {
      await this.#backend.closeProducer(callId, producerId);
    }
    await this.#backend.closeTransport(callId, media.sendTransportId);
    await this.#backend.closeTransport(callId, media.recvTransportId);
  }

  #transportParams(t: TransportHandle): SfuTransportParams {
    return {
      id: t.id,
      iceParameters: t.iceParameters,
      iceCandidates: t.iceCandidates,
      dtlsParameters: t.dtlsParameters,
    };
  }

  #requireSession(callId: string): AllocatedSession {
    const session = this.#sessions.get(callId);
    if (!session) {
      throw new MediaPlaneError(`No media session allocated for call ${callId}`);
    }
    return session;
  }

  #publicSession(session: AllocatedSession): MediaSession {
    const { ordinal: _ordinal, ...rest } = session;
    void _ordinal;
    return rest;
  }
}

/**
 * A sensible default mediasoup codec set (Opus audio + VP8/H264 video) operators
 * can pass to {@link SfuMediaPlaneAdapter} / {@link MediasoupSfuBackend} without
 * hand-rolling RTP config.
 */
export const DEFAULT_SFU_MEDIA_CODECS: readonly SfuCodec[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
  },
];
