export const DEFAULT_MCP_PROTOCOL_VERSION = "2025-11-25";

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcId | null;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId | null;
      error: { code: number; message: string; data?: unknown };
    };

export type FrickMcpFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface FrickMcpOptions {
  endpoint?: string;
  token?: string;
  tenantId?: string;
  userId?: string;
  allowWrites?: boolean;
  fetcher?: FrickMcpFetch;
}

export interface FrickMcpServer {
  readonly options: Required<Pick<FrickMcpOptions, "endpoint" | "allowWrites">> &
    Pick<FrickMcpOptions, "token" | "tenantId" | "userId">;
  handle(message: JsonRpcMessage): Promise<JsonRpcResponse | undefined>;
}

type JsonObject = Record<string, unknown>;

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
}

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

const READ_TOOLS: ToolDefinition[] = [
  {
    name: "frick_mcp_config",
    title: "Frick MCP Config",
    description: "Return the current Frick MCP endpoint and safety mode.",
    inputSchema: objectSchema({}),
  },
  {
    name: "frick_health",
    title: "Frick Health",
    description: "Read the running Frick server /health endpoint.",
    inputSchema: objectSchema({}),
  },
  {
    name: "frick_ready",
    title: "Frick Readiness",
    description: "Read the running Frick server /ready endpoint.",
    inputSchema: objectSchema({}),
  },
  {
    name: "frick_inspect_server",
    title: "Inspect Frick Server",
    description: "Read documented server inspection data.",
    inputSchema: objectSchema({}),
  },
  {
    name: "frick_inspect_db",
    title: "Inspect Frick Database",
    description: "Read documented database inspection data.",
    inputSchema: objectSchema({}),
  },
  {
    name: "frick_inspect_jobs",
    title: "Inspect Frick Jobs",
    description: "Read documented job inspection data.",
    inputSchema: objectSchema({}),
  },
  {
    name: "frick_read_stream",
    title: "Read Frick Stream",
    description: "Read a bounded page from a Frick stream.",
    inputSchema: objectSchema({
      stream: { type: "string", description: "Stream name." },
      key: { type: "string", description: "Stream key." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size." },
      cursor: { type: "string", description: "Optional cursor." },
    }, ["stream", "key"]),
  },
  {
    name: "frick_explain_error",
    title: "Explain Frick Error",
    description: "Explain a structured Frick error code and likely debugging path.",
    inputSchema: objectSchema({
      code: { type: "string", description: "Structured Frick error code." },
    }, ["code"]),
  },
];

const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: "frick_append_event",
    title: "Append Frick Stream Event",
    description: "Append an event to a Frick stream. Requires --allow-writes and normal Frick authz.",
    inputSchema: objectSchema({
      stream: { type: "string" },
      key: { type: "string" },
      eventType: { type: "string" },
      payload: { type: "object" },
    }, ["stream", "key", "eventType", "payload"]),
  },
];

const RESOURCES = [
  resource("frick://mcp/config", "MCP Config", "Current MCP endpoint and safety mode"),
  resource("frick://server/health", "Server Health", "Frick /health response"),
  resource("frick://server/ready", "Server Readiness", "Frick /ready response"),
  resource("frick://inspect/server", "Server Inspection", "Frick documented server inspection response"),
  resource("frick://inspect/db", "Database Inspection", "Frick documented database inspection response"),
  resource("frick://inspect/jobs", "Jobs Inspection", "Frick documented jobs inspection response"),
  resource("frick://schema/current", "Current Schema", "Current schema identity from server inspection"),
];

const PROMPTS: PromptDefinition[] = [
  {
    name: "debug_frick_sync",
    title: "Debug Frick Sync",
    description: "Guide an agent through schema identity, handshake, cursor, cache, and structured error debugging.",
    arguments: [
      { name: "userId", description: "Optional user id involved in the sync issue." },
      { name: "stream", description: "Optional stream name involved in the issue." },
    ],
  },
  {
    name: "inspect_frick_runtime",
    title: "Inspect Frick Runtime",
    description: "Collect health, readiness, inspection, and job context from a running Frick app.",
  },
  {
    name: "design_frick_projection",
    title: "Design Frick Projection",
    description: "Use live schema context to design or review a projection.",
    arguments: [{ name: "projection", description: "Projection name or product concept." }],
  },
];

const ERROR_HINTS: Record<string, string> = {
  "auth.unauthenticated": "Check session token presence and whether the client sent credentials during Hello or HTTP request auth.",
  "auth.forbidden": "Check tenant membership, object/stream visibility, and policy hooks.",
  "auth.sessionExpired": "Refresh or recreate the session and reconnect the sync socket.",
  "schema.incompatible": "Compare schemaId, schemaRevision, schemaHash, and generated artifacts across server and client.",
  "schema.migrationRequired": "Run migration status and apply compatible migrations before reconnecting clients.",
  "storage.conflict": "Check expectedVersion, mergePolicy, and pending offline upserts.",
  "stream.appendRejected": "Inspect stream schema, event payload shape, tenant scope, and authz policy.",
  "sync.protocolError": "Inspect Hello/HelloAck ordering, frame kind, payload shape, and required capabilities.",
  "sync.reconnectExhausted": "Check network stability, retry policy, server readiness, and last nack envelope.",
};

function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

function resource(uri: string, title: string, description: string): JsonObject {
  return {
    uri,
    name: uri.replace("frick://", ""),
    title,
    description,
    mimeType: "application/json",
    annotations: { audience: ["assistant"], priority: 0.8 },
  };
}

function normalizeEndpoint(endpoint: string | undefined): string {
  return (endpoint ?? "http://127.0.0.1:4099").replace(/\/+$/, "");
}

function requestId(message: JsonRpcMessage): JsonRpcId | null {
  return message.id ?? null;
}

function ok(id: JsonRpcId | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringArg(args: JsonObject, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function integerArg(args: JsonObject, name: string, fallback: number): number {
  const value = args[name];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return fallback;
}

function textResult(body: unknown, isError = false): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError,
  };
}

export function createMcpClientConfig(options: FrickMcpOptions = {}): JsonObject {
  const endpoint = normalizeEndpoint(options.endpoint);
  const args = ["mcp", "--endpoint", endpoint];
  if (options.allowWrites === true) args.push("--allow-writes");
  if (options.tenantId) args.push("--tenant", options.tenantId);
  if (options.userId) args.push("--user", options.userId);
  if (options.token) args.push("--token", options.token);
  return {
    ok: true,
    transport: "stdio",
    command: "frick",
    args,
    endpoint,
    readonly: options.allowWrites !== true,
  };
}

export function createFrickMcpServer(options: FrickMcpOptions = {}): FrickMcpServer {
  const endpoint = normalizeEndpoint(options.endpoint);
  const allowWrites = options.allowWrites === true;
  const fetcher = options.fetcher ?? fetch;
  const publicOptions = {
    endpoint,
    allowWrites,
    ...(options.token ? { token: options.token } : {}),
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.userId ? { userId: options.userId } : {}),
  };

  function headers(): Headers {
    const headers = new Headers();
    headers.set("accept", "application/json");
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.tenantId) headers.set("x-frick-tenant", options.tenantId);
    if (options.userId) headers.set("x-frick-user", options.userId);
    return headers;
  }

  async function fetchJson(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await fetcher(`${endpoint}${path}`, {
      ...init,
      headers: mergeHeaders(headers(), init.headers),
    });
    const text = await response.text();
    let body: unknown = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { text };
      }
    }
    return { ok: response.ok, status: response.status, body };
  }

  async function fetchRuntime(path: string, init: RequestInit = {}): Promise<unknown> {
    const result = await fetchJson(path, init);
    return result.ok ? result.body : result;
  }

  async function callTool(name: string, args: JsonObject): Promise<JsonObject> {
    if (name === "frick_mcp_config") return textResult(createMcpClientConfig(publicOptions));
    if (name === "frick_health") return textResult(await fetchRuntime("/health"));
    if (name === "frick_ready") return textResult(await fetchRuntime("/ready"));
    if (name === "frick_inspect_server") return textResult(await fetchRuntime("/_frick/inspect/server"));
    if (name === "frick_inspect_db") return textResult(await fetchRuntime("/_frick/inspect/db"));
    if (name === "frick_inspect_jobs") return textResult(await fetchRuntime("/_frick/inspect/jobs"));
    if (name === "frick_explain_error") {
      const code = stringArg(args, "code") ?? "unknown";
      return textResult({
        code,
        hint: ERROR_HINTS[code] ?? "Unknown Frick error code. Treat it as opaque and inspect the full structured envelope.",
      });
    }
    if (name === "frick_read_stream") {
      const stream = stringArg(args, "stream", "name");
      const key = stringArg(args, "key");
      if (!stream || !key) return textResult({ error: "stream and key are required" }, true);
      const limit = Math.min(Math.max(integerArg(args, "limit", 50), 1), 100);
      const cursor = stringArg(args, "cursor");
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      return textResult(await fetchRuntime(`/streams/${encodeURIComponent(stream)}/${encodeURIComponent(key)}?${query}`));
    }
    if (name === "frick_append_event") {
      if (!allowWrites) return textResult({ error: "frick_append_event requires --allow-writes" }, true);
      const stream = stringArg(args, "stream", "name");
      const key = stringArg(args, "key");
      const eventType = stringArg(args, "eventType", "type");
      const payload = args.payload;
      if (!stream || !key || !eventType || !payload) {
        return textResult({ error: "stream, key, eventType, and payload are required" }, true);
      }
      return textResult(
        await fetchRuntime(`/streams/${encodeURIComponent(stream)}/${encodeURIComponent(key)}`, {
          method: "POST",
          body: JSON.stringify({ type: eventType, payload }),
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return textResult({ error: `Unknown Frick MCP tool: ${name}` }, true);
  }

  async function readResource(uri: string): Promise<JsonObject> {
    if (uri === "frick://mcp/config") return resourceContent(uri, createMcpClientConfig(publicOptions));
    if (uri === "frick://server/health") return resourceContent(uri, await fetchRuntime("/health"));
    if (uri === "frick://server/ready") return resourceContent(uri, await fetchRuntime("/ready"));
    if (uri === "frick://inspect/server") return resourceContent(uri, await fetchRuntime("/_frick/inspect/server"));
    if (uri === "frick://inspect/db") return resourceContent(uri, await fetchRuntime("/_frick/inspect/db"));
    if (uri === "frick://inspect/jobs") return resourceContent(uri, await fetchRuntime("/_frick/inspect/jobs"));
    if (uri === "frick://schema/current") return resourceContent(uri, await fetchRuntime("/_frick/inspect/server"));
    return { contents: [{ uri, mimeType: "text/plain", text: `Unknown Frick MCP resource: ${uri}` }] };
  }

  return {
    options: publicOptions,
    async handle(message: JsonRpcMessage): Promise<JsonRpcResponse | undefined> {
      const id = requestId(message);
      if (!message.method) return fail(id, -32600, "Invalid JSON-RPC request");

      switch (message.method) {
        case "initialize": {
          const params = asRecord(message.params);
          const protocolVersion =
            typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_MCP_PROTOCOL_VERSION;
          return ok(id, {
            protocolVersion,
            serverInfo: { name: "frick-mcp", version: "0.0.0" },
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
            },
          });
        }
        case "notifications/initialized":
          return undefined;
        case "tools/list":
          return ok(id, { tools: allowWrites ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS });
        case "tools/call": {
          const params = asRecord(message.params);
          const name = stringArg(params, "name");
          if (!name) return fail(id, -32602, "tools/call requires params.name");
          return ok(id, await callTool(name, asRecord(params.arguments)));
        }
        case "resources/list":
          return ok(id, { resources: RESOURCES });
        case "resources/templates/list":
          return ok(id, {
            resourceTemplates: [
              {
                uriTemplate: "frick://streams/{stream}/{key}",
                name: "stream-page",
                title: "Frick Stream Page",
                description: "Read a Frick stream page by stream name and key.",
                mimeType: "application/json",
              },
            ],
          });
        case "resources/read": {
          const uri = stringArg(asRecord(message.params), "uri");
          if (!uri) return fail(id, -32602, "resources/read requires params.uri");
          return ok(id, await readResource(uri));
        }
        case "prompts/list":
          return ok(id, { prompts: PROMPTS });
        case "prompts/get": {
          const params = asRecord(message.params);
          const name = stringArg(params, "name");
          if (!name) return fail(id, -32602, "prompts/get requires params.name");
          return ok(id, renderPrompt(name, asRecord(params.arguments)));
        }
        default:
          return fail(id, -32601, `Unknown MCP method: ${message.method}`);
      }
    },
  };
}

function mergeHeaders(base: Headers, extra: HeadersInit | undefined): Headers {
  if (!extra) return base;
  for (const [key, value] of new Headers(extra).entries()) {
    base.set(key, value);
  }
  return base;
}

function resourceContent(uri: string, body: unknown): JsonObject {
  return {
    structuredContent: body,
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(body),
      },
    ],
  };
}

function renderPrompt(name: string, args: JsonObject): JsonObject {
  if (name === "debug_frick_sync") {
    const user = stringArg(args, "userId") ?? "the affected user";
    const stream = stringArg(args, "stream") ?? "the affected stream";
    return {
      description: "Debug Frick sync",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Debug Frick sync for ${user} and ${stream}. ` +
              "Start with schema identity, Hello/HelloAck capabilities, auth/session state, cursors, pending mutations, cache metadata, and structured error envelopes.",
          },
        },
      ],
    };
  }

  if (name === "inspect_frick_runtime") {
    return {
      description: "Inspect Frick runtime",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Collect Frick health, readiness, server inspection, db inspection, jobs, schema identity, and MCP config before diagnosing runtime behavior.",
          },
        },
      ],
    };
  }

  if (name === "design_frick_projection") {
    const projection = stringArg(args, "projection") ?? "the requested projection";
    return {
      description: "Design Frick projection",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the live Frick schema and app spine to design ${projection}. Identify source objects/streams, derived shape, tenant scope, and client subscription behavior.`,
          },
        },
      ],
    };
  }

  return {
    description: "Unknown prompt",
    messages: [{ role: "user", content: { type: "text", text: `Unknown Frick MCP prompt: ${name}` } }],
  };
}
