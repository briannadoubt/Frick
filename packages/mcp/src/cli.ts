#!/usr/bin/env node
import process from "node:process";
import { createMcpClientConfig, runFrickMcpStdio, type FrickMcpOptions } from "./index.js";

interface Parsed {
  endpoint?: string;
  token?: string;
  tenantId?: string;
  userId?: string;
  allowWrites: boolean;
  printConfig: boolean;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parse(argv: readonly string[]): Parsed {
  const parsed: Parsed = { allowWrites: false, printConfig: false };
  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--endpoint") {
      parsed.endpoint = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--token") {
      parsed.token = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--tenant") {
      parsed.tenantId = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--user") {
      parsed.userId = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--allow-writes") {
      parsed.allowWrites = true;
    } else if (arg === "--readonly") {
      parsed.allowWrites = false;
    } else if (arg === "--print-config") {
      parsed.printConfig = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function toOptions(parsed: Parsed): FrickMcpOptions {
  return {
    ...(parsed.endpoint ? { endpoint: parsed.endpoint } : {}),
    ...(parsed.token ? { token: parsed.token } : {}),
    ...(parsed.tenantId ? { tenantId: parsed.tenantId } : {}),
    ...(parsed.userId ? { userId: parsed.userId } : {}),
    allowWrites: parsed.allowWrites,
  };
}

try {
  const parsed = parse(process.argv.slice(2));
  const options = toOptions(parsed);
  if (parsed.printConfig) {
    process.stdout.write(`${JSON.stringify(createMcpClientConfig(options))}\n`);
  } else {
    runFrickMcpStdio(options);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { code: "mcp.usage", message } })}\n`);
  process.exit(2);
}
