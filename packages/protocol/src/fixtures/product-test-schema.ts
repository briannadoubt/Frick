import type { FrickSchema } from "../schema.js";

// Snapshot of the pre-cleanup `foundationSchema` (the chat/customer-facing
// product shapes that used to live in the framework's foundation). Kept here
// purely as a non-trivial fixture so tests can exercise the framework
// primitives — registration, codecs, authz, projections, generators, etc. —
// against a realistic schema. The production `foundationSchema` is
// intentionally empty; do not import this file from runtime code.
export const productTestSchema: FrickSchema = {
  name: "frick-product-test",
  schemaId: "frick-product-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "frick-product-test-0.2.0",
  objects: [
    {
      id: 1,
      name: "User",
      fields: [
        { id: 1, name: "displayName", kind: "string", required: true },
        { id: 2, name: "avatarBlobId", kind: "ref", ref: "AttachmentBlob", required: false },
      ],
      indexes: [{ id: 1, name: "all", fields: ["displayName"] }],
    },
    {
      id: 2,
      name: "Conversation",
      fields: [
        { id: 1, name: "kind", kind: "enum", enumValues: ["dm", "group", "channel"], required: true },
        { id: 2, name: "title", kind: "string", required: false },
        { id: 3, name: "createdBy", kind: "ref", ref: "User", required: true },
        { id: 4, name: "lastMessageEventId", kind: "string", required: false },
      ],
      indexes: [{ id: 1, name: "all", fields: ["kind"] }],
    },
    {
      id: 3,
      name: "RoomMember",
      fields: [
        { id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 2, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 3, name: "role", kind: "enum", enumValues: ["owner", "member"], required: true },
      ],
      indexes: [{ id: 1, name: "byConversation", fields: ["conversationId"] }],
    },
    {
      id: 5,
      name: "UserDevice",
      fields: [
        { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 2, name: "label", kind: "string", required: false },
        { id: 3, name: "platform", kind: "enum", enumValues: ["web", "ios", "android", "server"], required: true },
        { id: 4, name: "lastSeenAt", kind: "timestamp", required: false },
      ],
      indexes: [{ id: 1, name: "byUser", fields: ["userId"] }],
    },
    {
      id: 6,
      name: "UserSession",
      fields: [
        { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 2, name: "deviceId", kind: "string", required: true },
        { id: 3, name: "replicaId", kind: "string", required: true },
        { id: 4, name: "expiresAt", kind: "timestamp", required: true },
      ],
      indexes: [{ id: 1, name: "byUser", fields: ["userId"] }],
    },
    {
      // Composer draft synced across the user's devices. Keyed by
      // `(userId, conversationId)`; only the draft's owner sees it.
      // Updated by the React `useDraft` hook (Phase 6b shipped local
      // persistence; this object enables the cross-device upgrade).
      id: 7,
      name: "MessageDraft",
      fields: [
        { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 2, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 3, name: "body", kind: "string", required: true },
        { id: 4, name: "updatedAt", kind: "timestamp", required: true },
      ],
      indexes: [{ id: 1, name: "byOwner", fields: ["userId", "conversationId"] }],
      mergePolicy: "versionPrecondition",
    },
    {
      // Pre-composed message scheduled for later delivery. Server's
      // jobs framework runs a periodic sweep that promotes due rows to
      // `MessageSent` events and tombstones the draft.
      id: 8,
      name: "ScheduledMessage",
      fields: [
        { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 2, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 3, name: "body", kind: "string", required: true },
        { id: 4, name: "scheduledFor", kind: "timestamp", required: true },
        { id: 5, name: "attachmentBlobIds", kind: "json", required: false },
        { id: 6, name: "status", kind: "enum", enumValues: ["pending", "delivered", "cancelled"], required: true },
      ],
      indexes: [{ id: 1, name: "byDueDate", fields: ["status", "scheduledFor"] }],
      mergePolicy: "versionPrecondition",
    },
    // Realtime-calls control plane (FR-282). These mirror the canonical Rust
    // defs in `crates/frick-server/src/calls/schema.rs`
    // (`call_object_defs`/`call_event_defs`/`call_stream_defs`/`call_signal_defs`)
    // field-for-field so the product-test fixture carries the *current* call
    // record shapes a live `CallCommand` writes (e.g. `CallRoom.kind`), not the
    // older partial shapes. Appended at the next free ids (CallRoom moved from
    // its old id 4) so the chat types' ids stay stable.
    {
      id: 9,
      name: "CallRoom",
      fields: [
        { id: 1, name: "conversationId", kind: "string", required: true },
        { id: 2, name: "state", kind: "enum", enumValues: ["ringing", "active", "ended"], required: true },
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
      id: 10,
      name: "CallInvite",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "inviteeUserId", kind: "string", required: true },
        { id: 3, name: "status", kind: "enum", enumValues: ["ringing", "accepted", "declined", "cancelled"], required: true },
        { id: 4, name: "invitedBy", kind: "string", required: true },
        { id: 5, name: "invitedAt", kind: "timestamp", required: true },
        { id: 6, name: "respondedAt", kind: "timestamp", required: false },
      ],
      indexes: [{ id: 1, name: "byCall", fields: ["callId", "inviteeUserId"] }],
    },
    {
      id: 11,
      name: "CallParticipant",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "userId", kind: "string", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
        { id: 4, name: "state", kind: "enum", enumValues: ["joined", "left"], required: true },
        { id: 5, name: "joinedAt", kind: "timestamp", required: true },
        { id: 6, name: "leftAt", kind: "timestamp", required: false },
        { id: 7, name: "micEnabled", kind: "bool", required: true },
        { id: 8, name: "cameraEnabled", kind: "bool", required: true },
        { id: 9, name: "screenSharing", kind: "bool", required: true },
      ],
      indexes: [{ id: 1, name: "byCall", fields: ["callId", "userId"] }],
    },
  ],
  streams: [
    {
      id: 1,
      name: "MessageStream",
      keyFields: [{ id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true }],
      events: ["MessageSent", "MessageEdited", "MessageRedacted", "ReactionAdded", "ReceiptAdvanced"],
    },
    {
      id: 2,
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
  ],
  events: [
    {
      id: 1,
      name: "MessageSent",
      fields: [
        { id: 1, name: "messageId", kind: "id", required: true },
        { id: 2, name: "senderId", kind: "ref", ref: "User", required: true },
        { id: 3, name: "body", kind: "string", required: true },
        { id: 4, name: "createdAt", kind: "timestamp", required: true },
        { id: 5, name: "attachmentBlobIds", kind: "json", required: false },
      ],
    },
    {
      id: 2,
      name: "MessageEdited",
      fields: [
        { id: 1, name: "messageId", kind: "id", required: true },
        { id: 2, name: "body", kind: "string", required: true },
        { id: 3, name: "editedAt", kind: "timestamp", required: true },
      ],
    },
    {
      id: 3,
      name: "MessageRedacted",
      fields: [
        { id: 1, name: "messageId", kind: "id", required: true },
        { id: 2, name: "redactedAt", kind: "timestamp", required: true },
      ],
    },
    {
      id: 4,
      name: "ReactionAdded",
      fields: [
        { id: 1, name: "messageId", kind: "id", required: true },
        { id: 2, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 3, name: "emoji", kind: "string", required: true },
      ],
    },
    {
      id: 5,
      name: "ReceiptAdvanced",
      fields: [
        { id: 1, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 2, name: "sequence", kind: "int", required: true },
      ],
    },
    {
      id: 6,
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
      id: 7,
      name: "CallInviteSent",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "inviteeUserId", kind: "string", required: true },
        { id: 3, name: "invitedBy", kind: "string", required: true },
      ],
    },
    {
      id: 8,
      name: "CallInviteAccepted",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "inviteeUserId", kind: "string", required: true },
      ],
    },
    {
      id: 9,
      name: "CallParticipantJoined",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "userId", kind: "string", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
        { id: 4, name: "joinedAt", kind: "timestamp", required: true },
      ],
    },
    {
      id: 10,
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
      id: 11,
      name: "CallParticipantLeft",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "userId", kind: "string", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
        { id: 4, name: "leftAt", kind: "timestamp", required: true },
      ],
    },
    {
      id: 12,
      name: "CallEnded",
      fields: [
        { id: 1, name: "callId", kind: "string", required: true },
        { id: 2, name: "endedBy", kind: "string", required: true },
        { id: 3, name: "endedAt", kind: "timestamp", required: true },
      ],
    },
  ],
  presences: [
    {
      id: 1,
      name: "TypingState",
      ttlMs: 5000,
      keyFields: [
        { id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 2, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 3, name: "deviceId", kind: "string", required: true },
      ],
      fields: [{ id: 1, name: "isTyping", kind: "bool", required: true }],
    },
  ],
  signals: [
    {
      id: 1,
      name: "WebRTCSignal",
      ttlMs: 30000,
      keyFields: [{ id: 1, name: "callId", kind: "string", required: true }],
      fields: [
        { id: 1, name: "senderDeviceId", kind: "string", required: true },
        { id: 2, name: "recipientDeviceId", kind: "string", required: false },
        {
          id: 3,
          name: "kind",
          kind: "enum",
          // Mirrors the WebRTCSignalKind wire type — incl. keyEpoch (E2EE
          // sender-key signal). Kept in sync with frick_server::calls::schema.
          enumValues: ["offer", "answer", "ice", "renegotiate", "sfuToken", "keyEpoch"],
          required: true,
        },
        { id: 4, name: "payload", kind: "bytes", required: true },
      ],
    },
  ],
  blobs: [
    {
      id: 1,
      name: "AttachmentBlob",
      metadataFields: [
        { id: 1, name: "contentHash", kind: "string", required: true },
        { id: 2, name: "byteLength", kind: "int", required: true },
        { id: 3, name: "mimeType", kind: "string", required: true },
      ],
    },
  ],
  jobs: [
    {
      id: 1,
      name: "PushNotificationJob",
      fields: [
        { id: 1, name: "recipientUserId", kind: "ref", ref: "User", required: true },
        { id: 2, name: "kind", kind: "string", required: true },
        { id: 3, name: "payload", kind: "json", required: true },
      ],
    },
  ],
  projections: [
    {
      id: 1,
      name: "ConversationInbox",
      source: "MessageStream",
      fields: [
        { id: 1, name: "conversationId", kind: "ref", ref: "Conversation", required: true },
        { id: 2, name: "userId", kind: "ref", ref: "User", required: true },
        { id: 3, name: "title", kind: "string", required: false },
        { id: 4, name: "kind", kind: "string", required: true },
        { id: 5, name: "lastSequence", kind: "int", required: true },
        { id: 6, name: "lastMessageBody", kind: "string", required: false },
        { id: 7, name: "lastMessageAt", kind: "timestamp", required: false },
        { id: 8, name: "lastMessageSenderId", kind: "ref", ref: "User", required: false },
        { id: 9, name: "readSequence", kind: "int", required: true },
        { id: 10, name: "unreadCount", kind: "int", required: true },
        { id: 11, name: "updatedAt", kind: "timestamp", required: true },
      ],
      indexes: [
        { id: 1, name: "byConversation", fields: ["conversationId"] },
        { id: 2, name: "byUser", fields: ["userId"] },
      ],
    },
  ],
};
