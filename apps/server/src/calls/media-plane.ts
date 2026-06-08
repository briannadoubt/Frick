/**
 * FR-78 — Media-plane adapter boundary.
 *
 * The {@link MediaPlaneAdapter} is the seam between Frick's call *control plane*
 * (FR-79: CallRoom / CallInvite lifecycle, durable call events, signaling) and
 * whatever actually moves real-time media bytes. Media never travels through
 * Frick sync — it rides WebRTC/SRTP, brokered either peer-to-peer or through a
 * Selective Forwarding Unit (SFU). This interface keeps the control plane
 * ignorant of *which* of those it is, so the same lifecycle code drives a
 * future `P2PWebRTCAdapter` (FR-81) and an `SfuAdapter` (FR-83) without change.
 *
 * Design intent (kept deliberately small):
 *  - `allocateSession(callId, ...)` — reserve a media room/session for a call.
 *    For a P2P adapter this is essentially a no-op handle; for an SFU it
 *    provisions a server-side room in a region. Returns a {@link MediaSession}.
 *  - `issueJoinToken(callId, participant, ...)` — mint the short-lived,
 *    participant-scoped credential a client presents to the media plane to join
 *    (an SFU access token, or P2P TURN credentials). Returns a
 *    {@link MediaJoinGrant}.
 *  - `releaseSession(callId)` — tear the media room down when the call ends.
 *  - `describe()` — static capabilities so the control plane can branch (e.g.
 *    a P2P adapter advertises `maxParticipants: 2`).
 *
 * Everything is `Promise`-returning so a real adapter can do network I/O; the
 * {@link FakeMediaPlaneAdapter} resolves synchronously and deterministically.
 */

/** Topology a media-plane adapter brokers. */
export type MediaPlaneTransport = "p2p" | "sfu";

/** Static description of an adapter's capabilities. */
export interface MediaPlaneCapabilities {
  /** Which transport this adapter brokers. */
  readonly transport: MediaPlaneTransport;
  /**
   * Hard cap on participants a single session supports, or `undefined` for no
   * fixed cap (an SFU bounded only by capacity). A P2P adapter reports `2`.
   */
  readonly maxParticipants?: number;
  /** True when the adapter can place rooms in a caller-hinted region. */
  readonly supportsRegionHint: boolean;
}

/** A participant the media plane issues credentials for. */
export interface MediaParticipant {
  readonly userId: string;
  readonly deviceId: string;
}

/**
 * Handle to a media room/session allocated for a call. `transport` lets the
 * control plane (and clients, indirectly) know which concrete topology owns it;
 * `region` echoes back where it was placed when a hint was honored.
 */
export interface MediaSession {
  readonly callId: string;
  /** Opaque, adapter-assigned room/session id (e.g. an SFU room name). */
  readonly mediaSessionId: string;
  readonly transport: MediaPlaneTransport;
  readonly region?: string;
  /**
   * Adapter-specific connection metadata a client needs *before* it has a
   * per-participant token (e.g. an SFU's signaling URL). Kept opaque so the
   * control plane forwards it without interpreting it.
   */
  readonly connection?: Readonly<Record<string, string>>;
}

/**
 * A short-lived credential a participant presents to the media plane to join.
 * `token` is the bearer credential (SFU access token, or a serialized TURN
 * credential set for P2P); `expiresAt` is an ISO-8601 instant after which it
 * must be refreshed.
 */
export interface MediaJoinGrant {
  readonly callId: string;
  readonly mediaSessionId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly expiresAt: string;
  /**
   * Optional connection metadata scoped to this grant (e.g. ICE servers /
   * TURN URLs for a P2P adapter). Opaque to the control plane.
   */
  readonly connection?: Readonly<Record<string, string>>;
}

export interface AllocateSessionOptions {
  /** Preferred region for the media room; honored only if supported. */
  readonly regionHint?: string;
  /** Upper bound on expected participants, for capacity planning. */
  readonly expectedParticipants?: number;
}

export interface IssueJoinTokenOptions {
  /** Requested credential lifetime in ms. The adapter may clamp it. */
  readonly ttlMs?: number;
}

/**
 * The media-plane boundary. Implementations broker real media; the control
 * plane only ever calls these four methods plus {@link describe}.
 */
export interface MediaPlaneAdapter {
  /** Static capabilities; safe to call without allocating anything. */
  describe(): MediaPlaneCapabilities;

  /**
   * Reserve a media room/session for `callId`. Idempotent per call id: calling
   * twice for the same live call returns the same {@link MediaSession} rather
   * than provisioning a second room.
   */
  allocateSession(callId: string, options?: AllocateSessionOptions): Promise<MediaSession>;

  /**
   * Mint a participant-scoped join credential for an already-allocated session.
   * Throws {@link MediaPlaneError} if no session is allocated for `callId` (the
   * control plane always allocates before inviting/joining).
   */
  issueJoinToken(
    callId: string,
    participant: MediaParticipant,
    options?: IssueJoinTokenOptions,
  ): Promise<MediaJoinGrant>;

  /**
   * Tear down the media room for `callId`. Idempotent: releasing an unknown or
   * already-released call is a no-op (so a duplicated `end` is safe).
   */
  releaseSession(callId: string): Promise<void>;
}

/** Raised by an adapter when an operation can't be honored. */
export class MediaPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaPlaneError";
  }
}
