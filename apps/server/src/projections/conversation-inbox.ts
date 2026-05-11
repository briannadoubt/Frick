import type { PlainObject } from "@frick/protocol";
import type { ConversationInboxRow } from "../storage/inbox-store.js";
import type {
  FrickProjection,
  FrickProjectionContext,
  FrickProjectionWriteEvent,
  ProjectionApplyResult,
  ProjectionChange,
} from "./registry.js";

/**
 * The conversation inbox is a per-user materialised view over
 * `MessageStream` events and `RoomMember` objects. It exposes:
 *   - last message body / sender / timestamp per (conversation, user)
 *   - read cursor (advanced by `ReceiptAdvanced` stream events)
 *   - unread count (server-side count of messages past `readSequence`)
 *
 * The handler implements `read(?userId=)`, `apply(...)`, and `rebuild(...)`
 * so admins can resync the projection from raw `stream_events` plus the
 * current set of `RoomMember` rows.
 */

export const CONVERSATION_INBOX_PROJECTION_NAME = "conversation-inbox";

export function createConversationInboxProjection(): FrickProjection {
  return {
    name: CONVERSATION_INBOX_PROJECTION_NAME,
    sources: [
      { kind: "stream", type: "MessageStream" },
      { kind: "object", type: "RoomMember" },
    ],
    handler: {
      apply(event, ctx) {
        if (event.kind === "streamEvent" && event.streamType === "MessageStream") {
          return applyStreamEvent(event, ctx);
        }
        if (event.kind === "objectUpsert" && event.objectType === "RoomMember") {
          return applyRoomMemberUpsert(event, ctx);
        }
        return undefined;
      },
      rebuild(ctx) {
        rebuildInbox(ctx);
      },
      read(ctx, query) {
        const userId = query.userId;
        if (!userId) {
          throw new Error("userId query parameter is required");
        }
        return ctx.store.listInbox(ctx.tenantId, userId);
      },
    },
  };
}

function applyStreamEvent(
  event: FrickProjectionWriteEvent,
  ctx: FrickProjectionContext,
): ProjectionApplyResult | undefined {
  const stored = event.streamEvent as
    | {
        event: string;
        streamId: string;
        sequence: number;
        payload: Record<string, unknown>;
      }
    | undefined;
  if (!stored) return undefined;
  if (stored.event === "MessageSent") {
    return { changes: projectMessageSent(ctx, stored.streamId, stored.sequence, stored.payload) };
  }
  if (stored.event === "ReceiptAdvanced") {
    return { changes: projectReceiptAdvanced(ctx, stored.streamId, stored.payload) };
  }
  return undefined;
}

function applyRoomMemberUpsert(
  event: FrickProjectionWriteEvent,
  ctx: FrickProjectionContext,
): ProjectionApplyResult | undefined {
  const member = event.object as PlainObject | undefined;
  if (!member) return undefined;
  const conversationId = typeof member.conversationId === "string" ? member.conversationId : "";
  const userId = typeof member.userId === "string" ? member.userId : "";
  if (!conversationId || !userId) return undefined;
  const existing = ctx.store.inbox.read(ctx.tenantId, conversationId, userId);
  if (existing) return undefined;
  const conversation = readConversation(ctx, conversationId);
  const latest = latestMessage(ctx, conversationId);
  const row: ConversationInboxRow = {
    conversationId,
    userId,
    kind: conversation.kind,
    lastSequence: latest?.sequence ?? 0,
    readSequence: 0,
    unreadCount: countUnread(ctx, conversationId, userId, 0),
    updatedAt: new Date().toISOString(),
    ...(conversation.title !== undefined ? { title: conversation.title } : {}),
    ...(latest?.body !== undefined ? { lastMessageBody: latest.body } : {}),
    ...(latest?.createdAt !== undefined ? { lastMessageAt: latest.createdAt } : {}),
    ...(latest?.senderId !== undefined ? { lastMessageSenderId: latest.senderId } : {}),
  };
  ctx.store.inbox.upsert(ctx.tenantId, row);
  return { changes: [inboxChange(row)] };
}

function projectMessageSent(
  ctx: FrickProjectionContext,
  conversationId: string,
  sequence: number,
  payload: Record<string, unknown>,
): ProjectionChange[] {
  const senderId = stringField(payload.senderId);
  const body = stringField(payload.body);
  const createdAt = stringField(payload.createdAt);
  const members = listRoomMembers(ctx, conversationId);
  const conversation = readConversation(ctx, conversationId);
  const updatedAt = new Date().toISOString();
  const changes: ProjectionChange[] = [];

  for (const member of members) {
    const current = ctx.store.inbox.read(ctx.tenantId, conversationId, member.userId);
    const requestedReadSequence =
      current?.readSequence ?? (member.userId === senderId ? sequence : 0);
    const readSequence = Math.min(requestedReadSequence, sequence);
    const row: ConversationInboxRow = {
      conversationId,
      userId: member.userId,
      kind: conversation.kind,
      lastSequence: sequence,
      readSequence,
      unreadCount: countUnread(ctx, conversationId, member.userId, readSequence),
      updatedAt,
      ...(conversation.title !== undefined ? { title: conversation.title } : {}),
      ...(body !== undefined ? { lastMessageBody: body } : {}),
      ...(createdAt !== undefined ? { lastMessageAt: createdAt } : {}),
      ...(senderId !== undefined ? { lastMessageSenderId: senderId } : {}),
    };
    ctx.store.inbox.upsert(ctx.tenantId, row);
    changes.push(inboxChange(row));
  }
  return changes;
}

function projectReceiptAdvanced(
  ctx: FrickProjectionContext,
  conversationId: string,
  payload: Record<string, unknown>,
): ProjectionChange[] {
  const userId = stringField(payload.userId);
  const requestedReadSequence = numberField(payload.sequence);
  if (!userId) return [];
  if (!ctx.store.isRoomMember(ctx.tenantId, conversationId, userId)) return [];

  const current = ctx.store.inbox.read(ctx.tenantId, conversationId, userId);
  const latest = latestMessage(ctx, conversationId);
  const conversation = readConversation(ctx, conversationId);
  const latestSequence = Math.max(current?.lastSequence ?? 0, latest?.sequence ?? 0);
  if (latestSequence === 0 && !current) return [];
  const readSequence = Math.min(
    Math.max(current?.readSequence ?? 0, requestedReadSequence),
    latestSequence,
  );
  const lastMessageBody = current?.lastMessageBody ?? latest?.body;
  const lastMessageAt = current?.lastMessageAt ?? latest?.createdAt;
  const lastMessageSenderId = current?.lastMessageSenderId ?? latest?.senderId;

  const row: ConversationInboxRow = {
    conversationId,
    userId,
    kind: conversation.kind,
    lastSequence: latestSequence,
    readSequence,
    unreadCount: countUnread(ctx, conversationId, userId, readSequence),
    updatedAt: new Date().toISOString(),
    ...(conversation.title !== undefined ? { title: conversation.title } : {}),
    ...(lastMessageBody !== undefined ? { lastMessageBody } : {}),
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(lastMessageSenderId !== undefined ? { lastMessageSenderId } : {}),
  };
  ctx.store.inbox.upsert(ctx.tenantId, row);
  return [inboxChange(row)];
}

/**
 * Canonical row key used by the conversation-inbox projection: `${userId}:${conversationId}`.
 * Stable so subscribed clients can deterministically index/replace rows.
 */
export function conversationInboxRowKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

function inboxChange(row: ConversationInboxRow): ProjectionChange {
  return {
    key: conversationInboxRowKey(row.userId, row.conversationId),
    value: rowToPlainObject(row),
  };
}

function rowToPlainObject(row: ConversationInboxRow): PlainObject {
  // Spread to ensure every field is enumerable on a plain object; the row
  // interface already uses only msgpack-friendly primitives.
  return { ...row } as unknown as PlainObject;
}

function rebuildInbox(ctx: FrickProjectionContext): void {
  // Collect every (conversation, member) pair from current RoomMember rows.
  const members = ctx.store.listObjects(ctx.tenantId, "RoomMember");
  const conversationIds = new Set<string>();
  for (const member of members) {
    if (typeof member.conversationId === "string") {
      conversationIds.add(member.conversationId);
    }
  }

  // Truncate inbox rows for this tenant before rebuilding so deletions in
  // the source data don't leave orphan rows behind.
  for (const conversationId of conversationIds) {
    const memberIds = members
      .filter((m) => m.conversationId === conversationId && typeof m.userId === "string")
      .map((m) => m.userId as string);
    for (const userId of memberIds) {
      // Overwrite with an initial empty row; replay below will fill it in.
      const conversation = readConversation(ctx, conversationId);
      ctx.store.inbox.upsert(ctx.tenantId, {
        conversationId,
        userId,
        kind: conversation.kind,
        lastSequence: 0,
        readSequence: 0,
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
        ...(conversation.title !== undefined ? { title: conversation.title } : {}),
      });
    }

    // Replay MessageStream events in order; each MessageSent advances every
    // member's row, each ReceiptAdvanced advances the matching member's
    // cursor. This mirrors `apply(...)` exactly so the rebuilt state matches
    // what live writes would produce.
    const events = ctx.store.readEvents(ctx.tenantId, "MessageStream", conversationId, 0);
    for (const stored of events) {
      if (stored.event === "MessageSent") {
        projectMessageSent(ctx, conversationId, stored.sequence, stored.payload);
      } else if (stored.event === "ReceiptAdvanced") {
        projectReceiptAdvanced(ctx, conversationId, stored.payload);
      }
    }
  }
}

function listRoomMembers(
  ctx: FrickProjectionContext,
  conversationId: string,
): Array<{ userId: string; role: string }> {
  return ctx.store
    .listObjects(ctx.tenantId, "RoomMember")
    .filter((m) => m.conversationId === conversationId && typeof m.userId === "string")
    .map((m) => ({
      userId: m.userId as string,
      role: typeof m.role === "string" ? m.role : "member",
    }));
}

function readConversation(
  ctx: FrickProjectionContext,
  conversationId: string,
): { kind: string; title?: string } {
  const conversation = ctx.store.readObject(ctx.tenantId, "Conversation", conversationId);
  return {
    kind: typeof conversation?.kind === "string" ? conversation.kind : "channel",
    ...(typeof conversation?.title === "string" ? { title: conversation.title } : {}),
  };
}

function latestMessage(
  ctx: FrickProjectionContext,
  conversationId: string,
): { sequence: number; body?: string; createdAt?: string; senderId?: string } | undefined {
  return ctx.store
    .readEvents(ctx.tenantId, "MessageStream", conversationId, 0)
    .filter((candidate) => candidate.event === "MessageSent")
    .map((candidate) => ({
      sequence: candidate.sequence,
      ...(typeof candidate.payload.body === "string"
        ? { body: candidate.payload.body }
        : {}),
      ...(typeof candidate.payload.createdAt === "string"
        ? { createdAt: candidate.payload.createdAt }
        : {}),
      ...(typeof candidate.payload.senderId === "string"
        ? { senderId: candidate.payload.senderId }
        : {}),
    }))
    .at(-1);
}

function countUnread(
  ctx: FrickProjectionContext,
  conversationId: string,
  userId: string,
  readSequence: number,
): number {
  return ctx.store
    .readEvents(ctx.tenantId, "MessageStream", conversationId, readSequence)
    .filter((event) => event.event === "MessageSent" && event.payload.senderId !== userId).length;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Re-export the row shape for downstream consumers that build typed clients
// around the projection's read result.
export type { ConversationInboxRow };
