import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createFrickErrorEnvelope, foundationSchema, type FrickErrorCode } from "@frick/protocol";
import {
  AuthenticationError,
  AuthorizationError,
  SessionExpiredError,
  assertBlobOwnership,
  assertCanAppend,
  assertCanReadInbox,
  assertCanSubscribe,
  type Principal,
} from "./authz.js";
import {
  createFrickExtensionRegistry,
  type FrickExtensionRegistryInput,
} from "./extensions.js";
import { SyncGateway } from "./sync/gateway.js";
import { SseRegistry } from "./sync/sse.js";
import type { StoredAccount } from "./storage/account-store.js";
import type { StoredSession } from "./storage/session-store.js";
import { FrickStore } from "./store.js";
import { loadFrickConfig, type FrickConfig, type FrickConfigOverrides } from "./config.js";

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  sseHeartbeatMs?: number;
  extensions?: FrickExtensionRegistryInput;
  /**
   * Runtime config. Either a fully-resolved {@link FrickConfig} or a partial
   * override object — when partial, missing fields are filled in via
   * {@link loadFrickConfig}. Omit to load entirely from env vars.
   */
  config?: FrickConfig | FrickConfigOverrides;
}

export function createFrickServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 4099);
  const config = resolveConfig(options.config);
  const store = new FrickStore({
    path: options.dbPath ?? process.env.FRICK_DB_PATH ?? defaultDatabasePath(),
    schema: foundationSchema,
  });
  const extensions = createFrickExtensionRegistry(options.extensions);

  const server = http.createServer((request, response) => {
    void handleHttp(request, response);
  });
  const wss = new WebSocketServer({ server, path: "/_frick/sync" });
  const sse = new SseRegistry(
    store.schema,
    options.sseHeartbeatMs === undefined ? {} : { heartbeatMs: options.sseHeartbeatMs },
  );
  const gateway = new SyncGateway(wss, store, {
    onStreamEvent: (event) => sse.publishStreamEvent(event),
  });
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

    if (request.method === "POST" && url.pathname === "/auth/signup") {
      try {
        const body = await readJsonBody(request);
        const displayName = normalizeDisplayName(requireString(body.displayName, "displayName"));
        const handle = normalizeHandle(requireString(body.handle, "handle"));
        const password = normalizePassword(requireString(body.password, "password"));
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const account = store.createAccountUser({
          userId: userIdFromHandle(handle),
          handle,
          displayName,
          password,
        });
        const session = createSessionForUser(store, account.userId, deviceId, replicaId, platform, config);

        sendJson(response, 201, authSessionResponse(store, session, account));
      } catch (error) {
        sendError(response, error, "signup_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/login") {
      try {
        const body = await readJsonBody(request);
        const identity = requireString(body.identity, "identity").trim();
        const password = requireString(body.password, "password");
        const account = store.verifyAccountPassword(identity, password);
        if (!account) {
          throw new AuthenticationError("Invalid handle or password");
        }
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const session = createSessionForUser(store, account.userId, deviceId, replicaId, platform, config);

        sendJson(response, 200, authSessionResponse(store, session, account));
      } catch (error) {
        sendError(response, error, "login_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/dev-login") {
      if (!config.demoAuthEnabled) {
        sendError(
          response,
          new AuthorizationError({
            allow: false,
            reason: "notAuthorizedForResource",
            publicMessage: "Demo authentication is disabled in this environment",
          }),
          "dev_login_disabled",
        );
        return;
      }
      try {
        const body = await readJsonBody(request);
        const userId = requireString(body.userId, "userId");
        if (!store.hasUser(userId)) {
          throw new Error(`Unknown user ${userId}`);
        }
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const session = createSessionForUser(store, userId, deviceId, replicaId, platform, config);

        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          sessionToken: session.sessionToken,
          userId: session.userId,
          deviceId: session.deviceId,
          replicaId: session.replicaId,
          expiresAt: session.expiresAt,
        });
      } catch (error) {
        sendError(response, error, "dev_login_rejected");
      }
      return;
    }

    const principal = protectedHttpPrincipal(request, url, store);
    if (principal instanceof Error) {
      sendError(response, principal, "unauthorized");
      return;
    }

    if (request.method === "POST" && url.pathname === "/conversations") {
      try {
        const body = await readJsonBody(request);
        const kind = parseConversationKind(typeof body.kind === "string" ? body.kind : "group");
        const title =
          typeof body.title === "string" && body.title.trim().length > 0
            ? normalizeConversationTitle(body.title)
            : undefined;
        if (!title && kind !== "dm") {
          throw new Error("title must be a non-empty string");
        }
        const participantUserIds = parseParticipantUserIds(body.participantUserIds);
        const conversationId = createConversationId(store, title ?? kind);
        const created = store.createConversation({
          conversationId,
          ...(title !== undefined ? { title } : {}),
          kind,
          createdBy: principal.userId,
          participantUserIds,
        });
        gateway.publishObjects("Conversation", [created.conversation]);
        gateway.publishObjects("RoomMember", created.members);
        sendJson(response, 201, {
          schemaHash: store.schema.hash,
          conversation: created.conversation,
          member: created.member,
          members: created.members,
        });
      } catch (error) {
        sendError(response, error, "conversation_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/objects") {
      const type = url.searchParams.get("type") ?? "Conversation";
      sendJson(response, 200, {
        schemaHash: store.schema.hash,
        type,
        data: store.listObjectsForUser(type, principal.userId),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/inbox") {
      const userId = url.searchParams.get("userId") ?? principal.userId;
      try {
        assertCanReadInbox(principal, userId, store);
        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          userId,
          data: store.listInbox(userId),
        });
      } catch (error) {
        sendError(response, error, "inbox_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/blobs") {
      sendJson(response, 200, {
        schemaHash: store.schema.hash,
        data: store.listBlobMetadata(url.searchParams.get("ownerId") ?? undefined),
      });
      return;
    }

    const blobContentId = parseBlobContentPath(url);
    if (blobContentId && request.method === "PUT") {
      try {
        const content = await readRawBody(request);
        const metadata = store.readBlobMetadata(blobContentId);
        const contentHash = sha256ContentHash(content);
        let responseStatus = 200;
        let responseContentHash = metadata?.contentHash ?? contentHash;

        if (metadata) {
          assertBlobOwnership(principal, metadata.ownerId);
          validateBlobContent(blobContentId, metadata.byteLength, metadata.contentHash, content, contentHash);
        } else {
          responseStatus = 201;
          const ownerId = requireString(
            url.searchParams.get("ownerId") ?? headerValue(request, "x-frick-owner-id"),
            "ownerId",
          );
          assertBlobOwnership(principal, ownerId);
          const createdMetadata = {
            blobId: blobContentId,
            ownerId,
            contentHash,
            byteLength: content.byteLength,
            mimeType: inferMimeType(request),
            createdAt: new Date().toISOString(),
          };
          store.createBlobMetadata(createdMetadata);
          responseContentHash = createdMetadata.contentHash;
        }

        store.writeBlobContent(blobContentId, content);
        sendJson(response, responseStatus, {
          ok: true,
          blobId: blobContentId,
          byteLength: content.byteLength,
          contentHash: responseContentHash,
        });
      } catch (error) {
        sendError(response, error, "blob_content_rejected");
      }
      return;
    }

    if (blobContentId && request.method === "GET") {
      const metadata = store.readBlobMetadata(blobContentId);
      const content = store.readBlobContent(blobContentId);
      if (!metadata || !content) {
        sendJson(response, 404, { error: "blob_content_not_found" });
        return;
      }

      response.writeHead(200, {
        "content-type": metadata.mimeType,
        "content-length": content.byteLength,
        "x-frick-blob-id": metadata.blobId,
        "x-frick-content-hash": metadata.contentHash,
      });
      response.end(Buffer.from(content));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/blobs/")) {
      const blobId = decodeURIComponent(url.pathname.slice("/blobs/".length));
      const metadata = blobId ? store.readBlobMetadata(blobId) : undefined;
      if (!metadata) {
        sendJson(response, 404, { error: "blob_not_found" });
        return;
      }
      sendJson(response, 200, metadata);
      return;
    }

    if (request.method === "POST" && url.pathname === "/blobs") {
      try {
        const body = await readJsonBody(request);
        const ownerId = requireString(body.ownerId, "ownerId");
        assertBlobOwnership(principal, ownerId);
        store.createBlobMetadata({
          blobId: requireString(body.blobId, "blobId"),
          ownerId,
          contentHash: requireString(body.contentHash, "contentHash"),
          byteLength: requireNumber(body.byteLength, "byteLength"),
          mimeType: requireString(body.mimeType, "mimeType"),
          ...(typeof body.storageKey === "string" ? { storageKey: body.storageKey } : {}),
        });
        sendJson(response, 201, { ok: true, blobId: body.blobId });
      } catch (error) {
        sendError(response, error, "blob_rejected");
      }
      return;
    }

    const signalRoute = parseSignalPath(url);
    if (signalRoute && request.method === "POST") {
      try {
        const value = await readJsonBody(request);
        store.enqueueSignal(signalRoute.name, signalRoute.key, value);
        gateway.publishSignal(signalRoute.name, signalRoute.key, value);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendError(response, error, "signal_rejected");
      }
      return;
    }

    if (signalRoute && request.method === "GET") {
      try {
        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          name: signalRoute.name,
          key: signalRoute.key,
          data: store.drainSignals(signalRoute.name, signalRoute.key),
        });
      } catch (error) {
        sendError(response, error, "signal_rejected");
      }
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
      try {
        assertCanSubscribe(principal, "stream", stream, key, store);
        const after = Number(url.searchParams.get("after") ?? "0");
        const events = store.readEvents(stream, key, Number.isFinite(after) ? after : 0);
        if (parts[4] === "events") {
          sse.open(response, {
            stream,
            key,
            events,
            cursor: Number.isFinite(after) ? after : 0,
          });
          return;
        }
        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          stream,
          key,
          data: events,
        });
      } catch (error) {
        sendError(response, error, "stream_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/append") {
      try {
        const body = await readJsonBody(request);
        const stream = requireString(body.stream, "stream");
        const key = requireString(body.key, "key");
        const event = requireString(body.event, "event");
        const payload = requireRecord(body.payload, "payload");
        assertCanAppend(principal, stream, key, store, event, payload);
        const result = store.appendEvent({
          requestId: requireString(body.requestId, "requestId"),
          replicaId: principal.replicaId,
          stream,
          streamId: key,
          event,
          payload,
        });
        if (result.created) {
          gateway.publishStreamEvent(result.event);
          sse.publishStreamEvent(result.event);
        }
        sendJson(response, 200, { ok: true, event: result.event });
      } catch (error) {
        sendError(response, error, "append_rejected");
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
    sse.closeAll();
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

  return { port, server, store, extensions, config, listen, close };
}

function resolveConfig(input: FrickConfig | FrickConfigOverrides | undefined): FrickConfig {
  if (!input) {
    return loadFrickConfig();
  }
  if (isFrickConfig(input)) {
    return input;
  }
  return loadFrickConfig(input);
}

function isFrickConfig(value: FrickConfig | FrickConfigOverrides): value is FrickConfig {
  return (
    typeof (value as FrickConfig).env === "string" &&
    typeof (value as FrickConfig).demoAuthEnabled === "boolean" &&
    typeof (value as FrickConfig).sessionTtlSeconds === "number"
  );
}

export function defaultDatabasePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/frick.sqlite");
}

function setCors(response: http.ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-frick-owner-id, x-frick-session-token");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  response.setHeader("Access-Control-Expose-Headers", "x-frick-schema-hash, x-frick-blob-id, x-frick-content-hash");
  response.setHeader("X-Frick-Schema-Hash", foundationSchema.hash);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendError(response: http.ServerResponse, error: unknown, requestId: string): void {
  const status = error instanceof AuthenticationError ? 401 : error instanceof AuthorizationError ? 403 : 400;
  const details: Record<string, unknown> = { routeCode: requestId };
  if (
    (error instanceof AuthenticationError || error instanceof AuthorizationError) &&
    error.decision &&
    !error.decision.allow
  ) {
    details.reason = error.decision.reason;
  }
  const envelope = createFrickErrorEnvelope({
    code: httpErrorCode(error),
    message: error instanceof Error ? error.message : "Unknown request error",
    requestId,
    retryable: false,
    details,
    schemaHash: foundationSchema.hash,
    schemaRevision: foundationSchema.schemaRevision,
  });
  sendJson(response, status, {
    error: envelope,
    code: envelope.code,
    message: envelope.message,
    requestId: envelope.requestId,
    retryable: envelope.retryable,
  });
}

function httpErrorCode(error: unknown): FrickErrorCode {
  if (error instanceof SessionExpiredError) {
    return "auth.sessionExpired";
  }
  if (error instanceof AuthenticationError) {
    return "auth.unauthenticated";
  }
  if (error instanceof AuthorizationError) {
    return "auth.forbidden";
  }
  return "sync.protocolError";
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

async function readRawBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function parseBlobContentPath(url: URL): string | undefined {
  const match = /^\/blobs\/([^/]+)\/content$/.exec(url.pathname);
  const encodedBlobId = match?.[1];
  return encodedBlobId ? decodeURIComponent(encodedBlobId) : undefined;
}

function parseSignalPath(url: URL): { name: string; key: string } | undefined {
  const match = /^\/signals\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const encodedName = match?.[1];
  const encodedKey = match?.[2];
  return encodedName && encodedKey
    ? { name: decodeURIComponent(encodedName), key: decodeURIComponent(encodedKey) }
    : undefined;
}

function sha256ContentHash(content: Uint8Array): string {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

function validateBlobContent(
  blobId: string,
  expectedByteLength: number,
  expectedContentHash: string,
  content: Uint8Array,
  actualContentHash: string,
): void {
  if (content.byteLength !== expectedByteLength) {
    throw new Error(`blob ${blobId} byteLength mismatch: expected ${expectedByteLength}, got ${content.byteLength}`);
  }
  if (expectedContentHash.startsWith("sha256-") && expectedContentHash !== actualContentHash) {
    throw new Error(`blob ${blobId} contentHash mismatch: expected ${expectedContentHash}, got ${actualContentHash}`);
  }
}

function inferMimeType(request: http.IncomingMessage): string {
  return headerValue(request, "content-type")?.split(";")[0]?.trim() || "application/octet-stream";
}

function headerValue(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function protectedHttpPrincipal(request: http.IncomingMessage, url: URL, store: FrickStore): Principal | AuthenticationError {
  if (!isProtectedPath(url.pathname)) {
    return {
      userId: "public",
      deviceId: "public",
      replicaId: "public",
    };
  }

  const token = sessionTokenFromRequest(request, url);
  if (!token) {
    return new AuthenticationError("Missing session token");
  }

  const session = store.readActiveSession(token);
  if (!session) {
    const stale = store.readAnySession(token);
    if (stale && Date.parse(stale.expiresAt) <= Date.now()) {
      return new SessionExpiredError();
    }
    return new AuthenticationError("Invalid or expired session token");
  }

  return {
    userId: session.userId,
    deviceId: session.deviceId,
    replicaId: session.replicaId,
  };
}

function sessionTokenFromRequest(request: http.IncomingMessage, url: URL): string | undefined {
  const auth = headerValue(request, "authorization");
  const bearer = /^Bearer\s+(.+)$/i.exec(auth ?? "")?.[1];
  return bearer ?? headerValue(request, "x-frick-session-token") ?? url.searchParams.get("sessionToken") ?? undefined;
}

function isProtectedPath(pathname: string): boolean {
  return (
    pathname === "/objects" ||
    pathname === "/inbox" ||
    pathname === "/conversations" ||
    pathname === "/blobs" ||
    pathname.startsWith("/blobs/") ||
    pathname === "/signals" ||
    pathname.startsWith("/signals/") ||
    pathname === "/streams" ||
    pathname.startsWith("/streams/") ||
    pathname === "/append"
  );
}

function parsePlatform(platform: string): "web" | "ios" | "android" | "server" {
  if (platform === "web" || platform === "ios" || platform === "android" || platform === "server") {
    return platform;
  }
  throw new Error("platform must be one of web, ios, android, server");
}

function createSessionForUser(
  store: FrickStore,
  userId: string,
  deviceId: string,
  replicaId: string,
  platform: "web" | "ios" | "android" | "server",
  config: FrickConfig,
): StoredSession {
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
  const sessionToken = randomToken(32);
  store.recordUserDevice(deviceId, userId, platform);
  return store.createSession({ sessionToken, userId, deviceId, replicaId, expiresAt });
}

function authSessionResponse(store: FrickStore, session: StoredSession, account: StoredAccount): Record<string, unknown> {
  return {
    schemaHash: store.schema.hash,
    sessionToken: session.sessionToken,
    userId: session.userId,
    displayName: account.displayName,
    handle: account.handle,
    deviceId: session.deviceId,
    replicaId: session.replicaId,
    expiresAt: session.expiresAt,
  };
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim().replace(/\s+/g, " ");
  if (displayName.length < 2 || displayName.length > 80) {
    throw new Error("displayName must be between 2 and 80 characters");
  }
  return displayName;
}

function normalizeHandle(value: string): string {
  const handle = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/.test(handle)) {
    throw new Error("handle must be 3-32 lowercase letters, numbers, underscores, or dashes");
  }
  return handle;
}

function normalizePassword(value: string): string {
  if (value.length < 8 || value.length > 256) {
    throw new Error("password must be between 8 and 256 characters");
  }
  return value;
}

function normalizeConversationTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, " ");
  if (title.length < 1 || title.length > 80) {
    throw new Error("title must be between 1 and 80 characters");
  }
  return title;
}

function userIdFromHandle(handle: string): string {
  return `user-${handle.replace(/_/g, "-")}`;
}

function parseConversationKind(value: string): "dm" | "group" | "channel" {
  if (value === "dm" || value === "group" || value === "channel") {
    return value;
  }
  throw new Error("kind must be one of dm, group, channel");
}

function parseParticipantUserIds(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("participantUserIds must be an array");
  }
  return Array.from(
    new Set(
      value.map((item, index) => {
        const userId = requireString(item, `participantUserIds[${index}]`).trim();
        if (!/^user-[a-z0-9][a-z0-9_-]*$/i.test(userId)) {
          throw new Error(`participantUserIds[${index}] must be a user id`);
        }
        return userId;
      }),
    ),
  );
}

function createConversationId(store: FrickStore, seed: string): string {
  const slug = slugFromTitle(seed);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const conversationId = `conversation-${slug}-${randomBytes(3).toString("hex")}`;
    if (!store.readObject("Conversation", conversationId)) {
      return conversationId;
    }
  }
  throw new Error("Could not allocate a unique conversation id");
}

function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "thread";
}

function randomToken(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}
