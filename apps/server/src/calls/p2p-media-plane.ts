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

/**
 * FR-81 — self-built one-to-one P2P WebRTC {@link MediaPlaneAdapter}.
 *
 * Media flows *directly* peer↔peer over WebRTC/SRTP — there is no media server.
 * The Frick server stays control-plane only: SDP/ICE ride the existing
 * `WebRTCSignal` relay, and this adapter's sole networking-adjacent job is to
 * hand each joining participant a set of ICE servers (STUN for reflexive
 * candidates, optional TURN for relayed candidates when a direct path can't be
 * established through NAT).
 *
 * TURN credentials are minted with the standard **coturn REST convention**
 * (a.k.a. the "TURN REST API" / `use-auth-secret` mode): a TURN server
 * configured with a shared secret accepts any
 * `username = "<unixExpirySeconds>:<userId>"` whose `credential` is
 * `base64(HMAC-SHA1(sharedSecret, username))`. This lets us issue *ephemeral*,
 * per-participant TURN credentials with zero round-trips to the TURN server and
 * no per-user provisioning — the TURN server validates them statelessly. See
 * the coturn docs for `static-auth-secret` / `--use-auth-secret`.
 *
 * Like {@link FakeMediaPlaneAdapter}, this adapter does **no networking** of its
 * own and is fully deterministic under an injected clock: `allocateSession` is a
 * cheap idempotent in-memory handle, `issueJoinToken` derives credentials purely
 * from the configured secret + clock + ttl, and `releaseSession` drops the
 * handle. That determinism is what lets the call-lifecycle tests assert exact
 * ICE payloads without standing up coturn.
 */

/** A STUN/TURN/TURNS server entry, mirroring the WebRTC `RTCIceServer` shape. */
export interface P2PIceServer {
  /** One url or a list of urls (e.g. `stun:stun.example.org:3478`). */
  readonly urls: string | readonly string[];
  /** Long-term username (minted for TURN; absent for STUN). */
  readonly username?: string;
  /** Long-term credential (minted for TURN; absent for STUN). */
  readonly credential?: string;
}

/** TURN configuration enabling ephemeral coturn-REST credential minting. */
export interface P2PTurnConfig {
  /**
   * TURN/TURNS url(s) clients should use, e.g.
   * `["turn:turn.example.org:3478", "turns:turn.example.org:5349"]`.
   */
  readonly urls: string | readonly string[];
  /**
   * Shared secret the TURN server is configured with (`static-auth-secret` /
   * `--use-auth-secret`). Used as the HMAC-SHA1 key — never sent to clients.
   */
  readonly sharedSecret: string;
  /** Optional TURN realm, echoed onto the grant connection metadata. */
  readonly realm?: string;
}

export interface P2PMediaPlaneOptions {
  /**
   * Base STUN ICE servers exposed to every participant verbatim (no creds).
   * Defaults to a single Google public STUN server so a fresh install still
   * negotiates. Pass `[]` to expose no STUN.
   */
  readonly iceServers?: readonly P2PIceServer[];
  /**
   * TURN config. When omitted the adapter returns STUN-only ICE servers — still
   * a valid configuration (many P2P connections succeed STUN-only).
   */
  readonly turn?: P2PTurnConfig;
  /** Default join-token / TURN-credential lifetime in ms. Defaults to 5 minutes. */
  readonly defaultTokenTtlMs?: number;
  /** Injectable clock for deterministic `expiresAt` + TURN expiry. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STUN: readonly P2PIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

interface AllocatedSession extends MediaSession {
  /** Monotonic ordinal, mirrors the fake so handles are ordered/deterministic. */
  readonly ordinal: number;
}

export class P2PWebRTCAdapter implements MediaPlaneAdapter {
  readonly #iceServers: readonly P2PIceServer[];
  readonly #turn: P2PTurnConfig | undefined;
  readonly #defaultTokenTtlMs: number;
  readonly #now: () => number;
  /** Live sessions keyed by call id. A released call drops out of the map. */
  readonly #sessions = new Map<string, AllocatedSession>();
  /** Monotonic counter feeding deterministic session ids. */
  #counter = 0;

  constructor(options: P2PMediaPlaneOptions = {}) {
    this.#iceServers = options.iceServers ?? DEFAULT_STUN;
    this.#turn = options.turn;
    this.#defaultTokenTtlMs = options.defaultTokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  describe(): MediaPlaneCapabilities {
    return { transport: "p2p", maxParticipants: 2, supportsRegionHint: false };
  }

  async allocateSession(
    callId: string,
    _options: AllocateSessionOptions = {},
  ): Promise<MediaSession> {
    // Idempotent per call id: a second allocate for a still-live call returns
    // the existing handle rather than minting a second one. No networking — a
    // P2P "session" is just a logical id the two peers correlate signaling on.
    void _options;
    const existing = this.#sessions.get(callId);
    if (existing) {
      return this.#publicSession(existing);
    }
    const ordinal = ++this.#counter;
    const session: AllocatedSession = {
      callId,
      mediaSessionId: `p2p-${callId}-${ordinal}`,
      transport: "p2p",
      // P2P carries no media-server-specific connection metadata: the only
      // per-participant connection info (ICE servers) is minted at join time.
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
    const ttlMs = options.ttlMs ?? this.#defaultTokenTtlMs;
    const nowMs = this.#now();
    const expiryMs = nowMs + ttlMs;
    const iceServers = this.#buildIceServers(participant.userId, expiryMs);
    const serialized = JSON.stringify(iceServers);
    const connection: Record<string, string> = { iceServers: serialized };
    if (this.#turn?.realm !== undefined) {
      connection.turnRealm = this.#turn.realm;
    }
    return {
      callId,
      mediaSessionId: session.mediaSessionId,
      userId: participant.userId,
      deviceId: participant.deviceId,
      // For P2P the "token" *is* the ICE configuration (there is no bearer
      // token to present to a media server). Mirror it into `connection.iceServers`
      // too so clients have one canonical place to parse.
      token: serialized,
      expiresAt: new Date(expiryMs).toISOString(),
      connection,
    };
  }

  async releaseSession(callId: string): Promise<void> {
    // Idempotent — releasing an unknown/already-released call is a no-op.
    this.#sessions.delete(callId);
  }

  /** Test/inspection helper: is a session currently allocated for this call? */
  hasSession(callId: string): boolean {
    return this.#sessions.has(callId);
  }

  /**
   * Compose the participant's ICE servers: the configured STUN entries verbatim
   * (no creds), plus — when TURN is configured — a TURN/TURNS entry carrying a
   * freshly minted ephemeral coturn-REST credential pair.
   */
  #buildIceServers(userId: string, expiryMs: number): P2PIceServer[] {
    const servers: P2PIceServer[] = this.#iceServers.map((server) => ({ ...server }));
    if (!this.#turn) {
      return servers;
    }
    const expirySeconds = Math.floor(expiryMs / 1000);
    const username = `${expirySeconds}:${userId}`;
    const credential = createHmac("sha1", this.#turn.sharedSecret)
      .update(username)
      .digest("base64");
    servers.push({ urls: this.#turn.urls, username, credential });
    return servers;
  }

  #publicSession(session: AllocatedSession): MediaSession {
    const { ordinal: _ordinal, ...rest } = session;
    void _ordinal;
    return rest;
  }
}
