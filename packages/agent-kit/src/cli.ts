#!/usr/bin/env node
import process from "node:process";
import { installAgentKit, type AgentHarness } from "./index.js";

type ParsedCli = {
  command: string | undefined;
  targetDir: string;
  harnesses: AgentHarness[];
  force: boolean;
  dryRun: boolean;
  help: boolean;
};

const HARNESSES: readonly AgentHarness[] = ["codex", "claude", "cursor"];

function parse(argv: readonly string[]): ParsedCli {
  const parsed: ParsedCli = {
    command: undefined,
    targetDir: process.cwd(),
    harnesses: [],
    force: false,
    dryRun: false,
    help: false,
  };

  const args = [...argv];
  parsed.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--target") {
      const target = args[i + 1];
      if (!target) throw new Error("--target requires a path");
      parsed.targetDir = target;
      i += 1;
    } else if (arg === "--all") {
      parsed.harnesses = [...HARNESSES];
    } else if (arg === "--codex" || arg === "--claude" || arg === "--cursor") {
      parsed.harnesses.push(arg.slice(2) as AgentHarness);
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.harnesses.length === 0) parsed.harnesses = [...HARNESSES];
  return parsed;
}

function usage(): string {
  return [
    "Usage: frick-agent-kit install [--target <dir>] [--all|--codex|--claude|--cursor] [--force] [--dry-run]",
    "",
    "Installs Frick plugin, skill, subagent, and Cursor rule surfaces into a Frick app project.",
  ].join("\n");
}

function emit(record: unknown): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function emitError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { code: "agentKit.error", message } })}\n`);
}

async function main(): Promise<number> {
  try {
    const parsed = parse(process.argv.slice(2));
    if (!parsed.command || parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return parsed.command ? 0 : 2;
    }
    if (parsed.command !== "install") {
      throw new Error(`Unknown command: ${parsed.command}`);
    }

    emit(
      await installAgentKit({
        targetDir: parsed.targetDir,
        harnesses: parsed.harnesses,
        force: parsed.force,
        dryRun: parsed.dryRun,
      }),
    );
    return 0;
  } catch (error) {
    emitError(error);
    return 1;
  }
}

process.exit(await main());
