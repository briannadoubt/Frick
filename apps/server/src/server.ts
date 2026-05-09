import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { foundationSchema } from "@frick/protocol";
import { SyncGateway } from "./sync/gateway.js";
import { FrickStore } from "./store.js";

export interface ServerOptions {
  port?: number;
  dbPath?: string;
}

export function createFrickServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 4099);
  const store = new FrickStore({
    path: options.dbPath ?? process.env.FRICK_DB_PATH ?? defaultDatabasePath(),
    schema: foundationSchema,
  });

  const server = http.createServer((request, response) => {
    void handleHttp(request, response);
  });
  const wss = new WebSocketServer({ server, path: "/_frick/sync" });
  const gateway = new SyncGateway(wss, store);
  gateway.attach();

  async function handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    setCors(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "frick-server" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/schema") {
      sendJson(response, 200, store.schema);
      return;
    }

    if (request.method === "GET" && url.pathname === "/objects") {
      const type = url.searchParams.get("type") ?? "Conversation";
      sendJson(response, 200, {
        schemaHash: store.schema.hash,
        type,
        data: store.listObjects(type),
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/streams/")) {
      const parts = url.pathname.split("/").map(decodeURIComponent);
      const stream = parts[2];
      const key = parts[3];
      if (!stream || !key) {
        sendJson(response, 400, { error: "stream_and_key_required" });
        return;
      }
      const after = Number(url.searchParams.get("after") ?? "0");
      sendJson(response, 200, {
        schemaHash: store.schema.hash,
        stream,
        key,
        data: store.readEvents(stream, key, Number.isFinite(after) ? after : 0),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/append") {
      try {
        const body = await readJsonBody(request);
        const event = store.appendEvent({
          requestId: requireString(body.requestId, "requestId"),
          replicaId: requireString(body.replicaId, "replicaId"),
          stream: requireString(body.stream, "stream"),
          streamId: requireString(body.key, "key"),
          event: requireString(body.event, "event"),
          payload: requireRecord(body.payload, "payload"),
        });
        sendJson(response, 200, { ok: true, event });
      } catch (error) {
        sendJson(response, 400, {
          error: "append_rejected",
          message: error instanceof Error ? error.message : "Unknown append error",
        });
      }
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  }

  function listen(): Promise<void> {
    return new Promise((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });
  }

  function close(): Promise<void> {
    gateway.close();
    return new Promise((resolve, reject) => {
      wss.close((wsError) => {
        store.close();
        server.close((serverError) => {
          const error = wsError ?? serverError;
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    });
  }

  return { port, server, store, listen, close };
}

export function defaultDatabasePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/frick.sqlite");
}

function setCors(response: http.ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Expose-Headers", "x-frick-schema-hash");
  response.setHeader("X-Frick-Schema-Hash", foundationSchema.hash);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return requireRecord(parsed, "body");
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}
