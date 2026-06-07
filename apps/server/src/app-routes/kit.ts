/**
 * App-route helper kit (FR-128).
 *
 * Frick hands `ServerOptions.appRoutes` a raw `(req, res)` with no framework
 * context, so every app re-implements the same glue: CORS, JSON request/
 * response I/O, a `:param` path matcher, and bearer-token → session →
 * principal authentication. This module ships that glue so app authors mount
 * routes without copying boilerplate.
 *
 * Role/RBAC resolution stays with the app: {@link authenticateRequest} returns
 * the framework {@link Principal} (the session's user/tenant/device identity);
 * map it to an app-specific role yourself.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../authz.js";
import type { FrickStore } from "../store.js";

export interface AppRouteCorsOptions {
  /** `Access-Control-Allow-Origin`. Defaults to `"*"`. */
  origin?: string;
  /** `Access-Control-Allow-Methods`. Defaults to `"GET,POST,OPTIONS"`. */
  methods?: string;
  /** `Access-Control-Allow-Headers`. Defaults to `"authorization,content-type"`. */
  headers?: string;
  /** When true, sets `Access-Control-Allow-Credentials: true`. Defaults to false. */
  credentials?: boolean;
}

const DEFAULT_CORS: Required<Omit<AppRouteCorsOptions, "credentials">> & {
  credentials: boolean;
} = {
  origin: "*",
  methods: "GET,POST,OPTIONS",
  headers: "authorization,content-type",
  credentials: false,
};

/** Set the app-route CORS headers on a response. */
export function setCors(res: ServerResponse, options: AppRouteCorsOptions = {}): void {
  res.setHeader("Access-Control-Allow-Origin", options.origin ?? DEFAULT_CORS.origin);
  res.setHeader("Access-Control-Allow-Methods", options.methods ?? DEFAULT_CORS.methods);
  res.setHeader("Access-Control-Allow-Headers", options.headers ?? DEFAULT_CORS.headers);
  if (options.credentials ?? DEFAULT_CORS.credentials) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
}

/**
 * Answer a CORS preflight. Returns true (and ends the response) when the
 * request was an `OPTIONS`, so the caller can `return` early.
 */
export function handlePreflight(
  req: IncomingMessage,
  res: ServerResponse,
  options: AppRouteCorsOptions = {},
): boolean {
  if (req.method !== "OPTIONS") return false;
  setCors(res, options);
  res.statusCode = 204;
  res.end();
  return true;
}

/** Send a JSON response with CORS headers applied. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  options: { cors?: AppRouteCorsOptions } = {},
): void {
  setCors(res, options.cors);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** Thrown by {@link readJsonBody} when the request body exceeds `maxBytes`. */
export class JsonBodyTooLargeError extends Error {
  readonly reason = "payloadTooLarge";
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit`);
    this.name = "JsonBodyTooLargeError";
  }
}

export interface ReadJsonBodyOptions {
  /** Hard cap on the buffered body. Defaults to 1 MiB. Exceeding it throws. */
  maxBytes?: number;
}

/** Default request-body cap for {@link readJsonBody}: 1 MiB. */
export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * Read and JSON-parse a request body. Returns `{}` for an empty body. Bounds
 * the buffered size to `maxBytes` (default 1 MiB) so an app route can't be
 * forced to buffer an unbounded payload; exceeding the cap throws a
 * {@link JsonBodyTooLargeError} (destroy the request and reply `413`).
 */
export async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  options: ReadJsonBodyOptions = {},
): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new JsonBodyTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

/**
 * Match a `/api/plan/:id/run`-style pattern against a pathname, returning the
 * captured params (URL-decoded) or `null` on no match. Segment counts must be
 * equal; `:name` segments capture, literal segments must match exactly.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const seg = patternSegments[i]!;
    const got = pathSegments[i]!;
    if (seg.startsWith(":")) {
      params[seg.slice(1)] = decodeURIComponent(got);
    } else if (seg !== got) {
      return null;
    }
  }
  return params;
}

/**
 * Resolve the request's `Authorization: Bearer <token>` header to the live
 * session's {@link Principal}, or `null` when no valid active session backs
 * the token. Role/RBAC mapping is the app's responsibility — derive it from
 * the returned `userId`.
 */
export async function authenticateRequest(
  store: FrickStore,
  req: IncomingMessage,
): Promise<Principal | null> {
  const header = req.headers["authorization"];
  const token =
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return null;
  const session = await store.sessions.readActive(token);
  if (!session) return null;
  return {
    userId: session.userId,
    tenantId: session.tenantId,
    deviceId: session.deviceId,
    replicaId: session.replicaId,
  };
}
