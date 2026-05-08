import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  FrameKind,
  decodeFrame,
  demoManifest,
  encodeFrame,
  type FrickFrame,
  type ObjectDelta,
  type QuerySpec,
} from "@frick/protocol";
import { FrickStore } from "./store.js";

export interface ServerOptions {
  port?: number;
  dbPath?: string;
}

interface ClientState {
  socket: WebSocket;
  subscriptions: Map<string, QuerySpec>;
}

export function createFrickServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 4099);
  const store = new FrickStore({
    path: options.dbPath ?? process.env.FRICK_DB_PATH ?? "apps/server/data/frick.sqlite",
    manifest: demoManifest,
  });
  const clients = new Set<ClientState>();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");

    if (url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "frick-server" });
      return;
    }

    if (url.pathname === "/manifest") {
      sendJson(response, 200, store.manifest);
      return;
    }

    if (url.pathname === "/objects") {
      const entity = url.searchParams.get("entity") ?? "Task";
      const index = url.searchParams.get("index") ?? (entity === "Project" ? "all" : "byProject");
      const projectId = url.searchParams.get("projectId") ?? "demo-project";
      sendJson(response, 200, {
        entity,
        index,
        data: store.query({ entity, index, args: { projectId, tenantId: "demo-tenant" } }),
      });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });

  const wss = new WebSocketServer({ server, path: "/_frick/sync" });
  wss.on("connection", (socket) => {
    const client: ClientState = { socket, subscriptions: new Map() };
    clients.add(client);
    console.log("sync client connected");
    send(socket, [FrameKind.Manifest, store.manifest]);

    socket.on("message", (payload) => {
      try {
        const frame = decodeFrame(payload as Buffer);
        console.log("sync frame", FrameKind[frame[0]]);
        handleFrame(client, frame);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown server error";
        send(socket, [FrameKind.Reject, "unknown", message]);
      }
    });
    socket.on("close", () => clients.delete(client));
  });

  function handleFrame(client: ClientState, frame: FrickFrame): void {
    switch (frame[0]) {
      case FrameKind.Hello:
        send(client.socket, [
          FrameKind.SyncStatus,
          { connected: true, lastSeq: frame[1].knownSeq },
        ]);
        return;
      case FrameKind.Subscribe:
        client.subscriptions.set(frame[1], frame[2]);
        send(client.socket, [FrameKind.Snapshot, frame[1], store.queryPacked(frame[2])]);
        return;
      case FrameKind.Mutate: {
        const request = frame[1];
        const delta = store.applyMutation(request.name, request.input);
        send(client.socket, [FrameKind.Ack, request.requestId, delta]);
        broadcastDelta(delta, client);
        refreshSnapshots(delta);
        return;
      }
      default:
        return;
    }
  }

  function broadcastDelta(delta: ObjectDelta, except?: ClientState): void {
    for (const client of clients) {
      if (client !== except) {
        send(client.socket, [FrameKind.Delta, delta]);
      }
    }
  }

  function refreshSnapshots(_delta: ObjectDelta): void {
    for (const client of clients) {
      for (const [queryId, spec] of client.subscriptions) {
        send(client.socket, [FrameKind.Snapshot, queryId, store.queryPacked(spec)]);
      }
    }
  }

  function listen(): Promise<void> {
    return new Promise((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });
  }

  function close(): Promise<void> {
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

function send(socket: WebSocket, frame: FrickFrame): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(encodeFrame(frame));
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
