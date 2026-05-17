/**
 * `frick mcp` — stdio MCP server for agent access to documented Frick runtime
 * surfaces. Default mode is read-only. `--print-config` emits a JSON client
 * config instead of starting stdio transport.
 */
import { createMcpClientConfig, runFrickMcpStdio, type FrickMcpOptions } from "@frick/mcp";
import { requireBoolean, requireString, type ParsedArgs } from "../argv.js";
import { CliUsageError, EXIT_OK } from "../errors.js";
import { emit, type OutputOptions } from "../output.js";

const DEFAULT_FRICK_ENDPOINT = "http://127.0.0.1:4099";

export async function mcpCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const options = readOptions(parsed);
  if (requireBoolean(parsed.flags, "print-config")) {
    emit(createMcpClientConfig(options), out);
    return EXIT_OK;
  }

  runFrickMcpStdio(options, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  await waitForever();
  return EXIT_OK;
}

function readOptions(parsed: ParsedArgs): FrickMcpOptions {
  const endpoint = requireString(parsed.flags, "endpoint") ?? process.env.FRICK_ENDPOINT ?? DEFAULT_FRICK_ENDPOINT;
  validateEndpoint(endpoint);
  const token = requireString(parsed.flags, "token");
  const tenantId = requireString(parsed.flags, "tenant");
  const userId = requireString(parsed.flags, "user");

  return {
    endpoint,
    ...(token ? { token } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(userId ? { userId } : {}),
    allowWrites: requireBoolean(parsed.flags, "allow-writes") && !requireBoolean(parsed.flags, "readonly"),
  };
}

function validateEndpoint(endpoint: string): void {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
  } catch {
    throw new CliUsageError(`--endpoint must be an HTTP(S) URL, got ${JSON.stringify(endpoint)}`);
  }
}

function waitForever(): Promise<never> {
  return new Promise(() => {
    // MCP stdio servers stay alive until the host process closes stdin or kills the subprocess.
  });
}
