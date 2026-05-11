import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { createFrickErrorEnvelope, foundationSchema, type FrickErrorCode } from "@frick/protocol";
import {
  AuthenticationError,
  AuthorizationError,
  SessionExpiredError,
  assertBlobOwnership,
  assertCanAppend,
  assertCanReadBlob,
  assertCanReadInbox,
  assertCanSignal,
  assertCanSubscribe,
  tenantMembershipReader,
  type FrickPolicyHook,
  type Principal,
} from "./authz.js";
import {
  DEFAULT_TENANT_ID,
  TenantIdValidationError,
  normalizeTenantId,
  validateTenantId,
} from "./tenant.js";
import {
  createFrickExtensionRegistry,
  type FrickExtensionRegistryInput,
} from "./extensions.js";
import { SyncGateway } from "./sync/gateway.js";
import { SseRegistry } from "./sync/sse.js";
import type { StoredAccount } from "./storage/account-store.js";
import type { StoredSession } from "./storage/session-store.js";
import { TenantAlreadyExistsError } from "./storage/tenant-store.js";
import { FrickStore } from "./store.js";
import { loadFrickConfig, type FrickConfig, type FrickConfigOverrides } from "./config.js";
import { createConsoleLogger, createNoopLogger, type FrickLogger } from "./logger.js";
import { FrickLimitError, mergeLimits, type FrickLimits } from "./limits.js";

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
  /**
   * Logger to use for startup and shutdown events. Defaults to a no-op
   * logger in tests (when `config.env === "test"`) and a structured console
   * logger otherwise.
   */
  logger?: FrickLogger;
  /**
   * Maximum time `close()` waits for in-flight HTTP handlers to settle
   * before forcibly closing the underlying socket. Defaults to 5 seconds.
   */
  shutdownTimeoutMs?: number;
  /**
   * Optional ordered list of policy hooks. Each hook runs AFTER the
   * framework's default decision and can tighten — but not loosen — the
   * outcome. See {@link FrickPolicyHook}.
   */
  policyHooks?: readonly FrickPolicyHook[];
  /**
   * Bounded runtime limits. Partial — missing fields fall back to
   * {@link DEFAULT_FRICK_LIMITS}.
   */
  limits?: Partial<FrickLimits>;
  /**
   * Capacity of the in-process LRU front cache for idempotency lookups.
   * Defaults to 10,000. Tune lower for quiet single-tenant deployments,
   * higher for noisy ones. See `docs/operations.md`.
   */
  idempotencyCacheCapacity?: number;
}

export function createFrickServer(options: ServerOptions = {}) {
  const config = resolveConfig(options.config);
  const port = options.port ?? Number(process.env.PORT ?? config.port);
  const host = config.host;
  const startedAt = new Date().toISOString();
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
  const inTestRunner =
    config.env === "test" ||
    process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined;
  const logger =
    options.logger ?? (inTestRunner ? createNoopLogger() : createConsoleLogger(config));
  const limits = mergeLimits(options.limits);
  const store = new FrickStore({
    path: options.dbPath ?? process.env.FRICK_DB_PATH ?? defaultDatabasePath(),
    schema: foundationSchema,
    ...(options.idempotencyCacheCapacity !== undefined
      ? { idempotencyCacheCapacity: options.idempotencyCacheCapacity }
      : {}),
  });
  const extensions = createFrickExtensionRegistry(options.extensions);
  const policyHooks: readonly FrickPolicyHook[] = options.policyHooks ?? [];
  let inFlight = 0;
  let closing = false;

  function noteRequestStart(): void {
    inFlight += 1;
  }
  function noteRequestEnd(): void {
    inFlight = Math.max(0, inFlight - 1);
  }
  // `closing` and `inFlight` are surfaced on the returned object for tests
  // and operators that want to observe drain state without instrumenting
  // the HTTP server directly.

  const server = http.createServer((request, response) => {
    noteRequestStart();
    response.on("close", noteRequestEnd);
    void handleHttp(request, response);
  });
  const wss = new WebSocketServer({
    server,
    path: "/_frick/sync",
    verifyClient: (info, callback) => {
      const origin = typeof info.origin === "string" && info.origin.length > 0 ? info.origin : undefined;
      if (isOriginAllowed(origin, config.allowedOrigins)) {
        callback(true);
        return;
      }
      callback(false, 403, "origin not allowed");
    },
  });
  const sse = new SseRegistry(
    store.schema,
    options.sseHeartbeatMs === undefined ? {} : { heartbeatMs: options.sseHeartbeatMs },
  );
  const gateway = new SyncGateway(wss, store, {
    onStreamEvent: (event) => sse.publishStreamEvent(event),
    limits,
    policyHooks,
  });
  gateway.attach();

  async function handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const requestOrigin = headerValue(request, "origin");
    const originAllowed = isOriginAllowed(requestOrigin, config.allowedOrigins);
    setCors(response, requestOrigin, config.allowedOrigins, originAllowed);

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        sendError(
          response,
          new CorsOriginRejectedError("Origin not allowed by CORS policy"),
          "cors_rejected",
        );
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "frick-server", status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/ready") {
      const applied = safeListAppliedMigrations(store);
      const dbReady = store.pingDatabase();
      const migrationsReady = applied !== undefined;
      if (!dbReady || !migrationsReady) {
        sendJson(response, 503, {
          status: "not-ready",
          reason: !dbReady ? "database_unresponsive" : "migrations_unavailable",
          schemaId: store.schema.schemaId,
          schemaRevision: store.schema.schemaRevision,
          schemaHash: store.schema.hash,
          appliedMigrations: applied?.length ?? 0,
        });
        return;
      }
      sendJson(response, 200, {
        status: "ready",
        schemaId: store.schema.schemaId,
        schemaRevision: store.schema.schemaRevision,
        schemaHash: store.schema.hash,
        appliedMigrations: applied.length,
      });
      return;
    }

    if (config.inspectionEnabled && request.method === "GET" && url.pathname.startsWith("/_frick/inspect/")) {
      const sub = url.pathname.slice("/_frick/inspect/".length);
      if (sub === "server") {
        sendJson(response, 200, {
          schemaId: store.schema.schemaId,
          schemaVersion: store.schema.schemaVersion,
          schemaRevision: store.schema.schemaRevision,
          schemaHash: store.schema.hash,
          env: config.env,
          demoAuthEnabled: config.demoAuthEnabled,
          inspectionEnabled: config.inspectionEnabled,
          startedAt,
        });
        return;
      }
      if (sub === "migrations") {
        const applied = safeListAppliedMigrations(store) ?? [];
        sendJson(response, 200, {
          applied: applied.map((row) => ({
            id: row.id,
            schemaRevision: row.schemaRevision,
            appliedAt: row.appliedAt,
            checksum: row.checksum,
            durationMs: row.durationMs,
          })),
        });
        return;
      }
      if (sub === "db") {
        const applied = safeListAppliedMigrations(store) ?? [];
        const last = applied[applied.length - 1];
        sendJson(response, 200, {
          ready: store.pingDatabase(),
          applied: applied.length,
          ...(last
            ? {
                lastApplied: {
                  id: last.id,
                  schemaRevision: last.schemaRevision,
                  appliedAt: last.appliedAt,
                },
              }
            : {}),
          idempotencyCache: {
            size: store.idempotencyCache.size,
            capacity: store.idempotencyCache.capacity,
            evictions: store.idempotencyCache.evictions,
          },
        });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    if (url.pathname.startsWith("/_frick/admin/")) {
      if (!config.adminEnabled) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const adminPrincipal = adminPrincipalFromRequest(request, url, config);
      if (!adminPrincipal) {
        // Token is wrong or missing. Distinguish between "no auth at all" and
        // "auth but not admin": when a request supplies a valid session token
        // but for a tenant-scoped principal, this is `auth.forbidden` (403);
        // otherwise it's `auth.unauthenticated` (401).
        const token = sessionTokenFromRequest(request, url);
        if (!token) {
          sendError(response, new AuthenticationError("Missing admin token"), "admin_unauthorized");
          return;
        }
        const session = store.readActiveSession(token);
        if (session) {
          sendError(
            response,
            new AuthorizationError({
              allow: false,
              reason: "notAuthorizedForResource",
              publicMessage: "Admin scope required",
            }),
            "admin_forbidden",
          );
          return;
        }
        sendError(response, new AuthenticationError("Invalid admin token"), "admin_unauthorized");
        return;
      }
      try {
        await handleAdminRoute(request, response, url, store, limits.maxHttpBodyBytes);
      } catch (error) {
        sendError(response, error, "admin_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/schema") {
      sendJson(response, 200, store.schema);
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/signup") {
      try {
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const displayName = normalizeDisplayName(requireString(body.displayName, "displayName"));
        const handle = normalizeHandle(requireString(body.handle, "handle"));
        const password = normalizePassword(requireString(body.password, "password"));
        const tenantId = resolveAuthTenantId(body.tenantId);
        ensureTenantAllowed(store, config, tenantId);
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const account = store.createAccountUser({
          userId: userIdFromHandle(tenantId, handle),
          handle,
          displayName,
          password,
          tenantId,
        });
        const session = createSessionForUser(store, account.userId, deviceId, replicaId, platform, config, tenantId);

        sendJson(response, 201, authSessionResponse(store, session, account));
      } catch (error) {
        sendError(response, error, "signup_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/login") {
      try {
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const identity = requireString(body.identity, "identity").trim();
        const password = requireString(body.password, "password");
        const tenantId = resolveAuthTenantId(body.tenantId);
        ensureTenantAllowed(store, config, tenantId);
        const account = store.verifyAccountPassword(tenantId, identity, password);
        if (!account) {
          throw new AuthenticationError("Invalid handle or password");
        }
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const session = createSessionForUser(store, account.userId, deviceId, replicaId, platform, config, tenantId);

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
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const userId = requireString(body.userId, "userId");
        const tenantId = resolveAuthTenantId(body.tenantId);
        ensureTenantAllowed(store, config, tenantId);
        // Dev-login: in the default tenant, seed users (user-ada, user-grace)
        // exist; on first dev-login in any other tenant, create the user
        // object on the fly so explicit-tenant tests don't need a separate
        // signup round-trip. This auto-create branch is a development
        // convenience and is gated on `config.demoAuthEnabled` — production
        // deployments require an explicit `/auth/signup` first.
        if (!store.hasUser(tenantId, userId)) {
          if (!config.demoAuthEnabled || tenantId === DEFAULT_TENANT_ID) {
            throw new AccountNotFoundError("Account not found");
          }
          store.upsertObject(tenantId, "User", userId, {
            displayName: userId,
            avatarBlobId: undefined,
          });
          logger.info("frick.auth.dev_login_auto_create", {
            event: "frick.auth.dev_login_auto_create",
            tenantId,
            userId,
          });
        }
        const platform = parsePlatform(typeof body.platform === "string" ? body.platform : "web");
        const deviceId = typeof body.deviceId === "string" && body.deviceId.length > 0 ? body.deviceId : `device-${randomToken(12)}`;
        const replicaId = typeof body.replicaId === "string" && body.replicaId.length > 0 ? body.replicaId : `replica-${randomToken(12)}`;
        const session = createSessionForUser(store, userId, deviceId, replicaId, platform, config, tenantId);

        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          sessionToken: session.sessionToken,
          tenantId: session.tenantId,
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

    const principal = protectedHttpPrincipal(request, url, store, config);
    if (principal instanceof Error) {
      sendError(response, principal, "unauthorized");
      return;
    }

    if (request.method === "POST" && url.pathname === "/conversations") {
      try {
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const kind = parseConversationKind(typeof body.kind === "string" ? body.kind : "group");
        const title =
          typeof body.title === "string" && body.title.trim().length > 0
            ? normalizeConversationTitle(body.title)
            : undefined;
        if (!title && kind !== "dm") {
          throw new Error("title must be a non-empty string");
        }
        const participantUserIds = parseParticipantUserIds(body.participantUserIds);
        const conversationId = createConversationId(store, principal.tenantId, title ?? kind);
        const created = store.createConversation({
          conversationId,
          ...(title !== undefined ? { title } : {}),
          kind,
          createdBy: principal.userId,
          participantUserIds,
          tenantId: principal.tenantId,
        });
        gateway.publishObjects("Conversation", [created.conversation], principal.tenantId);
        gateway.publishObjects("RoomMember", created.members, principal.tenantId);
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
        data: store.listObjectsForUser(principal.tenantId, type, principal.userId),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/inbox") {
      const userId = url.searchParams.get("userId") ?? principal.userId;
      try {
        assertCanReadInbox(
          principal,
          userId,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
        );
        sendJson(response, 200, {
          schemaHash: store.schema.hash,
          userId,
          data: store.listInbox(principal.tenantId, userId),
        });
      } catch (error) {
        sendError(response, error, "inbox_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/blobs") {
      const ownerId = url.searchParams.get("ownerId") ?? undefined;
      sendJson(response, 200, {
        schemaHash: store.schema.hash,
        data: store.blobs.list(principal.tenantId, ownerId),
      });
      return;
    }

    const blobContentId = parseBlobContentPath(url);
    if (blobContentId && request.method === "PUT") {
      try {
        const content = await readRawBody(request, limits.maxBlobBytes, "maxBlobBytes");
        const metadata = store.blobs.read(principal.tenantId, blobContentId);
        const contentHash = sha256ContentHash(content);
        let responseStatus = 200;
        let responseContentHash = metadata?.contentHash ?? contentHash;

        if (metadata) {
          assertBlobOwnership(principal, metadata.ownerId, policyHooks);
          validateBlobContent(blobContentId, metadata.byteLength, metadata.contentHash, content, contentHash);
        } else {
          responseStatus = 201;
          const ownerId = requireString(
            url.searchParams.get("ownerId") ?? headerValue(request, "x-frick-owner-id"),
            "ownerId",
          );
          assertBlobOwnership(principal, ownerId, policyHooks);
          const createdMetadata = {
            blobId: blobContentId,
            ownerId,
            contentHash,
            byteLength: content.byteLength,
            mimeType: inferMimeType(request),
            createdAt: new Date().toISOString(),
          };
          store.blobs.create(principal.tenantId, createdMetadata);
          responseContentHash = createdMetadata.contentHash;
        }

        store.blobs.writeContent(principal.tenantId, blobContentId, content);
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
      try {
        const metadata = store.blobs.read(principal.tenantId, blobContentId);
        const content = store.blobs.readContent(principal.tenantId, blobContentId);
        if (!metadata || !content) {
          sendJson(response, 404, { error: "blob_content_not_found" });
          return;
        }
        assertCanReadBlob(principal, metadata.ownerId, policyHooks);

        response.writeHead(200, {
          "content-type": metadata.mimeType,
          "content-length": content.byteLength,
          "x-frick-blob-id": metadata.blobId,
          "x-frick-content-hash": metadata.contentHash,
        });
        response.end(Buffer.from(content));
      } catch (error) {
        sendError(response, error, "blob_content_rejected");
      }
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/blobs/")) {
      try {
        const blobId = decodeURIComponent(url.pathname.slice("/blobs/".length));
        const metadata = blobId ? store.blobs.read(principal.tenantId, blobId) : undefined;
        if (!metadata) {
          sendJson(response, 404, { error: "blob_not_found" });
          return;
        }
        assertCanReadBlob(principal, metadata.ownerId, policyHooks);
        sendJson(response, 200, metadata);
      } catch (error) {
        sendError(response, error, "blob_rejected");
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/blobs") {
      try {
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const ownerId = requireString(body.ownerId, "ownerId");
        assertBlobOwnership(principal, ownerId, policyHooks);
        store.blobs.create(principal.tenantId, {
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
        assertCanSignal(
          principal,
          signalRoute.name,
          signalRoute.key,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
        );
        const value = await readJsonBody(request, limits.maxHttpBodyBytes);
        store.enqueueSignal(principal.tenantId, signalRoute.name, signalRoute.key, value);
        gateway.publishSignal(signalRoute.name, signalRoute.key, value, principal.tenantId);
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
          data: store.drainSignals(principal.tenantId, signalRoute.name, signalRoute.key),
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
        assertCanSubscribe(
          principal,
          "stream",
          stream,
          key,
          tenantMembershipReader(store, principal.tenantId),
          policyHooks,
        );
        const after = Number(url.searchParams.get("after") ?? "0");
        const events = store.readEvents(principal.tenantId, stream, key, Number.isFinite(after) ? after : 0);
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
        const body = await readJsonBody(request, limits.maxHttpBodyBytes);
        const stream = requireString(body.stream, "stream");
        const key = requireString(body.key, "key");
        const event = requireString(body.event, "event");
        const payload = requireRecord(body.payload, "payload");
        assertPayloadWithinLimit(payload, limits.maxStreamAppendPayloadBytes);
        assertCanAppend(
          principal,
          stream,
          key,
          tenantMembershipReader(store, principal.tenantId),
          event,
          payload,
          policyHooks,
        );
        const result = store.appendEvent({
          tenantId: principal.tenantId,
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
      server.listen(port, host, () => {
        const address = server.address();
        const boundPort = address && typeof address !== "string" ? address.port : port;
        logger.info("frick.server.listen", {
          event: "frick.server.listen",
          schemaId: store.schema.schemaId,
          schemaRevision: store.schema.schemaRevision,
          schemaHash: store.schema.hash,
          env: config.env,
          host,
          port: boundPort,
          publicUrl: config.publicUrl,
          demoAuthEnabled: config.demoAuthEnabled,
          dbPath: options.dbPath ?? process.env.FRICK_DB_PATH ?? config.dbPath,
          inspectionEnabled: config.inspectionEnabled,
        });
        resolve();
      });
    });
  }

  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    sse.closeAll();
    gateway.close();
    closePromise = new Promise((resolve, reject) => {
      // Stop accepting new HTTP connections; allow in-flight requests to
      // drain. server.close()'s callback fires only once every connection
      // is idle, so this naturally waits for in-flight requests. We layer a
      // best-effort drain timer on top so a stuck request can't pin the
      // process forever.
      const drainTimer = setTimeout(() => {
        // After timeout, forcibly close any keep-alive sockets and let the
        // server.close callback resolve. server.closeAllConnections is
        // available on Node 18.2+.
        const maybeCloseAll = (server as unknown as { closeAllConnections?: () => void })
          .closeAllConnections;
        if (typeof maybeCloseAll === "function") maybeCloseAll();
      }, shutdownTimeoutMs);

      server.close((serverError) => {
        clearTimeout(drainTimer);
        wss.close((wsError) => {
          try {
            store.close();
          } catch {
            // Already closed — fine during shutdown.
          }
          logger.info("frick.server.closed", { event: "frick.server.closed" });
          const error = serverError ?? wsError;
          if (error && !/Server is not running|not running/i.test(error.message)) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    });
    return closePromise;
  }

  return { port, server, store, extensions, config, logger, startedAt, listen, close };
}

function safeListAppliedMigrations(store: FrickStore) {
  try {
    return store.listAppliedMigrations();
  } catch {
    return undefined;
  }
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
  const v = value as FrickConfig;
  return (
    typeof v.env === "string" &&
    typeof v.demoAuthEnabled === "boolean" &&
    typeof v.sessionTtlSeconds === "number" &&
    typeof v.host === "string" &&
    typeof v.port === "number" &&
    typeof v.dbPath === "string" &&
    typeof v.logLevel === "string"
  );
}

export function defaultDatabasePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/frick.sqlite");
}

/**
 * Decide whether a request's `Origin` header is permitted by the configured
 * allowlist. Same-origin / server-to-server requests omit `Origin` entirely
 * and are always allowed — browsers, not the server, enforce CORS for those.
 *
 * Matching is exact-string only. Pattern matching (regex, suffix, subdomain
 * wildcards) is out of scope; see `docs/threat-model.md` for the rationale.
 */
function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes("*")) return true;
  return allowedOrigins.includes(origin);
}

class CorsOriginRejectedError extends Error {
  readonly reason = "originNotAllowed";
  constructor(message: string) {
    super(message);
    this.name = "CorsOriginRejectedError";
  }
}

/**
 * Thrown by `/auth/dev-login` when demo-auth auto-create is disabled and
 * the (tenantId, userId) pair does not yet exist. Maps to 401 +
 * `auth.unauthenticated` with `details.reason = "accountNotFound"`.
 */
class AccountNotFoundError extends Error {
  readonly reason = "accountNotFound";
  constructor(message = "Account not found") {
    super(message);
    this.name = "AccountNotFoundError";
  }
}

/**
 * Validate body.tenantId at an auth boundary. Returns the normalized tenant
 * id. If the caller supplied a `tenantId` field at all (even empty string),
 * it must match {@link validateTenantId}'s strict regex; if omitted, the
 * default tenant is used.
 */
function resolveAuthTenantId(rawValue: unknown): string {
  if (rawValue === undefined || rawValue === null) {
    return DEFAULT_TENANT_ID;
  }
  if (typeof rawValue !== "string") {
    throw new TenantIdValidationError("tenantId must be a string");
  }
  validateTenantId(rawValue);
  return normalizeTenantId(rawValue);
}

function setCors(
  response: http.ServerResponse,
  requestOrigin: string | undefined,
  allowedOrigins: readonly string[],
  originAllowed: boolean,
): void {
  response.setHeader("X-Frick-Schema-Hash", foundationSchema.hash);
  if (!originAllowed) {
    // Browsers will block the response from reaching JS; the server still
    // serves the body, matching typical Express/Node CORS-middleware
    // semantics. Preflight requests are rejected outright at the caller.
    return;
  }
  if (allowedOrigins.includes("*") && (!requestOrigin || allowedOrigins.length === 1)) {
    response.setHeader("Access-Control-Allow-Origin", "*");
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    response.setHeader("Access-Control-Allow-Origin", requestOrigin);
    response.setHeader("Vary", "Origin");
  } else if (allowedOrigins.includes("*")) {
    response.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // Same-origin (no Origin header) and no wildcard: emit no
    // Access-Control-Allow-* headers — browsers wouldn't enforce anyway.
    return;
  }
  response.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, x-frick-owner-id, x-frick-session-token",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "x-frick-schema-hash, x-frick-blob-id, x-frick-content-hash",
  );
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendError(response: http.ServerResponse, error: unknown, requestId: string): void {
  const status =
    error instanceof FrickLimitError
      ? 413
      : error instanceof AccountNotFoundError
        ? 401
        : error instanceof AuthenticationError
          ? 401
          : error instanceof AuthorizationError
            ? 403
            : error instanceof CorsOriginRejectedError
              ? 403
              : 400;
  const details: Record<string, unknown> = { routeCode: requestId };
  if (
    (error instanceof AuthenticationError || error instanceof AuthorizationError) &&
    error.decision &&
    !error.decision.allow
  ) {
    details.reason = error.decision.reason;
  }
  if (error instanceof UnknownTenantError) {
    details.reason = "unknownTenant";
    if ((error as { tenantId?: string }).tenantId) {
      details.tenantId = (error as { tenantId?: string }).tenantId;
    }
  }
  if (error instanceof CorsOriginRejectedError) {
    details.reason = error.reason;
  }
  if (error instanceof AccountNotFoundError) {
    details.reason = error.reason;
  }
  if (error instanceof TenantIdValidationError) {
    details.reason = error.reason;
  }
  if (error instanceof FrickLimitError) {
    details.limit = error.limit;
    details.configuredMax = error.configuredMax;
    details.actualValue = error.actualValue;
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
  if (error instanceof AccountNotFoundError) {
    return "auth.unauthenticated";
  }
  if (error instanceof AuthenticationError) {
    return "auth.unauthenticated";
  }
  if (error instanceof AuthorizationError) {
    return "auth.forbidden";
  }
  if (error instanceof CorsOriginRejectedError) {
    return "auth.forbidden";
  }
  if (error instanceof FrickLimitError) {
    if (error.limit === "maxBlobBytes") {
      return "blob.tooLarge";
    }
    if (error.limit === "maxStreamAppendPayloadBytes") {
      return "stream.appendRejected";
    }
    return "rateLimit.exceeded";
  }
  return "sync.protocolError";
}

async function readJsonBody(
  request: http.IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const buffer = await readBoundedRawBody(request, maxBytes, "maxHttpBodyBytes");
  if (buffer.byteLength === 0) {
    return {};
  }
  const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
  return requireRecord(parsed, "body");
}

async function readRawBody(request: http.IncomingMessage, maxBytes: number, limit: "maxBlobBytes" | "maxHttpBodyBytes"): Promise<Buffer> {
  return readBoundedRawBody(request, maxBytes, limit);
}

async function readBoundedRawBody(
  request: http.IncomingMessage,
  maxBytes: number,
  limit: "maxHttpBodyBytes" | "maxBlobBytes",
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      // Stop consuming further chunks but don't tear down the socket — we
      // still need to write a 413 response.
      request.pause();
      throw new FrickLimitError({ limit, actualValue: total, configuredMax: maxBytes });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function assertPayloadWithinLimit(payload: Record<string, unknown>, maxBytes: number): void {
  const encoded = msgpackEncode(payload);
  if (encoded.byteLength > maxBytes) {
    throw new FrickLimitError({
      limit: "maxStreamAppendPayloadBytes",
      actualValue: encoded.byteLength,
      configuredMax: maxBytes,
    });
  }
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

function protectedHttpPrincipal(request: http.IncomingMessage, url: URL, store: FrickStore, config: FrickConfig): Principal | AuthenticationError {
  if (!isProtectedPath(url.pathname)) {
    return {
      userId: "public",
      deviceId: "public",
      replicaId: "public",
      tenantId: DEFAULT_TENANT_ID,
    };
  }

  const token = sessionTokenFromRequest(request, url);
  if (!token) {
    return new AuthenticationError("Missing session token");
  }

  // Admin bearer takes precedence over session lookup so a configured admin
  // token can act on any path. Constant-time equality is unnecessary here:
  // the token is operator-supplied at boot and used over TLS in production.
  if (config.adminEnabled && config.adminToken && token === config.adminToken) {
    return {
      userId: "_admin",
      deviceId: "_admin",
      replicaId: "_admin",
      tenantId: DEFAULT_TENANT_ID,
      scope: "admin",
    };
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
    tenantId: session.tenantId,
  };
}

/**
 * Build an admin principal from the request's bearer if it matches the
 * configured admin token. Returns `undefined` if admin is disabled, the
 * bearer is missing, or the bearer doesn't match. The returned principal is
 * scoped `"admin"` so {@link decide} bypasses the cross-tenant check.
 */
function adminPrincipalFromRequest(
  request: http.IncomingMessage,
  url: URL,
  config: FrickConfig,
): Principal | undefined {
  if (!config.adminEnabled || !config.adminToken) {
    return undefined;
  }
  const token = sessionTokenFromRequest(request, url);
  if (!token || token !== config.adminToken) {
    return undefined;
  }
  return {
    userId: "_admin",
    deviceId: "_admin",
    replicaId: "_admin",
    tenantId: DEFAULT_TENANT_ID,
    scope: "admin",
  };
}

/**
 * Thrown by {@link ensureTenantAllowed} when a non-default tenant id isn't
 * present in the ledger and `config.implicitTenantCreation` is false. The
 * caller surfaces this through `sendError` as `auth.forbidden` with
 * `details.reason: "unknownTenant"`.
 */
class UnknownTenantError extends AuthorizationError {
  constructor(tenantId: string) {
    super({
      allow: false,
      reason: "notAuthorizedForResource",
      publicMessage: `Unknown tenant ${tenantId}`,
    });
    this.name = "UnknownTenantError";
    (this as { tenantId?: string }).tenantId = tenantId;
  }
}

/**
 * Pre-check called from `/auth/*` handlers: confirms the supplied tenant is
 * either the always-allowed default tenant, already in the ledger, or — when
 * `config.implicitTenantCreation` is true — auto-inserted into the ledger so
 * subsequent requests resolve cleanly. Throws {@link UnknownTenantError}
 * when the tenant is unknown and implicit creation is disabled.
 */
function ensureTenantAllowed(store: FrickStore, config: FrickConfig, tenantId: string): void {
  if (tenantId === DEFAULT_TENANT_ID) {
    return;
  }
  const existing = store.tenants.get(tenantId);
  if (existing && !existing.archivedAt) {
    return;
  }
  if (existing && existing.archivedAt) {
    throw new UnknownTenantError(tenantId);
  }
  if (config.implicitTenantCreation) {
    store.tenants.ensure(tenantId);
    return;
  }
  throw new UnknownTenantError(tenantId);
}

async function handleAdminRoute(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  store: FrickStore,
  maxBodyBytes: number,
): Promise<void> {
  const sub = url.pathname.slice("/_frick/admin/".length);

  if (request.method === "GET" && sub === "tenants") {
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    sendJson(response, 200, { tenants: store.tenants.list(includeArchived) });
    return;
  }

  if (request.method === "POST" && sub === "tenants") {
    const body = await readJsonBody(request, maxBodyBytes);
    const tenantId = requireString(body.tenantId, "tenantId");
    const displayName =
      typeof body.displayName === "string" && body.displayName.length > 0
        ? body.displayName
        : undefined;
    try {
      const row = store.tenants.create(tenantId, displayName);
      sendJson(response, 201, row);
    } catch (error) {
      if (error instanceof TenantAlreadyExistsError) {
        const envelope = createFrickErrorEnvelope({
          code: "sync.protocolError",
          message: error.message,
          requestId: "admin_tenant_conflict",
          retryable: false,
          details: { reason: "tenantExists", tenantId: error.tenantId },
          schemaHash: foundationSchema.hash,
          schemaRevision: foundationSchema.schemaRevision,
        });
        sendJson(response, 409, {
          error: envelope,
          code: envelope.code,
          message: envelope.message,
          requestId: envelope.requestId,
          retryable: envelope.retryable,
        });
        return;
      }
      throw error;
    }
    return;
  }

  const archiveMatch = /^tenants\/([^/]+)\/archive$/.exec(sub);
  if (request.method === "POST" && archiveMatch) {
    const tenantId = decodeURIComponent(archiveMatch[1]!);
    const existing = store.tenants.get(tenantId);
    if (!existing) {
      sendJson(response, 404, { error: "tenant_not_found" });
      return;
    }
    store.tenants.archive(tenantId);
    const row = store.tenants.get(tenantId);
    sendJson(response, 200, row);
    return;
  }

  const showMatch = /^tenants\/([^/]+)$/.exec(sub);
  if (request.method === "GET" && showMatch) {
    const tenantId = decodeURIComponent(showMatch[1]!);
    const row = store.tenants.get(tenantId);
    if (!row) {
      sendJson(response, 404, { error: "tenant_not_found" });
      return;
    }
    sendJson(response, 200, row);
    return;
  }

  sendJson(response, 404, { error: "not_found" });
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
  tenantId: string = DEFAULT_TENANT_ID,
): StoredSession {
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
  const sessionToken = randomToken(32);
  store.recordUserDevice(deviceId, userId, platform, new Date().toISOString(), tenantId);
  return store.createSession({ sessionToken, userId, deviceId, replicaId, expiresAt, tenantId });
}

function authSessionResponse(store: FrickStore, session: StoredSession, account: StoredAccount): Record<string, unknown> {
  return {
    schemaHash: store.schema.hash,
    sessionToken: session.sessionToken,
    tenantId: session.tenantId,
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

function userIdFromHandle(tenantId: string, handle: string): string {
  // user-id PK is global across tenants; namespace non-default tenants so
  // the same handle in two tenants resolves to distinct user ids without
  // changing the auth_accounts primary key shape.
  const base = handle.replace(/_/g, "-");
  return tenantId === DEFAULT_TENANT_ID ? `user-${base}` : `user-${tenantId}-${base}`;
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

function createConversationId(store: FrickStore, tenantId: string, seed: string): string {
  const slug = slugFromTitle(seed);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const conversationId = `conversation-${slug}-${randomBytes(3).toString("hex")}`;
    if (!store.readObject(tenantId, "Conversation", conversationId)) {
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
