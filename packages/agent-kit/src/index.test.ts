import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { installAgentKit, loadManifest, validateCapabilityMatrix } from "./index.js";

describe("Frick agent kit", () => {
  test("manifest maps every capability to skills, subagents, plugins, and Cursor rules", async () => {
    const manifest = await loadManifest();

    const findings = await validateCapabilityMatrix(manifest);

    expect(findings).toEqual([]);
    expect(manifest.capabilities.length).toBeGreaterThanOrEqual(25);
    expect(manifest.capabilities.some((capability) => capability.id === "frick-mcp-runtime")).toBe(true);
  });

  test("installer writes all harness surfaces and preserves existing files", async () => {
    const target = await mkdtemp(join(tmpdir(), "frick-agent-kit-"));

    const first = await installAgentKit({ targetDir: target, harnesses: ["codex", "claude", "cursor"] });

    expect(first.written.some((path) => path.endsWith(".agents/plugins/frick-agent-kit/.codex-plugin/plugin.json"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".codex/agents/frick-backend.toml"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".claude/agents/frick-backend.md"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".cursor/agents/frick-backend.md"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".codex/agents/frick-mcp.toml"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".claude/agents/frick-mcp.md"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".cursor/agents/frick-mcp.md"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".cursor/rules/frick-core.mdc"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".cursor/rules/frick-mcp.mdc"))).toBe(true);
    await stat(join(target, "docs/frick/spine.md"));

    const second = await installAgentKit({ targetDir: target, harnesses: ["codex", "claude", "cursor"] });

    expect(second.written).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
    const spine = await readFile(join(target, "docs/frick/spine.md"), "utf8");
    expect(spine).toContain("Frick App Spine");
  });
});
