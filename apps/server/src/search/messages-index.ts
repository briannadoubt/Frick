import type { FrickSearchIndexDefinition } from "./types.js";

export const MESSAGES_SEARCH_INDEX_NAME = "messages-fts";

/**
 * Default search index over `MessageStream` events. Skips non-MessageSent
 * events (presence ticks, receipts) and projects each message body as the
 * indexed text plus `senderId` / `conversationId` as filterable fields.
 *
 * Apps that need stricter per-conversation access control can layer a
 * registered `FrickPolicyHook` over the `search.query` action.
 */
export function createMessagesSearchIndex(): FrickSearchIndexDefinition {
  return {
    name: MESSAGES_SEARCH_INDEX_NAME,
    source: { kind: "stream", type: "MessageStream" },
    project(input) {
      const event = input.streamEvent;
      if (!event) return null;
      if (event.event !== "MessageSent") return null;
      const body = typeof event.payload.body === "string" ? event.payload.body : "";
      if (!body) return null;
      const fields: Record<string, string | number> = {
        conversationId: event.streamId,
      };
      if (typeof event.payload.senderId === "string") {
        fields.senderId = event.payload.senderId;
      }
      return {
        docId: event.eventId,
        text: body,
        fields,
      };
    },
  };
}
