import { randomUUID } from "node:crypto";
import type { PlainObject } from "@fricken/protocol";
import type { FrickStore } from "../store.js";
import { DEFAULT_TENANT_ID } from "../tenant.js";
import {
  DEFAULT_CALL_TYPE_NAMES,
  type CallInviteState,
  type CallRoomState,
  type CallTypeNames,
} from "./call-schema.js";
import {
  type MediaJoinGrant,
  type MediaParticipant,
  type MediaPlaneAdapter,
} from "./media-plane.js";
import type {
  ConsumerHandle,
  DtlsParameters,
  MediaKind,
  ProducerHandle,
  RtpCapabilities,
  RtpParameters,
} from "./sfu-backend.js";

/**
 * FR-79 — Call control-plane state machine.
 *
 * Owns the server-authoritative lifecycle of a call:
 *
 *   create → (per invitee) ringing → accept/join → leave → end
 *
 * It persists `CallRoom`, `CallInvite`, and `CallParticipant` as object records
 * through {@link FrickStore} (so they sync to clients like any other object),
 * appends durable lifecycle events to the `CallEventStream` (so a late joiner
 * or a reconnecting client can replay exactly what happened), and brokers the
 * media plane through a {@link MediaPlaneAdapter} (FR-78) — it allocates a media
 * session at create time, issues per-participant join tokens at join time, and
 * releases the session at end time. It never touches media bytes.
 *
 * Every transition is validated server-side and is tenant-scoped + authz-aware:
 *  - Only the creator may invite (invites are fixed at create time) and end.
 *  - Only an invitee may join, and only while the call is live.
 *  - You cannot join / accept / leave / signal on an ended call.
 *  - A participant may only change *their own* media state and leave on their
 *    own behalf.
 * Invalid transitions throw {@link CallStateError}; authz failures throw
 * {@link CallAuthzError}. Both carry a stable `reason` code.
 */

export type CallStateErrorReason =
  | "callNotFound"
  | "callEnded"
  | "alreadyEnded"
  | "notInvited"
  | "notParticipant"
  | "noInvitees"
  | "inviteAlreadyResolved"
  | "capacityExceeded";

export class CallStateError extends Error {
  readonly reason: CallStateErrorReason;
  constructor(reason: CallStateErrorReason, message: string) {
    super(message);
    this.name = "CallStateError";
    this.reason = reason;
  }
}

export type CallAuthzErrorReason = "notCreator" | "notInvitee" | "notSelf" | "tenantMismatch";

export class CallAuthzError extends Error {
  readonly reason: CallAuthzErrorReason;
  constructor(reason: CallAuthzErrorReason, message: string) {
    super(message);
    this.name = "CallAuthzError";
    this.reason = reason;
  }
}

/** Who is performing an action — a tenant-scoped user + their device. */
export interface CallActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
}

export type CallKind = "audio" | "video";

export interface CreateCallInput {
  readonly conversationId: string;
  /** Users invited to the call. Must be non-empty and exclude the creator. */
  readonly inviteeUserIds: readonly string[];
  readonly kind?: CallKind;
  /** Region hint forwarded to the media plane (honored if supported). */
  readonly regionHint?: string;
}

export interface CallRoomRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly state: CallRoomState;
  readonly createdBy: string;
  readonly kind: CallKind;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly mediaSessionId?: string;
  readonly transport?: string;
}

export interface CallInviteRecord {
  readonly id: string;
  readonly callId: string;
  readonly inviteeUserId: string;
  readonly status: CallInviteState;
  readonly invitedBy: string;
  readonly invitedAt: string;
  readonly respondedAt?: string;
}

export interface CallParticipantRecord {
  readonly id: string;
  readonly callId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly state: "joined" | "left";
  readonly joinedAt: string;
  readonly leftAt?: string;
  readonly micEnabled: boolean;
  readonly cameraEnabled: boolean;
  readonly screenSharing: boolean;
}

export interface CreateCallResult {
  readonly room: CallRoomRecord;
  readonly invites: readonly CallInviteRecord[];
}

export interface JoinCallResult {
  readonly room: CallRoomRecord;
  readonly participant: CallParticipantRecord;
  /** Per-participant credential to present to the media plane. */
  readonly mediaGrant: MediaJoinGrant;
}

export interface MediaState {
  readonly micEnabled: boolean;
  readonly cameraEnabled: boolean;
  readonly screenSharing: boolean;
}

/**
 * FR-155 — the produce/consume companion an SFU media plane exposes alongside
 * the four-method {@link MediaPlaneAdapter} seam. The control plane forwards a
 * client's media negotiation to these when (and only when) its media plane
 * supports them; a P2P plane has none, so {@link CallControlPlane} Nacks the SFU
 * ops. Structurally matched (not by class) so the adapter stays decoupled and
 * tests can inject any compatible double. Mirrors `SfuMediaPlaneAdapter`.
 */
export interface SfuMediaOperations {
  /**
   * Verify a participant's join nonce (signature + expiry + identity binding).
   * Throws when the token is malformed, forged, or expired. The control plane
   * calls this before forwarding any produce/consume/connect op so the minted
   * credential is actually enforced (calls-token-1 / sfu-media-1).
   */
  verifyJoinToken(callId: string, actor: MediaParticipant, token: string): void;
  /**
   * Release a single participant's media (transports + producers/consumers)
   * without ending the call — called on `leave` so transports don't leak until
   * the whole call ends (sfu-media-3).
   */
  leaveParticipant(callId: string, participant: MediaParticipant): Promise<void>;
  connectTransport(
    callId: string,
    actor: MediaParticipant,
    token: string,
    transportId: string,
    dtlsParameters: DtlsParameters,
  ): Promise<void>;
  produce(
    callId: string,
    actor: MediaParticipant,
    token: string,
    transportId: string,
    kind: MediaKind,
    rtpParameters: RtpParameters,
  ): Promise<ProducerHandle>;
  consume(
    callId: string,
    actor: MediaParticipant,
    token: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities,
  ): Promise<ConsumerHandle>;
}

/**
 * Structural guard: does this media plane expose the SFU produce/consume
 * companion? True for `SfuMediaPlaneAdapter`, false for the P2P / fake planes.
 */
export function supportsSfuMedia(
  plane: MediaPlaneAdapter,
): plane is MediaPlaneAdapter & SfuMediaOperations {
  const candidate = plane as Partial<SfuMediaOperations>;
  return (
    typeof candidate.connectTransport === "function" &&
    typeof candidate.produce === "function" &&
    typeof candidate.consume === "function" &&
    typeof candidate.verifyJoinToken === "function" &&
    typeof candidate.leaveParticipant === "function"
  );
}

/** Raised when an SFU-only media op is attempted on a non-SFU media plane. */
export class CallMediaUnsupportedError extends Error {
  readonly reason = "sfuUnsupported" as const;
  constructor(message: string) {
    super(message);
    this.name = "CallMediaUnsupportedError";
  }
}

export interface CallControlPlaneOptions {
  readonly store: FrickStore;
  readonly mediaPlane: MediaPlaneAdapter;
  /** Override the schema type names. Defaults to {@link DEFAULT_CALL_TYPE_NAMES}. */
  readonly typeNames?: CallTypeNames;
  /** Injectable id generator (deterministic ids in tests). */
  readonly generateId?: () => string;
  /** Injectable clock for deterministic timestamps. */
  readonly now?: () => Date;
}

const DEFAULT_MEDIA_STATE: MediaState = {
  micEnabled: true,
  cameraEnabled: false,
  screenSharing: false,
};

export class CallControlPlane {
  readonly #store: FrickStore;
  readonly #media: MediaPlaneAdapter;
  readonly #names: CallTypeNames;
  readonly #genId: () => string;
  readonly #now: () => Date;
  /** Monotonic counter making per-call stream request-ids unique + ordered. */
  #seq = 0;

  constructor(options: CallControlPlaneOptions) {
    this.#store = options.store;
    this.#media = options.mediaPlane;
    this.#names = options.typeNames ?? DEFAULT_CALL_TYPE_NAMES;
    this.#genId = options.generateId ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  // -- create --------------------------------------------------------------

  /**
   * Create a call: persist the `CallRoom` (state `ringing`), one `CallInvite`
   * per invitee, allocate a media session, and emit `CallCreated` +
   * `CallInviteSent` events. Only the creator's invitees may later join.
   */
  async createCall(actor: CallActor, input: CreateCallInput): Promise<CreateCallResult> {
    const invitees = dedupe(input.inviteeUserIds).filter((u) => u !== actor.userId);
    if (invitees.length === 0) {
      throw new CallStateError(
        "noInvitees",
        "A call must invite at least one user other than the creator",
      );
    }

    // Enforce the media plane's participant cap up front (sfu-media-4): a P2P
    // plane advertises maxParticipants:2, so creator + invitees must fit.
    const maxParticipants = this.#media.describe().maxParticipants;
    if (maxParticipants !== undefined && invitees.length + 1 > maxParticipants) {
      throw new CallStateError(
        "capacityExceeded",
        `Call exceeds the media plane capacity of ${maxParticipants} participants`,
      );
    }

    const callId = this.#genId();
    const createdAt = this.#now().toISOString();
    const kind: CallKind = input.kind ?? "video";

    // Allocate the media room up front so the room id is durable on the
    // CallRoom and a joining client can be issued a token immediately.
    const session = await this.#media.allocateSession(callId, {
      ...(input.regionHint !== undefined ? { regionHint: input.regionHint } : {}),
      expectedParticipants: invitees.length + 1,
    });

    const room: CallRoomRecord = {
      id: callId,
      conversationId: input.conversationId,
      state: "ringing",
      createdBy: actor.userId,
      kind,
      createdAt,
      mediaSessionId: session.mediaSessionId,
      transport: session.transport,
    };
    await this.#writeRoom(actor.tenantId, room);

    await this.#appendEvent(actor.tenantId, callId, this.#names.events.created, {
      callId,
      conversationId: input.conversationId,
      createdBy: actor.userId,
      kind,
      createdAt,
    });

    const invites: CallInviteRecord[] = [];
    for (const inviteeUserId of invitees) {
      const invite: CallInviteRecord = {
        id: `${callId}:${inviteeUserId}`,
        callId,
        inviteeUserId,
        status: "ringing",
        invitedBy: actor.userId,
        invitedAt: createdAt,
      };
      await this.#writeInvite(actor.tenantId, invite);
      await this.#appendEvent(actor.tenantId, callId, this.#names.events.inviteSent, {
        callId,
        inviteeUserId,
        invitedBy: actor.userId,
      });
      invites.push(invite);
    }

    return { room, invites };
  }

  // -- accept / join -------------------------------------------------------

  /**
   * Mark an invitee's `CallInvite` as accepted and emit `CallInviteAccepted`.
   * Idempotent-ish: re-accepting an already-accepted invite is allowed (the
   * client may have lost the ack); accepting a declined/cancelled invite or one
   * for an ended call is rejected.
   */
  async acceptInvite(actor: CallActor, callId: string): Promise<CallInviteRecord> {
    const room = await this.#requireLiveRoom(actor.tenantId, callId);
    const invite = await this.#requireInviteeOrCreator(room, actor.tenantId, actor.userId);
    // The creator has no invite to accept — they are an implicit member of their
    // own call. Return a synthetic, already-accepted self-invite (no writes).
    if (!invite) {
      return this.#creatorSelfInvite(callId, actor.userId);
    }
    if (invite.status === "declined" || invite.status === "cancelled") {
      throw new CallStateError(
        "inviteAlreadyResolved",
        `Invite for ${actor.userId} is ${invite.status} and cannot be accepted`,
      );
    }
    if (invite.status === "accepted") {
      return invite;
    }
    const respondedAt = this.#now().toISOString();
    const updated: CallInviteRecord = { ...invite, status: "accepted", respondedAt };
    await this.#writeInvite(actor.tenantId, updated);
    await this.#appendEvent(actor.tenantId, callId, this.#names.events.inviteAccepted, {
      callId,
      inviteeUserId: actor.userId,
    });
    return updated;
  }

  /**
   * Join a call: only an invitee may join, and only while the call is live.
   * Persists/updates the `CallParticipant` (state `joined`), transitions the
   * room from `ringing` to `active` on the first join, emits
   * `CallParticipantJoined`, and issues a per-participant media join token.
   * Joining also implicitly accepts a still-`ringing` invite.
   */
  async joinCall(actor: CallActor, callId: string): Promise<JoinCallResult> {
    const room = await this.#requireLiveRoom(actor.tenantId, callId);
    const invite = await this.#requireInviteeOrCreator(room, actor.tenantId, actor.userId);
    if (invite && (invite.status === "declined" || invite.status === "cancelled")) {
      throw new CallStateError(
        "inviteAlreadyResolved",
        `Invite for ${actor.userId} is ${invite.status}; cannot join`,
      );
    }

    const joinedAt = this.#now().toISOString();
    // Enforce the media plane's participant cap before allocating a grant
    // (sfu-media-4): a P2P plane advertises maxParticipants:2.
    await this.#assertParticipantCapacity(actor.tenantId, callId, actor.userId, actor.deviceId);
    // The creator has no invite row to flip; only an invitee's invite is
    // implicitly accepted on first join.
    if (invite && invite.status !== "accepted") {
      await this.#writeInvite(actor.tenantId, {
        ...invite,
        status: "accepted",
        respondedAt: joinedAt,
      });
      await this.#appendEvent(actor.tenantId, callId, this.#names.events.inviteAccepted, {
        callId,
        inviteeUserId: actor.userId,
      });
    }

    const participant: CallParticipantRecord = {
      id: `${callId}:${actor.userId}:${actor.deviceId}`,
      callId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      state: "joined",
      joinedAt,
      micEnabled: DEFAULT_MEDIA_STATE.micEnabled,
      cameraEnabled: DEFAULT_MEDIA_STATE.cameraEnabled,
      screenSharing: DEFAULT_MEDIA_STATE.screenSharing,
    };
    await this.#writeParticipant(actor.tenantId, participant);

    // First join activates the room.
    let activeRoom = room;
    if (room.state === "ringing") {
      activeRoom = { ...room, state: "active", startedAt: joinedAt };
      await this.#writeRoom(actor.tenantId, activeRoom);
    }

    await this.#appendEvent(actor.tenantId, callId, this.#names.events.participantJoined, {
      callId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      joinedAt,
    });

    const mediaGrant = await this.#media.issueJoinToken(callId, {
      userId: actor.userId,
      deviceId: actor.deviceId,
    });

    return { room: activeRoom, participant, mediaGrant };
  }

  // -- media state ---------------------------------------------------------

  /**
   * Update a participant's media state (mute / camera / screen-share). A
   * participant may only change *their own* state. Emits
   * `CallParticipantMediaChanged`.
   */
  async setMediaState(
    actor: CallActor,
    callId: string,
    next: Partial<MediaState>,
  ): Promise<CallParticipantRecord> {
    await this.#requireLiveRoom(actor.tenantId, callId);
    const participant = await this.#readParticipant(
      actor.tenantId,
      callId,
      actor.userId,
      actor.deviceId,
    );
    if (!participant || participant.state !== "joined") {
      throw new CallStateError(
        "notParticipant",
        `${actor.userId}/${actor.deviceId} is not an active participant of ${callId}`,
      );
    }
    const updated: CallParticipantRecord = {
      ...participant,
      micEnabled: next.micEnabled ?? participant.micEnabled,
      cameraEnabled: next.cameraEnabled ?? participant.cameraEnabled,
      screenSharing: next.screenSharing ?? participant.screenSharing,
    };
    await this.#writeParticipant(actor.tenantId, updated);
    await this.#appendEvent(actor.tenantId, callId, this.#names.events.participantMediaChanged, {
      callId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      micEnabled: updated.micEnabled,
      cameraEnabled: updated.cameraEnabled,
      screenSharing: updated.screenSharing,
    });
    return updated;
  }

  // -- SFU media negotiation (FR-155) --------------------------------------
  //
  // After a participant `join`s an SFU-brokered call and receives its grant
  // (router caps + transport params), the browser driver negotiates real media
  // by forwarding these through the gateway. Each validates the actor is an
  // active participant of a live call, then delegates to the media plane's
  // produce/consume companion. A non-SFU media plane has no such companion, so
  // these throw {@link CallMediaUnsupportedError} (→ Nack).

  /** Complete the DTLS handshake for one of the participant's transports. */
  async sfuConnectTransport(
    actor: CallActor,
    callId: string,
    token: string,
    transportId: string,
    dtlsParameters: DtlsParameters,
  ): Promise<void> {
    const ops = await this.#requireSfuParticipant(actor, callId);
    await ops.connectTransport(callId, mediaActor(actor), token, transportId, dtlsParameters);
  }

  /** Start producing one of the participant's tracks on its send transport. */
  async sfuProduce(
    actor: CallActor,
    callId: string,
    token: string,
    transportId: string,
    kind: MediaKind,
    rtpParameters: RtpParameters,
  ): Promise<ProducerHandle> {
    const ops = await this.#requireSfuParticipant(actor, callId);
    return ops.produce(callId, mediaActor(actor), token, transportId, kind, rtpParameters);
  }

  /** Consume another participant's producer onto this participant's recv transport. */
  async sfuConsume(
    actor: CallActor,
    callId: string,
    token: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities,
  ): Promise<ConsumerHandle> {
    const ops = await this.#requireSfuParticipant(actor, callId);
    return ops.consume(callId, mediaActor(actor), token, transportId, producerId, rtpCapabilities);
  }

  /**
   * Validate the actor is an active participant of a live, SFU-brokered call and
   * return the media plane's produce/consume companion. Throws
   * {@link CallStateError}/{@link CallMediaUnsupportedError} otherwise.
   */
  async #requireSfuParticipant(
    actor: CallActor,
    callId: string,
  ): Promise<SfuMediaOperations> {
    if (!supportsSfuMedia(this.#media)) {
      throw new CallMediaUnsupportedError(
        `Call ${callId} is not brokered over an SFU media plane; SFU media negotiation is unsupported`,
      );
    }
    await this.#requireLiveRoom(actor.tenantId, callId);
    const participant = await this.#readParticipant(
      actor.tenantId,
      callId,
      actor.userId,
      actor.deviceId,
    );
    if (!participant || participant.state !== "joined") {
      throw new CallStateError(
        "notParticipant",
        `${actor.userId}/${actor.deviceId} is not an active participant of ${callId}`,
      );
    }
    return this.#media;
  }

  // -- leave ---------------------------------------------------------------

  /**
   * Leave a call. Marks the actor's `CallParticipant` as `left` and emits
   * `CallParticipantLeft`. When the last participant leaves an `active` call,
   * the call is ended automatically. A non-participant leaving is a no-op-safe
   * rejection (`notParticipant`).
   */
  async leaveCall(actor: CallActor, callId: string): Promise<CallRoomRecord> {
    const room = await this.#readRoom(actor.tenantId, callId);
    if (!room) {
      throw new CallStateError("callNotFound", `Call ${callId} does not exist`);
    }
    if (room.state === "ended") {
      // Leaving an already-ended call is idempotent.
      return room;
    }
    const participant = await this.#readParticipant(
      actor.tenantId,
      callId,
      actor.userId,
      actor.deviceId,
    );
    if (!participant || participant.state !== "joined") {
      throw new CallStateError(
        "notParticipant",
        `${actor.userId}/${actor.deviceId} is not an active participant of ${callId}`,
      );
    }
    const leftAt = this.#now().toISOString();
    await this.#writeParticipant(actor.tenantId, { ...participant, state: "left", leftAt });
    await this.#appendEvent(actor.tenantId, callId, this.#names.events.participantLeft, {
      callId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      leftAt,
    });

    // Reclaim the leaving participant's SFU transports/producers/consumers
    // immediately so repeated join/leave can't leak server-side media state
    // (sfu-media-3). No-op on a P2P/fake plane (no leaveParticipant companion).
    if (supportsSfuMedia(this.#media)) {
      await this.#media.leaveParticipant(callId, mediaActor(actor));
    }

    // Auto-end when the last active participant leaves.
    const remaining = await this.#activeParticipantCount(actor.tenantId, callId);
    if (remaining === 0 && room.state === "active") {
      return this.#finalizeEnd(actor.tenantId, callId, actor.userId);
    }
    return room;
  }

  // -- end -----------------------------------------------------------------

  /**
   * End a call. Only the creator may end it explicitly. Marks the `CallRoom`
   * `ended`, releases the media session, and emits `CallEnded`. Idempotent on
   * an already-ended call.
   */
  async endCall(actor: CallActor, callId: string): Promise<CallRoomRecord> {
    const room = await this.#readRoom(actor.tenantId, callId);
    if (!room) {
      throw new CallStateError("callNotFound", `Call ${callId} does not exist`);
    }
    if (room.createdBy !== actor.userId) {
      throw new CallAuthzError("notCreator", "Only the call creator may end the call");
    }
    if (room.state === "ended") {
      return room;
    }
    return this.#finalizeEnd(actor.tenantId, callId, actor.userId);
  }

  // -- reads (for clients / reconnect) ------------------------------------

  async getRoom(tenantId: string, callId: string): Promise<CallRoomRecord | undefined> {
    return this.#readRoom(tenantId, callId);
  }

  async listInvites(tenantId: string, callId: string): Promise<CallInviteRecord[]> {
    const rows = await this.#store.listObjects(tenantId, this.#names.callInvite);
    return rows
      .filter((r) => r["callId"] === callId)
      .map((r) => r as unknown as CallInviteRecord);
  }

  async listParticipants(tenantId: string, callId: string): Promise<CallParticipantRecord[]> {
    const rows = await this.#store.listObjects(tenantId, this.#names.callParticipant);
    return rows
      .filter((r) => r["callId"] === callId)
      .map((r) => r as unknown as CallParticipantRecord);
  }

  // -- internals -----------------------------------------------------------

  async #finalizeEnd(
    tenantId: string,
    callId: string,
    endedBy: string,
  ): Promise<CallRoomRecord> {
    const endedAt = this.#now().toISOString();
    const room = await this.#readRoom(tenantId, callId);
    // Guard against a delete/end race that removed the room between the caller's
    // read and this re-read: spreading `undefined` would persist a corrupt
    // CallRoom record (no id/createdBy/conversationId). Fail closed instead
    // (calls-stability-1). An already-ended room is returned idempotently.
    if (!room) {
      throw new CallStateError("callNotFound", `Call ${callId} does not exist`);
    }
    if (room.state === "ended") {
      return room;
    }
    const ended: CallRoomRecord = { ...room, state: "ended", endedAt };
    await this.#writeRoom(tenantId, ended);
    await this.#appendEvent(tenantId, callId, this.#names.events.ended, {
      callId,
      endedBy,
      endedAt,
    });
    await this.#media.releaseSession(callId);
    return ended;
  }

  async #requireLiveRoom(tenantId: string, callId: string): Promise<CallRoomRecord> {
    const room = await this.#readRoom(tenantId, callId);
    if (!room) {
      throw new CallStateError("callNotFound", `Call ${callId} does not exist`);
    }
    if (room.state === "ended") {
      throw new CallStateError("callEnded", `Call ${callId} has already ended`);
    }
    return room;
  }

  /**
   * Resolve the actor's invite, or `undefined` when the actor is the room
   * creator (who has no invite row but is an implicit, always-accepted member of
   * their own call — calls-correctness-1). Throws `notInvitee` for anyone who is
   * neither an invitee nor the creator.
   */
  async #requireInviteeOrCreator(
    room: CallRoomRecord,
    tenantId: string,
    userId: string,
  ): Promise<CallInviteRecord | undefined> {
    if (room.createdBy === userId) {
      return undefined;
    }
    const invite = await this.#readInvite(tenantId, room.id, userId);
    if (!invite) {
      throw new CallAuthzError(
        "notInvitee",
        `${userId} was not invited to call ${room.id}`,
      );
    }
    return invite;
  }

  async #activeParticipantCount(tenantId: string, callId: string): Promise<number> {
    const participants = await this.listParticipants(tenantId, callId);
    return participants.filter((p) => p.state === "joined").length;
  }

  /**
   * Reject a join that would push the call past the media plane's participant
   * cap (sfu-media-4). Counts *distinct active users* and treats an already-
   * joined (userId,deviceId) as a free rejoin so a reconnect never trips the cap.
   */
  async #assertParticipantCapacity(
    tenantId: string,
    callId: string,
    userId: string,
    deviceId: string,
  ): Promise<void> {
    const maxParticipants = this.#media.describe().maxParticipants;
    if (maxParticipants === undefined) {
      return;
    }
    const participants = await this.listParticipants(tenantId, callId);
    const activeUsers = new Set(
      participants.filter((p) => p.state === "joined").map((p) => p.userId),
    );
    // A rejoin by an already-joined participant (same user+device) does not add
    // a new seat.
    const isRejoin = participants.some(
      (p) => p.state === "joined" && p.userId === userId && p.deviceId === deviceId,
    );
    if (isRejoin || activeUsers.has(userId)) {
      return;
    }
    if (activeUsers.size + 1 > maxParticipants) {
      throw new CallStateError(
        "capacityExceeded",
        `Call ${callId} is full (media plane capacity is ${maxParticipants})`,
      );
    }
  }

  /** Synthetic, always-accepted self-invite returned for the room creator. */
  #creatorSelfInvite(callId: string, userId: string): CallInviteRecord {
    const at = this.#now().toISOString();
    return {
      id: `${callId}:${userId}`,
      callId,
      inviteeUserId: userId,
      status: "accepted",
      invitedBy: userId,
      invitedAt: at,
      respondedAt: at,
    };
  }

  async #readRoom(tenantId: string, callId: string): Promise<CallRoomRecord | undefined> {
    const row = await this.#store.readObject(tenantId, this.#names.callRoom, callId);
    return row as unknown as CallRoomRecord | undefined;
  }

  async #readInvite(
    tenantId: string,
    callId: string,
    userId: string,
  ): Promise<CallInviteRecord | undefined> {
    const row = await this.#store.readObject(
      tenantId,
      this.#names.callInvite,
      `${callId}:${userId}`,
    );
    return row as unknown as CallInviteRecord | undefined;
  }

  async #readParticipant(
    tenantId: string,
    callId: string,
    userId: string,
    deviceId: string,
  ): Promise<CallParticipantRecord | undefined> {
    const row = await this.#store.readObject(
      tenantId,
      this.#names.callParticipant,
      `${callId}:${userId}:${deviceId}`,
    );
    return row as unknown as CallParticipantRecord | undefined;
  }

  async #writeRoom(tenantId: string, room: CallRoomRecord): Promise<void> {
    await this.#store.upsertObject(tenantId, this.#names.callRoom, room.id, toPlain(room));
  }

  async #writeInvite(tenantId: string, invite: CallInviteRecord): Promise<void> {
    await this.#store.upsertObject(tenantId, this.#names.callInvite, invite.id, toPlain(invite));
  }

  async #writeParticipant(tenantId: string, participant: CallParticipantRecord): Promise<void> {
    await this.#store.upsertObject(
      tenantId,
      this.#names.callParticipant,
      participant.id,
      toPlain(participant),
    );
  }

  async #appendEvent(
    tenantId: string,
    callId: string,
    event: string,
    payload: PlainObject,
  ): Promise<void> {
    this.#seq += 1;
    await this.#store.appendEvent({
      tenantId,
      requestId: `call-${callId}-${event}-${this.#seq}`,
      replicaId: "call-control-plane",
      stream: this.#names.callEventStream,
      streamId: callId,
      event,
      payload,
    });
  }
}

/** Strip `undefined` optional fields so the codec never packs an absent value. */
function toPlain(record: object): PlainObject {
  const out: PlainObject = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Project a {@link CallActor} onto the media plane's {@link MediaParticipant}. */
function mediaActor(actor: CallActor): MediaParticipant {
  return { userId: actor.userId, deviceId: actor.deviceId };
}

/** Convenience: build a {@link CallActor} for the default tenant. */
export function callActor(
  userId: string,
  deviceId: string,
  tenantId: string = DEFAULT_TENANT_ID,
): CallActor {
  return { tenantId, userId, deviceId };
}
