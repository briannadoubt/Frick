import { createHmac } from "node:crypto";

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

interface AllocatedSession extends MediaSession {
  readonly ordinal: number;
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
    transportId: string,
    dtlsParameters: DtlsParameters,
  ): Promise<void> {
    this.#requireSession(callId);
    await this.#backend.connectTransport({ callId, transportId, dtlsParameters });
  }

  /** Start producing one of a participant's tracks on its send transport. */
  async produce(
    callId: string,
    transportId: string,
    kind: MediaKind,
    rtpParameters: RtpParameters,
  ): Promise<ProducerHandle> {
    this.#requireSession(callId);
    return this.#backend.produce({ callId, transportId, kind, rtpParameters });
  }

  /** Consume another participant's producer onto this participant's recv transport. */
  async consume(
    callId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities,
  ): Promise<ConsumerHandle> {
    this.#requireSession(callId);
    return this.#backend.consume({ callId, transportId, producerId, rtpCapabilities });
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
