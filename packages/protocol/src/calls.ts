/**
 * FR-15 — Call control-plane wire contract.
 *
 * The call *records* (CallRoom / CallInvite / CallParticipant) sync to clients
 * as ordinary object records, the call event log rides the `CallEventStream`,
 * and WebRTC SDP/ICE signaling rides the existing `SignalSend`/`SignalDeliver`
 * frames with the `WebRTCSignal` type — none of that needs a new frame.
 *
 * What *does* need a new frame is the set of server-authoritative lifecycle
 * *commands*: create / join / leave / accept / set-media-state / end. These are
 * not plain object upserts — the server validates every transition, allocates
 * media sessions, mints per-participant join grants, and emits durable events.
 * So this module adds a request/response RPC frame pair that mirrors the
 * Append/ObjectUpsert request shape (a client-supplied `requestId` for
 * correlation) but returns a typed result the plain `Ack` frame can't carry
 * (the room snapshot + the participant + the media join grant).
 *
 * These shapes are the canonical wire contract the TS, Swift, and Android
 * clients all mirror. They intentionally line up with the server's
 * `CallControlPlane` record/result types (`apps/server/src/calls`).
 */

import type { PlainObject } from "./schema.js";

/** Media topology a call's media session is brokered over (FR-78). */
export type CallTransport = "p2p" | "sfu";

/** Audio-only vs audio+video call (FR-79). */
export type CallKind = "audio" | "video";

/** Lifecycle states a `CallRoom` moves through. */
export type CallRoomState = "ringing" | "active" | "ended";

/** Lifecycle states a `CallInvite` moves through. */
export type CallInviteState = "ringing" | "accepted" | "declined" | "cancelled";

/** Lifecycle states a `CallParticipant` moves through. */
export type CallParticipantState = "joined" | "left";

/**
 * Kinds of WebRTC signal that ride the `WebRTCSignal` relay (opaque payload).
 *
 * `"keyEpoch"` (FR-156) carries an E2EE key-epoch announcement for per-room
 * call encryption: when membership changes, the rotation initiator wraps the
 * fresh epoch key and announces it over this same relay (the control plane
 * forwards the opaque `payload` byte-for-byte, exactly as it does `"sfuToken"`).
 * It is additive — a peer that doesn't understand it simply ignores it.
 */
export type WebRTCSignalKind =
  | "offer"
  | "answer"
  | "ice"
  | "renegotiate"
  | "sfuToken"
  | "keyEpoch";

/**
 * Server-authoritative call room record. Mirrors the server's
 * `CallRoomRecord`. Synced to clients as a `CallRoom` object; also returned
 * inline by create/join/leave/end commands so the caller gets the post-command
 * snapshot without waiting for the object delta.
 */
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

/** Server-authoritative invite record. Mirrors the server's `CallInviteRecord`. */
export interface CallInviteRecord {
  readonly id: string;
  readonly callId: string;
  readonly inviteeUserId: string;
  readonly status: CallInviteState;
  readonly invitedBy: string;
  readonly invitedAt: string;
  readonly respondedAt?: string;
}

/**
 * Server-authoritative participant record. Mirrors the server's
 * `CallParticipantRecord`. Carries the per-participant call-presence surface
 * (FR-82): mic / camera / screen-share. `speaking` and `networkQuality` are
 * optional, client-derived presence fields that ride the same record on the
 * wire when a media adapter reports them.
 */
export interface CallParticipantRecord {
  readonly id: string;
  readonly callId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly state: CallParticipantState;
  readonly joinedAt: string;
  readonly leftAt?: string;
  readonly micEnabled: boolean;
  readonly cameraEnabled: boolean;
  readonly screenSharing: boolean;
  /** FR-82: whether the participant is currently detected as speaking. */
  readonly speaking?: boolean;
  /** FR-82: coarse network-quality bucket for this participant's media link. */
  readonly networkQuality?: CallNetworkQuality;
}

/** Coarse network-quality bucket surfaced on the participant model (FR-82). */
export type CallNetworkQuality = "unknown" | "poor" | "fair" | "good" | "excellent";

/**
 * A short-lived, participant-scoped credential the client presents to the
 * media plane to join the actual media session. Mirrors the server's
 * `MediaJoinGrant` (FR-78). `connection` is opaque adapter metadata (ICE/TURN
 * for p2p, signaling URL for SFU).
 */
export interface CallMediaGrant {
  readonly callId: string;
  readonly mediaSessionId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly connection?: Readonly<Record<string, string>>;
}

/** Partial media-state mutation for the `setMediaState` command (FR-82). */
export interface CallMediaStatePatch {
  readonly micEnabled?: boolean;
  readonly cameraEnabled?: boolean;
  readonly screenSharing?: boolean;
}

// -- command request bodies -------------------------------------------------

export interface CreateCallCommand {
  readonly op: "create";
  readonly conversationId: string;
  /** Users to invite. Must be non-empty and must exclude the caller. */
  readonly inviteeUserIds: readonly string[];
  readonly kind?: CallKind;
  /** Region hint forwarded to the media plane (honored if supported). */
  readonly regionHint?: string;
}

export interface JoinCallCommand {
  readonly op: "join";
  readonly callId: string;
}

export interface AcceptCallCommand {
  readonly op: "accept";
  readonly callId: string;
}

export interface LeaveCallCommand {
  readonly op: "leave";
  readonly callId: string;
}

export interface EndCallCommand {
  readonly op: "end";
  readonly callId: string;
}

export interface SetCallMediaStateCommand {
  readonly op: "setMediaState";
  readonly callId: string;
  readonly media: CallMediaStatePatch;
}

// -- SFU media-negotiation commands (FR-155) --------------------------------
//
// The SFU media plane (FR-83) forwards real-time media through a server-side
// mediasoup router. After a client `join`s and receives its grant (router RTP
// capabilities + send/recv transport params), it negotiates media by driving
// these server-authoritative ops over the SAME `CallCommand` frame: it loads a
// mediasoup-client `Device`, builds its transports, and then completes the DTLS
// handshake (`connectTransport`), starts producing its own tracks (`produce`),
// and consumes other participants' producers (`consume`). These are no-ops on a
// P2P media plane — a P2P server Nacks them. All structured params
// (dtlsParameters, rtpParameters, rtpCapabilities) are carried as opaque
// JSON-serializable objects, mirroring the server's `SfuBackend` shapes.

/** Opaque, JSON-serializable DTLS parameters from a mediasoup-client transport. */
export type CallSfuDtlsParameters = Record<string, unknown>;

/** Opaque, JSON-serializable RTP parameters for a produced/consumed track. */
export type CallSfuRtpParameters = Record<string, unknown>;

/** Opaque, JSON-serializable RTP capabilities of the consuming client's Device. */
export type CallSfuRtpCapabilities = Record<string, unknown>;

/** Media kind a producer/consumer carries (mirrors the server's `MediaKind`). */
export type CallSfuMediaKind = "audio" | "video";

/**
 * Complete the DTLS handshake for one of this participant's transports. Sent by
 * the client when a mediasoup-client transport fires its `connect` event.
 */
export interface ConnectSfuTransportCommand {
  readonly op: "sfuConnectTransport";
  readonly callId: string;
  /**
   * The join nonce the client received in its {@link CallMediaGrant} (FR-78).
   * The server re-derives and verifies it (signature + expiry + identity
   * binding) before forwarding the op to the SFU. Additive: older servers
   * ignore it, newer servers require it for SFU media ops.
   */
  readonly token: string;
  readonly transportId: string;
  readonly dtlsParameters: CallSfuDtlsParameters;
}

/**
 * Start producing one of this participant's tracks on its send transport. Sent
 * when a mediasoup-client send transport fires its `produce` event. The result
 * carries the server-assigned `producerId` the client returns to the transport.
 */
export interface ProduceSfuCommand {
  readonly op: "sfuProduce";
  readonly callId: string;
  /** Join nonce re-verified server-side before producing (see {@link ConnectSfuTransportCommand.token}). */
  readonly token: string;
  readonly transportId: string;
  readonly kind: CallSfuMediaKind;
  readonly rtpParameters: CallSfuRtpParameters;
}

/**
 * Consume another participant's producer onto this participant's recv transport.
 * The result carries the consumer params the client feeds to
 * `recvTransport.consume(...)`.
 */
export interface ConsumeSfuCommand {
  readonly op: "sfuConsume";
  readonly callId: string;
  /** Join nonce re-verified server-side before consuming (see {@link ConnectSfuTransportCommand.token}). */
  readonly token: string;
  readonly transportId: string;
  readonly producerId: string;
  readonly rtpCapabilities: CallSfuRtpCapabilities;
}

/** Discriminated union of every call control-plane command. */
export type CallCommandOp =
  | CreateCallCommand
  | JoinCallCommand
  | AcceptCallCommand
  | LeaveCallCommand
  | EndCallCommand
  | SetCallMediaStateCommand
  | ConnectSfuTransportCommand
  | ProduceSfuCommand
  | ConsumeSfuCommand;

/** Names of the supported command operations. */
export type CallCommandName = CallCommandOp["op"];

/**
 * A call command frame body. Carries a client-supplied `requestId` for
 * correlation with the matching {@link CallCommandResultPayload}, exactly like
 * Append/ObjectUpsert correlate with Ack/Nack.
 */
export interface CallCommandPayload {
  readonly requestId: string;
  readonly command: CallCommandOp;
}

// -- command result body ----------------------------------------------------

/**
 * The server's reply to a {@link CallCommandPayload}. `requestId` echoes the
 * request. Each field is populated for the commands that produce it:
 *  - `create`        → `room`, `invites`
 *  - `join`          → `room`, `participant`, `mediaGrant`
 *  - `accept`        → `invite`
 *  - `leave` / `end`     → `room`
 *  - `setMediaState`     → `participant`
 *  - `sfuConnectTransport` → (no payload — success is the absence of a Nack)
 *  - `sfuProduce`        → `producer`
 *  - `sfuConsume`        → `consumer`
 *
 * Failures come back as the existing `Nack` frame keyed by the same
 * `requestId` (no separate error channel), so clients reuse their Ack/Nack
 * correlation plumbing.
 */
export interface CallCommandResultPayload {
  readonly requestId: string;
  readonly op: CallCommandName;
  readonly room?: CallRoomRecord;
  readonly invites?: readonly CallInviteRecord[];
  readonly participant?: CallParticipantRecord;
  readonly mediaGrant?: CallMediaGrant;
  readonly invite?: CallInviteRecord;
  /** `sfuProduce` → the server-assigned producer the client returns to the transport. */
  readonly producer?: CallSfuProduceResult;
  /** `sfuConsume` → the consumer params the client feeds to `recvTransport.consume`. */
  readonly consumer?: CallSfuConsumeResult;
}

/** Result of a {@link ProduceSfuCommand}: the new server-side producer id. */
export interface CallSfuProduceResult {
  readonly producerId: string;
  readonly kind: CallSfuMediaKind;
}

/** Result of a {@link ConsumeSfuCommand}: everything `recvTransport.consume` needs. */
export interface CallSfuConsumeResult {
  readonly consumerId: string;
  readonly producerId: string;
  readonly kind: CallSfuMediaKind;
  readonly rtpParameters: CallSfuRtpParameters;
}

/**
 * Build the opaque `WebRTCSignal` value carried by a `SignalSend` frame. The
 * server is a control plane only: it relays `payload` byte-for-byte without
 * interpreting it (it's the SDP / ICE candidate the media layer produces).
 */
export interface WebRTCSignalValue extends PlainObject {
  readonly senderDeviceId: string;
  readonly recipientDeviceId?: string;
  readonly kind: WebRTCSignalKind;
  readonly payload: Uint8Array;
}

/** Canonical signal type name for WebRTC relay (matches the server schema). */
export const WEBRTC_SIGNAL_TYPE = "WebRTCSignal";
