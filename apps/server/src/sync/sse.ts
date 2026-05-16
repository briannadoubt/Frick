import type http from "node:http";
import type { FrickSchema } from "@frick/protocol";
import type { StoredEvent } from "../storage/stream-store.js";

export interface SseOpenInput {
  tenantId: string;
  stream: string;
  key: string;
  events: StoredEvent[];
  cursor: number;
  hasMore?: boolean;
}

interface SseClient {
  response: http.ServerResponse;
  tenantId: string;
  stream: string;
  key: string;
  heartbeat?: ReturnType<typeof setInterval>;
}

export interface SseRegistryOptions {
  heartbeatMs?: number;
  maxBufferedBytes?: number;
}

export class SseRegistry {
  readonly #clients = new Set<SseClient>();
  readonly #heartbeatMs: number;
  readonly #maxBufferedBytes: number;

  constructor(
    private readonly schema: FrickSchema,
    options: SseRegistryOptions = {},
  ) {
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
  }

  get connectionCount(): number {
    return this.#clients.size;
  }

  open(response: http.ServerResponse, input: SseOpenInput): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-frick-schema-hash": this.schema.hash,
    });

    const client: SseClient = {
      response,
      tenantId: input.tenantId,
      stream: input.stream,
      key: input.key,
    };
    this.#clients.add(client);
    response.on("close", () => {
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
      }
      this.#clients.delete(client);
    });

    this.#write(client, "stream-page", {
      schemaHash: this.schema.hash,
      stream: input.stream,
      key: input.key,
      data: input.events,
      cursor: input.events.at(-1)?.sequence ?? input.cursor,
      hasMore: input.hasMore ?? false,
    });

    if (this.#heartbeatMs > 0) {
      client.heartbeat = setInterval(() => {
        this.#writeComment(client, "keep-alive");
      }, this.#heartbeatMs);
      client.heartbeat.unref?.();
    }
  }

  publishStreamEvent(event: StoredEvent): void {
    for (const client of this.#clients) {
      if (
        client.tenantId !== event.tenantId ||
        client.stream !== event.stream ||
        client.key !== event.streamId
      ) {
        continue;
      }
      this.#write(client, "delta", {
        schemaHash: this.schema.hash,
        stream: event.stream,
        key: event.streamId,
        data: [event],
        cursor: event.sequence,
      });
    }
  }

  closeAll(): void {
    for (const client of this.#clients) {
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
      }
      client.response.end();
    }
    this.#clients.clear();
  }

  #write(client: SseClient, event: string, payload: unknown): void {
    this.#writeRaw(client, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  #writeComment(client: SseClient, comment: string): void {
    this.#writeRaw(client, `: ${comment}\n\n`);
  }

  #writeRaw(client: SseClient, chunk: string): void {
    if (client.response.writableLength > this.#maxBufferedBytes) {
      this.#closeClient(client);
      return;
    }
    const accepted = client.response.write(chunk);
    if (!accepted || client.response.writableLength > this.#maxBufferedBytes) {
      this.#closeClient(client);
    }
  }

  #closeClient(client: SseClient): void {
    if (client.heartbeat) {
      clearInterval(client.heartbeat);
      delete client.heartbeat;
    }
    this.#clients.delete(client);
    if (!client.response.destroyed) {
      client.response.destroy();
    }
  }
}
