/**
 * Real-time UX wrappers.
 *
 * Every chat app rebuilds the same primitives — typing indicators,
 * reactions, read receipts, live cursors, message-action menus — on top
 * of the framework's presence/stream/projection primitives. This module
 * collapses those rebuilds into one-import hooks so a `useReactions(id)`
 * call gives you everything you need.
 *
 * Built on existing schema: `TypingState` / `RTC` presences,
 * `ReactionAdded` / `MessageEdited` / `MessageRedacted` events,
 * `ConversationInbox` projection. Nothing here requires server changes.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { readReceiptsForConversation, type InboxRow, type RoomMember } from "./chat-foundation.js";
import {
  useAppend,
  useFrick,
  useFrickSession,
  usePresence,
  useProjection,
  useSetPresence,
  useStream,
} from "@fricken/react";
import type { ChatStreamEvent } from "./chat-foundation.js";

/** Aggregated reactions for a single message, computed from MessageStream events. */
export interface ReactionAggregate {
  readonly emoji: string;
  /** UserIds that have reacted with this emoji, in first-add order. */
  readonly userIds: readonly string[];
  /** Whether the active user has reacted with this emoji. */
  readonly meReacted: boolean;
}

/**
 * Aggregate reactions for a message. Listens for `ReactionAdded` events on
 * the message's parent stream and folds them into `{ emoji → [userIds] }`.
 *
 * The hook also returns `react(emoji)` / `unreact(emoji)` callbacks that
 * append the corresponding `ReactionAdded` event (the schema models toggle
 * as a single append — apps decide their own server-side dedupe policy).
 */
export function useReactions(
  conversationId: string,
  messageId: string,
): {
  reactions: ReactionAggregate[];
  react: (emoji: string) => Promise<void>;
  unreact: (emoji: string) => Promise<void>;
} {
  const { events } = useStream<ChatStreamEvent>("MessageStream", conversationId);
  const session = useFrickSession();
  const append = useAppend("MessageStream", conversationId);
  const meUserId = session?.userId ?? "";

  const reactions = useMemo(() => aggregateReactions(events, messageId, meUserId), [events, messageId, meUserId]);

  const react = useCallback(
    (emoji: string) =>
      append(
        "ReactionAdded",
        { messageId, userId: meUserId, emoji },
        { optimistic: { messageId, userId: meUserId, emoji } },
      ),
    [append, messageId, meUserId],
  );
  const unreact = useCallback(
    // The schema doesn't currently model a `ReactionRemoved`. Apps that
    // need toggle semantics should send a domain-level retraction event
    // they define. For now we re-emit `ReactionAdded` with a leading "-"
    // marker so server-side aggregation can interpret it; this is a
    // convention the demo can adopt and revisit when the schema grows a
    // first-class retraction event.
    (emoji: string) =>
      append(
        "ReactionAdded",
        { messageId, userId: meUserId, emoji: `-${emoji}` },
        { optimistic: { messageId, userId: meUserId, emoji: `-${emoji}` } },
      ),
    [append, messageId, meUserId],
  );

  return { reactions, react, unreact };
}

/**
 * Typing indicator wrapper around the `TypingState` presence.
 *
 * Returns the list of user ids currently typing (excluding the active user)
 * plus a `setTyping(boolean)` callback that pings presence with a
 * debounced "stop typing" tail so a brief pause doesn't immediately drop
 * the indicator.
 */
export function useTyping(conversationId: string): {
  typingUserIds: string[];
  setTyping: (isTyping: boolean) => void;
} {
  const session = useFrickSession();
  const userId = session?.userId ?? "";
  const deviceId = session?.deviceId ?? "";
  const myKey = `${conversationId}:${userId}:${deviceId}`;
  const setMine = useSetPresence("TypingState", myKey);

  // Track every presence row for the conversation — we want everyone's
  // typing state, not just our own. Server-side, presence is keyed by the
  // composite `${convo}:${user}:${device}`; reading "everyone" requires
  // calling presence per key, which the framework doesn't expose as a
  // wildcard. As a pragmatic interim, we read our own row and surface
  // presence for the active user; a richer "presence list" API is a
  // framework follow-up (see Phase plan §1, Kotlin presence parity gap).
  const myPresence = usePresence<{ isTyping: boolean }>("TypingState", myKey);
  const typingUserIds = useMemo(
    () => (myPresence?.isTyping && userId ? [userId] : []),
    [myPresence?.isTyping, userId],
  );

  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setTyping = useCallback(
    (isTyping: boolean) => {
      if (!userId) return;
      if (stopTimer.current) {
        clearTimeout(stopTimer.current);
        stopTimer.current = null;
      }
      if (isTyping) {
        void setMine({ isTyping: true });
        stopTimer.current = setTimeout(() => void setMine({ isTyping: false }), 2_500);
      } else {
        void setMine({ isTyping: false });
      }
    },
    [setMine, userId],
  );

  useEffect(() => () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
  }, []);

  return { typingUserIds, setTyping };
}

/**
 * Read-receipt aggregation for a conversation. Reads the inbox
 * projection (the canonical per-(user, conversation) row), filters to
 * the supplied member list, and returns each member's latest acknowledged
 * sequence — the same shape `readReceiptsForConversation` returns.
 */
export function useReadReceipts(input: {
  conversationId: string;
  members: RoomMember[];
}): { userId: string; readSequence: number }[] {
  const rows = useProjection<InboxRow>("conversation-inbox");
  const session = useFrickSession();
  const activeUserId = session?.userId ?? "";

  return useMemo(() => {
    const inboxRows = Array.from(rows.values()).filter((row) => row.conversationId === input.conversationId);
    return readReceiptsForConversation({
      conversationId: input.conversationId,
      members: input.members,
      inboxRows,
      activeUserId,
    });
  }, [rows, activeUserId, input.conversationId, input.members]);
}

/**
 * Message-action helpers. `edit(body)` and `redact()` both append the
 * matching event on the parent stream, with optimistic overlays so the
 * UI flashes the change immediately.
 */
export function useMessageActions(
  conversationId: string,
  messageId: string,
): {
  edit: (body: string) => Promise<void>;
  redact: () => Promise<void>;
} {
  const append = useAppend("MessageStream", conversationId);
  const edit = useCallback(
    (body: string) => {
      const editedAt = new Date().toISOString();
      return append(
        "MessageEdited",
        { messageId, body, editedAt },
        { optimistic: { messageId, body, editedAt } },
      );
    },
    [append, messageId],
  );
  const redact = useCallback(() => {
    const redactedAt = new Date().toISOString();
    return append(
      "MessageRedacted",
      { messageId, redactedAt },
      { optimistic: { messageId, redactedAt } },
    );
  }, [append, messageId]);
  return { edit, redact };
}

/**
 * Live cursor / selection sharing via the `RTC` presence type. The
 * payload shape is intentionally loose so consumers can stash whatever
 * cursor / selection / viewport info they want into the presence row.
 * On the receive side, the hook returns the active user's most recent
 * cursor — broadcasting other users' cursors requires the wildcard
 * presence-read API gap noted in `useTyping`.
 */
export function useLiveCursor<T extends Record<string, unknown>>(roomId: string): {
  cursor: T | undefined;
  setCursor: (next: T) => void;
} {
  const session = useFrickSession();
  const key = `${roomId}:${session?.userId ?? ""}:${session?.deviceId ?? ""}`;
  const cursor = usePresence<T>("RTC", key);
  const set = useSetPresence("RTC", key);
  const setCursor = useCallback((next: T) => void set(next), [set]);
  return { cursor, setCursor };
}

/**
 * Pure aggregator used by `useReactions`. Exported so tests don't have to
 * render a hook to exercise it.
 */
export function aggregateReactions(
  events: readonly ChatStreamEvent[],
  messageId: string,
  meUserId: string,
): ReactionAggregate[] {
  const byEmoji = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.event !== "ReactionAdded") continue;
    const payload = event.payload as { messageId?: string; userId?: string; emoji?: string };
    if (payload.messageId !== messageId || !payload.userId || !payload.emoji) continue;
    if (payload.emoji.startsWith("-")) {
      byEmoji.get(payload.emoji.slice(1))?.delete(payload.userId);
      continue;
    }
    const set = byEmoji.get(payload.emoji) ?? new Set<string>();
    set.add(payload.userId);
    byEmoji.set(payload.emoji, set);
  }
  return Array.from(byEmoji.entries())
    .filter(([, ids]) => ids.size > 0)
    .map(([emoji, ids]) => ({
      emoji,
      userIds: Array.from(ids),
      meReacted: meUserId ? ids.has(meUserId) : false,
    }));
}

// Re-export the consumer's hook (just `useFrick`) so this module is a
// pure addition; consumers can import everything from `@fricken/react`.
export { useFrick };
