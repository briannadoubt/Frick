import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentHarness = "codex" | "claude" | "cursor";

export interface AgentKitCapability {
  id: string;
  title: string;
  summary: string;
  skill: string;
  agents: Record<AgentHarness, string[]>;
  cursorRules: string[];
  docs: string[];
  commands: string[];
}

export interface AgentKitManifest {
  name: string;
  version: string;
  description: string;
  pluginSurfaces: Record<AgentHarness, string>;
  sharedReferences: string[];
  capabilities: AgentKitCapability[];
}

export interface CapabilityFinding {
  capabilityId: string;
  kind:
    | "missing-skill"
    | "missing-agent"
    | "missing-cursor-rule"
    | "missing-plugin-surface"
    | "missing-reference";
  detail: string;
}

export interface InstallAgentKitOptions {
  targetDir: string;
  harnesses?: readonly AgentHarness[];
  force?: boolean;
  dryRun?: boolean;
}

export interface InstallAgentKitReport {
  ok: boolean;
  targetDir: string;
  harnesses: AgentHarness[];
  written: string[];
  skipped: string[];
  dryRun: boolean;
}

interface CopyContext {
  rootDir: string;
  targetDir: string;
  force: boolean;
  dryRun: boolean;
  written: string[];
  skipped: string[];
}

const ALL_HARNESSES: readonly AgentHarness[] = ["codex", "claude", "cursor"];
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function packagePath(path: string): string {
  return join(PACKAGE_ROOT, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function normalizeHarnesses(harnesses: readonly AgentHarness[] | undefined): AgentHarness[] {
  if (!harnesses || harnesses.length === 0) return [...ALL_HARNESSES];
  const selected = new Set<AgentHarness>();
  for (const harness of harnesses) {
    if (!ALL_HARNESSES.includes(harness)) {
      throw new Error(`Unsupported Frick agent harness: ${harness}`);
    }
    selected.add(harness);
  }
  return [...selected];
}

function assertInsideTarget(targetDir: string, destination: string): void {
  const targetRelative = relative(targetDir, destination);
  if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
    throw new Error(`Refusing to write outside target directory: ${destination}`);
  }
}

async function copyFileFresh(ctx: CopyContext, source: string, destination: string): Promise<void> {
  assertInsideTarget(ctx.targetDir, destination);
  if ((await pathExists(destination)) && !ctx.force) {
    ctx.skipped.push(destination);
    return;
  }

  ctx.written.push(destination);
  if (ctx.dryRun) return;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function writeTextFresh(ctx: CopyContext, destination: string, body: string): Promise<void> {
  assertInsideTarget(ctx.targetDir, destination);
  if ((await pathExists(destination)) && !ctx.force) {
    ctx.skipped.push(destination);
    return;
  }

  ctx.written.push(destination);
  if (ctx.dryRun) return;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body, "utf8");
}

async function copyDirectory(ctx: CopyContext, sourceDir: string, destinationDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(ctx, source, destination);
    } else if (entry.isFile()) {
      await copyFileFresh(ctx, source, destination);
    }
  }
}

async function ensureFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

export async function loadManifest(): Promise<AgentKitManifest> {
  return readJson<AgentKitManifest>(packagePath("manifest.json"));
}

export async function validateCapabilityMatrix(manifest?: AgentKitManifest): Promise<CapabilityFinding[]> {
  manifest ??= await loadManifest();
  const findings: CapabilityFinding[] = [];

  for (const harness of ALL_HARNESSES) {
    const surface = manifest.pluginSurfaces[harness];
    if (!surface || !(await ensureFile(packagePath(surface)))) {
      findings.push({
        capabilityId: "plugin-surfaces",
        kind: "missing-plugin-surface",
        detail: `${harness} plugin surface is missing: ${surface}`,
      });
    }
  }

  for (const reference of manifest.sharedReferences) {
    if (!(await ensureFile(packagePath(reference)))) {
      findings.push({
        capabilityId: "shared-references",
        kind: "missing-reference",
        detail: `Shared reference is missing: ${reference}`,
      });
    }
  }

  for (const capability of manifest.capabilities) {
    if (!(await ensureFile(packagePath(capability.skill)))) {
      findings.push({
        capabilityId: capability.id,
        kind: "missing-skill",
        detail: `Skill is missing: ${capability.skill}`,
      });
    }

    for (const harness of ALL_HARNESSES) {
      const agents = capability.agents[harness];
      if (!agents || agents.length === 0) {
        findings.push({
          capabilityId: capability.id,
          kind: "missing-agent",
          detail: `${harness} has no agent mapping`,
        });
        continue;
      }
      for (const agent of agents) {
        if (!(await ensureFile(packagePath(agent)))) {
          findings.push({
            capabilityId: capability.id,
            kind: "missing-agent",
            detail: `${harness} agent is missing: ${agent}`,
          });
        }
      }
    }

    if (capability.cursorRules.length === 0) {
      findings.push({
        capabilityId: capability.id,
        kind: "missing-cursor-rule",
        detail: "Cursor has no rule mapping",
      });
    }
    for (const rule of capability.cursorRules) {
      if (!(await ensureFile(packagePath(rule)))) {
        findings.push({
          capabilityId: capability.id,
          kind: "missing-cursor-rule",
          detail: `Cursor rule is missing: ${rule}`,
        });
      }
    }
  }

  return findings;
}

async function installShared(ctx: CopyContext): Promise<void> {
  await copyFileFresh(ctx, packagePath("references/spine-template.md"), join(ctx.targetDir, "docs/frick/spine.md"));
  await copyDirectory(ctx, packagePath("references"), join(ctx.targetDir, "docs/frick/agent-kit"));
  await writeTextFresh(
    ctx,
    join(ctx.targetDir, "AGENTS.md"),
    [
      "# Frick Agent Guidance",
      "",
      "Use `docs/frick/spine.md` as the shared app spine before splitting backend, web, iOS, Android, and debugging work.",
      "Keep generated artifacts in sync with `pnpm schema:generate`, `pnpm design:generate`, and `pnpm verify:generated`.",
      "Do not hand-edit generated Frick protocol or design files.",
      "",
    ].join("\n"),
  );
}

async function installCodex(ctx: CopyContext): Promise<void> {
  await copyDirectory(ctx, packagePath("adapters/codex/plugin"), join(ctx.targetDir, ".agents/plugins/frick-agent-kit"));
  await copyDirectory(ctx, packagePath("skills"), join(ctx.targetDir, ".agents/plugins/frick-agent-kit/skills"));
  await copyDirectory(ctx, packagePath("adapters/codex/agents"), join(ctx.targetDir, ".codex/agents"));
  await copyFileFresh(
    ctx,
    packagePath("adapters/codex/marketplace.json"),
    join(ctx.targetDir, ".agents/plugins/marketplace.json"),
  );
}

async function installClaude(ctx: CopyContext): Promise<void> {
  await copyDirectory(ctx, packagePath("skills"), join(ctx.targetDir, ".claude/skills"));
  await copyDirectory(ctx, packagePath("adapters/claude-code/agents"), join(ctx.targetDir, ".claude/agents"));
  await copyDirectory(ctx, packagePath("adapters/claude-code/plugin"), join(ctx.targetDir, ".claude/plugins/frick-agent-kit"));
}

async function installCursor(ctx: CopyContext): Promise<void> {
  await copyDirectory(ctx, packagePath("skills"), join(ctx.targetDir, ".cursor/skills"));
  await copyDirectory(ctx, packagePath("adapters/cursor/agents"), join(ctx.targetDir, ".cursor/agents"));
  await copyDirectory(ctx, packagePath("adapters/cursor/rules"), join(ctx.targetDir, ".cursor/rules"));
  await copyDirectory(ctx, packagePath("adapters/cursor/plugin"), join(ctx.targetDir, ".cursor/plugins/frick-agent-kit"));
}

export async function installAgentKit(options: InstallAgentKitOptions): Promise<InstallAgentKitReport> {
  const targetDir = resolve(options.targetDir);
  const harnesses = normalizeHarnesses(options.harnesses);
  const ctx: CopyContext = {
    rootDir: PACKAGE_ROOT,
    targetDir,
    force: options.force === true,
    dryRun: options.dryRun === true,
    written: [],
    skipped: [],
  };

  await installShared(ctx);
  for (const harness of harnesses) {
    if (harness === "codex") await installCodex(ctx);
    if (harness === "claude") await installClaude(ctx);
    if (harness === "cursor") await installCursor(ctx);
  }

  return {
    ok: true,
    targetDir,
    harnesses,
    written: ctx.written.sort(),
    skipped: ctx.skipped.sort(),
    dryRun: ctx.dryRun,
  };
}
