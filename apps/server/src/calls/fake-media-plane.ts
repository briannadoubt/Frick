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
 * FR-78 — Deterministic in-memory {@link MediaPlaneAdapter} for tests and local
 * development. It does **no networking**: sessions and tokens are derived purely
 * from the call id, participant identity, and an injectable clock + monotonic
 * counter, so the same sequence of calls always yields identical ids and
 * tokens. That determinism is what lets the call-lifecycle tests (FR-79) assert
 * exact event payloads without mocking a real SFU.
 */
export interface FakeMediaPlaneOptions {
  /**
   * Transport this fake advertises. Defaults to `"sfu"` (no participant cap).
   * Pass `"p2p"` to exercise the 2-participant capability the control plane
   * branches on.
   */
  readonly transport?: "p2p" | "sfu";
  /** Injectable clock for deterministic `expiresAt`. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Default join-token lifetime in ms. Defaults to 5 minutes. */
  readonly defaultTokenTtlMs?: number;
}

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

interface AllocatedSession extends MediaSession {
  /** Monotonic ordinal, also used to make tokens unique + ordered. */
  readonly ordinal: number;
}

export class FakeMediaPlaneAdapter implements MediaPlaneAdapter {
  readonly #transport: "p2p" | "sfu";
  readonly #now: () => number;
  readonly #defaultTokenTtlMs: number;
  /** Live sessions keyed by call id. A released call drops out of the map. */
  readonly #sessions = new Map<string, AllocatedSession>();
  /** Monotonic counter feeding deterministic session/token ids. */
  #counter = 0;
  /** Per-(call, participant) token ordinal so re-issued tokens differ. */
  readonly #tokenCounts = new Map<string, number>();

  constructor(options: FakeMediaPlaneOptions = {}) {
    this.#transport = options.transport ?? "sfu";
    this.#now = options.now ?? Date.now;
    this.#defaultTokenTtlMs = options.defaultTokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  }

  describe(): MediaPlaneCapabilities {
    return this.#transport === "p2p"
      ? { transport: "p2p", maxParticipants: 2, supportsRegionHint: false }
      : { transport: "sfu", supportsRegionHint: true };
  }

  async allocateSession(
    callId: string,
    options: AllocateSessionOptions = {},
  ): Promise<MediaSession> {
    // Idempotent per call id: a second allocate for a still-live call returns
    // the existing room rather than spinning up a second one.
    const existing = this.#sessions.get(callId);
    if (existing) {
      return this.#publicSession(existing);
    }
    const ordinal = ++this.#counter;
    const supportsRegion = this.describe().supportsRegionHint;
    const region = supportsRegion ? options.regionHint ?? "local" : undefined;
    const session: AllocatedSession = {
      callId,
      mediaSessionId: `fake-room-${callId}-${ordinal}`,
      transport: this.#transport,
      ...(region !== undefined ? { region } : {}),
      connection: { signalingUrl: `fake://media/${callId}` },
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
    const participantKey = `${callId}::${participant.userId}::${participant.deviceId}`;
    const tokenOrdinal = (this.#tokenCounts.get(participantKey) ?? 0) + 1;
    this.#tokenCounts.set(participantKey, tokenOrdinal);
    const ttlMs = options.ttlMs ?? this.#defaultTokenTtlMs;
    const expiresAt = new Date(this.#now() + ttlMs).toISOString();
    return {
      callId,
      mediaSessionId: session.mediaSessionId,
      userId: participant.userId,
      deviceId: participant.deviceId,
      token: `fake-token.${session.mediaSessionId}.${participant.userId}.${participant.deviceId}.${tokenOrdinal}`,
      expiresAt,
      connection: { iceServers: "fake://turn" },
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

  #publicSession(session: AllocatedSession): MediaSession {
    const { ordinal: _ordinal, ...rest } = session;
    void _ordinal;
    return rest;
  }
}
