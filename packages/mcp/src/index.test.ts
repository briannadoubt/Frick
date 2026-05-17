import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";
import { createFrickMcpServer, runFrickMcpStdio, type FrickMcpFetch } from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Frick MCP server", () => {
  test("announces MCP capabilities during initialize", async () => {
    const server = createFrickMcpServer({ endpoint: "http://127.0.0.1:4099" });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "frick-mcp" },
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    });
  });

  test("lists resources, tools, and prompts for Frick runtime inspection", async () => {
    const server = createFrickMcpServer({ endpoint: "http://127.0.0.1:4099" });

    const tools = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const resources = await server.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    const prompts = await server.handle({ jsonrpc: "2.0", id: 4, method: "prompts/list" });

    expect(JSON.stringify(tools)).toContain("frick_inspect_server");
    expect(JSON.stringify(tools)).toContain("frick_read_stream");
    expect(JSON.stringify(resources)).toContain("frick://inspect/server");
    expect(JSON.stringify(prompts)).toContain("debug_frick_sync");
  });

  test("calls Frick HTTP surfaces with auth and returns structured content", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher: FrickMcpFetch = async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url: String(url), headers });
      return jsonResponse({
        ok: true,
        schemaId: "demo",
        endpoint: String(url),
      });
    };
    const server = createFrickMcpServer({
      endpoint: "http://127.0.0.1:4099",
      token: "session-token",
      tenantId: "tenant-dev",
      userId: "user-ada",
      fetcher,
    });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "frick_inspect_server", arguments: {} },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 5,
      result: {
        isError: false,
        structuredContent: {
          ok: true,
          schemaId: "demo",
        },
      },
    });
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:4099/_frick/inspect/server",
      headers: {
        authorization: "Bearer session-token",
        "x-frick-tenant": "tenant-dev",
        "x-frick-user": "user-ada",
      },
    });
  });

  test("keeps write tools gated by explicit allowWrites", async () => {
    const readonlyServer = createFrickMcpServer({ endpoint: "http://127.0.0.1:4099" });
    const writeServer = createFrickMcpServer({
      endpoint: "http://127.0.0.1:4099",
      allowWrites: true,
    });

    const readonlyTools = await readonlyServer.handle({ jsonrpc: "2.0", id: 6, method: "tools/list" });
    const writeTools = await writeServer.handle({ jsonrpc: "2.0", id: 7, method: "tools/list" });

    expect(JSON.stringify(readonlyTools)).not.toContain("frick_append_event");
    expect(JSON.stringify(writeTools)).toContain("frick_append_event");
  });

  test("reads resources and materializes prompts", async () => {
    const server = createFrickMcpServer({
      endpoint: "http://127.0.0.1:4099",
      fetcher: async () => jsonResponse({ ok: true, status: "ready" }),
    });

    const resource = await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "resources/read",
      params: { uri: "frick://server/ready" },
    });
    const prompt = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "prompts/get",
      params: { name: "debug_frick_sync", arguments: { userId: "user-ada" } },
    });

    expect(JSON.stringify(resource)).toContain("\"status\":\"ready\"");
    expect(JSON.stringify(prompt)).toContain("user-ada");
    expect(JSON.stringify(prompt)).toContain("schema identity");
  });

  test("stdio transport reports malformed JSON as an MCP parse error", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output = new Promise<string>((resolve) => {
      stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    });

    runFrickMcpStdio({ endpoint: "http://127.0.0.1:4099" }, { stdin, stdout, stderr });
    stdin.write("{bad json}\n");

    expect(JSON.parse(await output)).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });
});
