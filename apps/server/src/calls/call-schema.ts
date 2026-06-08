import type {
  EventDef,
  FrickSchema,
  ObjectDef,
  SignalDef,
  StreamDef,
} from "@fricken/protocol";

/**
 * FR-79 — Canonical schema fragment for the call control plane.
 *
 * The control plane persists `CallRoom` / `CallInvite` / `CallParticipant` as
 * regular object records and emits durable lifecycle events on a
 * `CallEventStream`, plus routes WebRTC `WebRTCSignal`s. Object/stream/event/
 * signal *types* (and every field) must be declared in the running schema or
 * the protocol codec throws `Unknown ...` at pack time — so a host that uses
 * the control plane must include these definitions in its schema.
 *
 * These are exported as plain arrays so a host can splice them into its own
 * schema with whatever type-ids it has free. {@link buildCallSchema} stitches
 * them into a complete, self-contained schema (used by the FR-79 tests and as a
 * ready-to-use default for call-only deployments).
 *
 * The shapes intentionally line up with the chat-video design spec
 * (`internal/specs/2026-05-09-frick-chat-video-calls-design.md`, §8) and the
 * existing `productTestSchema` `CallRoom` / `CallEventStream` / `WebRTCSignal`
 * fixtures, extended with the invite + participant objects and the full event
 * set the lifecycle needs.
 */

/** Type names the control plane reads/writes. Overridable per deployment. */
export interface CallTypeNames {
  readonly callRoom: string;
  readonly callInvite: string;
  readonly callParticipant: string;
  readonly callEventStream: string;
  readonly webrtcSignal: string;
  readonly events: {
    readonly created: string;
    readonly inviteSent: string;
    readonly inviteAccepted: string;
    readonly participantJoined: string;
    readonly participantMediaChanged: string;
    readonly participantLeft: string;
    readonly ended: string;
  };
}

/** Default type names, matching the design spec + existing fixtures. */
export const DEFAULT_CALL_TYPE_NAMES: CallTypeNames = {
  callRoom: "CallRoom",
  callInvite: "CallInvite",
  callParticipant: "CallParticipant",
  callEventStream: "CallEventStream",
  webrtcSignal: "WebRTCSignal",
  events: {
    created: "CallCreated",
    inviteSent: "CallInviteSent",
    inviteAccepted: "CallInviteAccepted",
    participantJoined: "CallParticipantJoined",
    participantMediaChanged: "CallParticipantMediaChanged",
    participantLeft: "CallParticipantLeft",
    ended: "CallEnded",
  },
};

/** Lifecycle states a `CallRoom` moves through. */
export const CALL_ROOM_STATES = ["ringing", "active", "ended"] as const;
export type CallRoomState = (typeof CALL_ROOM_STATES)[number];

/** Lifecycle states a `CallInvite` moves through. */
export const CALL_INVITE_STATES = ["ringing", "accepted", "declined", "cancelled"] as const;
export type CallInviteState = (typeof CALL_INVITE_STATES)[number];

/**
 * Object definitions for the call control plane. Ids start at `idBase`; the
 * caller supplies a base that does not collide with its own objects.
 */
export function callObjectDefs(idBase = 1): ObjectDef[] {
  return [
    {
      id: idBase,
      name: "CallRoom",
      fields: [
        { id: 1, name: "conversationId", kind: "string", required: true },
        {
          id: 2,
          name: "state",
          kind: "enum",
          enumValues: [...CALL_ROOM_STATES],
          required: true,
        },
        { id: 3, name: "createdBy", kind: "string", required: true },
        { id: 4, name: "kind", kind: "enum", enumValues: ["audio", "video"], required: true },
        { id: 5, name: "createdAt", kind: "timestamp", required: true },
        { id: 6, name: "startedAt", kind: "timestamp", required: false },
        { id: 7, name: "endedAt", kind: "timestamp", required: false },
        { id: 8, name: "mediaSessionId", kind: "string", required: false },
        { id: 9, name: "transport", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "byConversation", fields: ["conversationId", "state"] }],
    },
    {
      id: idBase + 1,
      name: "CallInvite",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "inviteeUserId", kind: "string", required: true },
        {
          id: 3,
          name: "status",
          kind: "enum",
          enumValues: [...CALL_INVITE_STATES],
          required: true,
        },
        { id: 4, name: "invitedBy", kind: "string", required: true },
        { id: 5, name: "invitedAt", kind: "timestamp", required: true },
        { id: 6, name: "respondedAt", kind: "timestamp", required: false },
      ],
      indexes: [{ id: 1, name: "byCall", fields: ["callId", "inviteeUserId"] }],
    },
    {
      id: idBase + 2,
      name: "CallParticipant",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "userId", kind: "string", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
        {
          id: 4,
          name: "state",
          kind: "enum",
          enumValues: ["joined", "left"],
          required: true,
        },
        { id: 5, name: "joinedAt", kind: "timestamp", required: true },
        { id: 6, name: "leftAt", kind: "timestamp", required: false },
        { id: 7, name: "micEnabled", kind: "bool", required: true },
        { id: 8, name: "cameraEnabled", kind: "bool", required: true },
        { id: 9, name: "screenSharing", kind: "bool", required: true },
      ],
      indexes: [{ id: 1, name: "byCall", fields: ["callId", "userId"] }],
    },
  ];
}

/** Event definitions emitted on the `CallEventStream`. */
export function callEventDefs(idBase = 1): EventDef[] {
  return [
    {
      id: idBase,
      name: "CallCreated",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "conversationId", kind: "string", required: true },
        { id: 3, name: "createdBy", kind: "string", required: true },
        { id: 4, name: "kind", kind: "string", required: true },
        { id: 5, name: "createdAt", kind: "timestamp", required: true },
      ],
    },
    {
      id: idBase + 1,
      name: "CallInviteSent",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "inviteeUserId", kind: "string", required: true },
        { id: 3, name: "invitedBy", kind: "string", required: true },
      ],
    },
    {
      id: idBase + 2,
      name: "CallInviteAccepted",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "inviteeUserId", kind: "string", required: true },
      ],
    },
    {
      id: idBase + 3,
      name: "CallParticipantJoined",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "userId", kind: "string", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
        { id: 4, name: "joinedAt", kind: "timestamp", required: true },
      ],
    },
    {
      id: idBase + 4,
      name: "CallParticipantMediaChanged",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "userId", kind: "string", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
        { id: 4, name: "micEnabled", kind: "bool", required: true },
        { id: 5, name: "cameraEnabled", kind: "bool", required: true },
        { id: 6, name: "screenSharing", kind: "bool", required: true },
      ],
    },
    {
      id: idBase + 5,
      name: "CallParticipantLeft",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "userId", kind: "string", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
        { id: 4, name: "leftAt", kind: "timestamp", required: true },
      ],
    },
    {
      id: idBase + 6,
      name: "CallEnded",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "endedBy", kind: "string", required: true },
        { id: 3, name: "endedAt", kind: "timestamp", required: true },
      ],
    },
  ];
}

/** Stream definition for the call event log. */
export function callStreamDefs(idBase = 1): StreamDef[] {
  return [
    {
      id: idBase,
      name: "CallEventStream",
      keyFields: [{ id: 1, name: "callId", kind: "string", required: true }],
      events: [
        "CallCreated",
        "CallInviteSent",
        "CallInviteAccepted",
        "CallParticipantJoined",
        "CallParticipantMediaChanged",
        "CallParticipantLeft",
        "CallEnded",
      ],
    },
  ];
}

/** Signal definition for WebRTC SDP/ICE routing during a call. */
export function callSignalDefs(idBase = 1): SignalDef[] {
  return [
    {
      id: idBase,
      name: "WebRTCSignal",
      ttlMs: 30_000,
      keyFields: [{ id: 1, name: "callId", kind: "string", required: true }],
      fields: [
        { id: 1, name: "senderDeviceId", kind: "string", required: true },
        { id: 2, name: "recipientDeviceId", kind: "string", required: false },
        {
          id: 3,
          name: "kind",
          kind: "enum",
          enumValues: ["offer", "answer", "ice", "renegotiate", "sfuToken"],
          required: true,
        },
        { id: 4, name: "payload", kind: "bytes", required: true },
      ],
    },
  ];
}

/**
 * Build a complete, self-contained {@link FrickSchema} carrying only the call
 * control-plane types. Used by the FR-79 tests and suitable as a default for a
 * call-only deployment. Hosts that also run chat splice the
 * `call*Defs(idBase)` arrays into their own schema instead.
 */
export function buildCallSchema(): FrickSchema {
  return {
    name: "frick-calls",
    schemaId: "frick-calls",
    schemaVersion: "0.1.0",
    schemaRevision: 1,
    minimumClientRevision: 1,
    minimumServerRevision: 1,
    protocol: "frick.realtime",
    protocolVersion: 1,
    compatibility: "greenfield-cutover",
    hash: "frick-calls-0.1.0",
    objects: callObjectDefs(1),
    streams: callStreamDefs(1),
    events: callEventDefs(1),
    presences: [],
    signals: callSignalDefs(1),
    blobs: [],
    jobs: [],
    projections: [],
  };
}
