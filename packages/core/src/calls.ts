/**
 * FR-80 / FR-82 — TypeScript call client surface.
 *
 * Thin, ergonomic helpers over {@link FrickClient.callCommand} plus an
 * observable {@link CallState} that composes the synced call records
 * (CallRoom + CallParticipant objects) into a single reactive view a UI can
 * render. The control plane is server-authoritative: these helpers only issue
 * commands and read back the synced records — they never mutate call state
 * locally.
 *
 * Media (SDP/ICE) is out of scope here — it rides the `WebRTCSignal` relay via
 * {@link FrickClient.sendSignal}/`signalChannel`. The {@link CallMediaGrant}
 * returned by {@link joinCall} is what the caller hands to its media layer
 * (WebRTC/SFU SDK) to actually connect.
 */

import type {
  CallInviteRecord,
  CallKind,
  CallMediaGrant,
  CallMediaStatePatch,
  CallNetworkQuality,
  CallParticipantRecord,
  CallRoomRecord,
  PlainObject,
} from "@fricken/protocol";
import type { FrickClient } from "./runtime.js";
import { Signal, type Unsubscribe } from "./subscriptions.js";

/** Object/stream type names the call client reads (mirrors the server schema). */
export const CALL_ROOM_TYPE = "CallRoom";
export const CALL_INVITE_TYPE = "CallInvite";
export const CALL_PARTICIPANT_TYPE = "CallParticipant";

export interface CreateCallOptions {
  readonly conversationId: string;
  readonly inviteeUserIds: readonly string[];
  readonly kind?: CallKind;
  readonly regionHint?: string;
}

export interface CreateCallResult {
  readonly room: CallRoomRecord;
  readonly invites: readonly CallInviteRecord[];
}

export interface JoinCallResult {
  readonly room: CallRoomRecord;
  readonly participant: CallParticipantRecord;
  readonly mediaGrant: CallMediaGrant;
}

/**
 * Create a call in `conversationId`, inviting `inviteeUserIds` (must exclude
 * the caller). Resolves with the freshly-created room (state `ringing`) and the
 * per-invitee invites. The records also arrive over sync, so an open
 * {@link callState} updates on its own.
 */
export async function createCall(
  client: FrickClient,
  options: CreateCallOptions,
): Promise<CreateCallResult> {
  const result = await client.callCommand({
    op: "create",
    conversationId: options.conversationId,
    inviteeUserIds: options.inviteeUserIds,
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    ...(options.regionHint !== undefined ? { regionHint: options.regionHint } : {}),
  });
  return { room: result.room!, invites: result.invites ?? [] };
}

/**
 * Join a call you were invited to. Resolves with the (now `active`) room, your
 * participant record, and the {@link CallMediaGrant} to present to the media
 * layer. Joining implicitly accepts a still-ringing invite.
 */
export async function joinCall(client: FrickClient, callId: string): Promise<JoinCallResult> {
  const result = await client.callCommand({ op: "join", callId });
  return { room: result.room!, participant: result.participant!, mediaGrant: result.mediaGrant! };
}

/** Accept a ringing invite without joining yet. */
export async function acceptCall(client: FrickClient, callId: string): Promise<CallInviteRecord> {
  const result = await client.callCommand({ op: "accept", callId });
  return result.invite!;
}

/** Leave a call. The last active participant leaving auto-ends the call. */
export async function leaveCall(client: FrickClient, callId: string): Promise<CallRoomRecord> {
  const result = await client.callCommand({ op: "leave", callId });
  return result.room!;
}

/** End a call. Only the creator may end it explicitly. */
export async function endCall(client: FrickClient, callId: string): Promise<CallRoomRecord> {
  const result = await client.callCommand({ op: "end", callId });
  return result.room!;
}

/**
 * Update your own media state (mic / camera / screen-share) — the FR-82
 * call-presence surface. Resolves with the updated participant record.
 */
export async function setCallMediaState(
  client: FrickClient,
  callId: string,
  media: CallMediaStatePatch,
): Promise<CallParticipantRecord> {
  const result = await client.callCommand({ op: "setMediaState", callId, media });
  return result.participant!;
}

/**
 * FR-82 — the per-participant presence surface a call UI renders: identity plus
 * mic/camera/screen-share, the live `speaking` flag, and a coarse
 * `networkQuality` bucket. `mic`/`camera`/`screenSharing` come straight off the
 * server-authoritative participant record; `speaking`/`networkQuality` are
 * carried on the same record when a media adapter reports them (defaulting to
 * `false`/`"unknown"`).
 */
export interface CallParticipantPresence {
  readonly userId: string;
  readonly deviceId: string;
  readonly state: CallParticipantRecord["state"];
  readonly micEnabled: boolean;
  readonly cameraEnabled: boolean;
  readonly screenSharing: boolean;
  readonly speaking: boolean;
  readonly networkQuality: CallNetworkQuality;
}

/**
 * The reactive view of a single call: the room record, every participant's
 * presence, and the convenience `isActive`/`isEnded` flags. `undefined` `room`
 * means the call isn't known to this client (not yet synced, or wrong id).
 */
export interface CallState {
  readonly callId: string;
  readonly room: CallRoomRecord | undefined;
  readonly participants: readonly CallParticipantPresence[];
  readonly isActive: boolean;
  readonly isEnded: boolean;
}

function toPresence(record: CallParticipantRecord): CallParticipantPresence {
  return {
    userId: record.userId,
    deviceId: record.deviceId,
    state: record.state,
    micEnabled: record.micEnabled,
    cameraEnabled: record.cameraEnabled,
    screenSharing: record.screenSharing,
    speaking: record.speaking ?? false,
    networkQuality: record.networkQuality ?? "unknown",
  };
}

function composeCallState(
  callId: string,
  room: PlainObject | undefined,
  participants: readonly PlainObject[],
): CallState {
  const roomRecord = room as CallRoomRecord | undefined;
  const forCall = participants
    .filter((p) => p["callId"] === callId)
    .map((p) => toPresence(p as unknown as CallParticipantRecord))
    // Stable order so UIs don't reshuffle tiles on every delta.
    .sort((a, b) =>
      a.userId === b.userId ? a.deviceId.localeCompare(b.deviceId) : a.userId.localeCompare(b.userId),
    );
  return {
    callId,
    room: roomRecord,
    participants: forCall,
    isActive: roomRecord?.state === "active",
    isEnded: roomRecord?.state === "ended",
  };
}

/**
 * Build a {@link Signal} of {@link CallState} for `callId`, composed from the
 * synced `CallRoom` + `CallParticipant` object lists. Subscribing also
 * subscribes the underlying object types, so the state stays live as the
 * server fans out deltas (joins, mutes, leaves, end). The returned `dispose`
 * detaches the internal listeners.
 *
 * Most React consumers use `useCallState` from `@fricken/react` instead of
 * wiring this Signal by hand.
 */
export function callState(
  client: FrickClient,
  callId: string,
): { signal: Signal<CallState>; dispose: Unsubscribe } {
  // Subscribe to the room + participant object types so the state stays live;
  // resolve the room by its object key (the room record carries no `id` field).
  const rooms = client.objects(CALL_ROOM_TYPE);
  const participants = client.objects(CALL_PARTICIPANT_TYPE);
  const compute = () =>
    composeCallState(callId, client.object(CALL_ROOM_TYPE, callId), participants.value);
  const signal = new Signal<CallState>(compute());
  const recompute = () => signal.set(compute());
  const unsubRooms = rooms.subscribe(recompute);
  const unsubParticipants = participants.subscribe(recompute);
  return {
    signal,
    dispose: () => {
      unsubRooms();
      unsubParticipants();
    },
  };
}
