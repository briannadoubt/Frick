# Frick Agent Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a publishable `@fricken/agent-kit` package that installs Frick-aware plugins, skills, subagent profiles, and Cursor rules into new application projects.

**Architecture:** The package owns one canonical capability manifest plus portable `SKILL.md` files, shared references, and adapter-specific projections for Codex, Claude Code, and Cursor. A zero-dependency TypeScript installer copies the requested harness surfaces into a target app and reports JSON output for agent automation.

**Tech Stack:** TypeScript 5.9, Node 24, pnpm workspaces, Vitest, npm package publishing with trusted provenance.

---

### Task 1: Add Package Contract Tests

**Files:**
- Create: `packages/agent-kit/src/index.test.ts`
- Create: `packages/agent-kit/src/index.ts`
- Create: `packages/agent-kit/src/installer.ts`

- [ ] **Step 1: Write the failing tests**

```ts
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
  });

  test("installer writes all harness surfaces and preserves existing files", async () => {
    const target = await mkdtemp(join(tmpdir(), "frick-agent-kit-"));
    const first = await installAgentKit({ targetDir: target, harnesses: ["codex", "claude", "cursor"] });
    expect(first.written.some((path) => path.endsWith(".agents/plugins/frick-agent-kit/.codex-plugin/plugin.json"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".claude/agents/frick-backend.md"))).toBe(true);
    expect(first.written.some((path) => path.endsWith(".cursor/rules/frick-core.mdc"))).toBe(true);
    await stat(join(target, "docs/frick/spine.md"));

    const second = await installAgentKit({ targetDir: target, harnesses: ["codex", "claude", "cursor"] });
    expect(second.written).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
    const spine = await readFile(join(target, "docs/frick/spine.md"), "utf8");
    expect(spine).toContain("Frick App Spine");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/agent-kit/src/index.test.ts`

Expected: fails because `packages/agent-kit` and its exported functions do not exist yet.

### Task 2: Implement Installer and Manifest Validation

**Files:**
- Create: `packages/agent-kit/package.json`
- Create: `packages/agent-kit/tsconfig.json`
- Create: `packages/agent-kit/src/index.ts`
- Create: `packages/agent-kit/src/installer.ts`
- Create: `packages/agent-kit/src/cli.ts`
- Create: `packages/agent-kit/manifest.json`

- [ ] **Step 1: Implement package metadata and exports**

`package.json` exposes `dist/index.js` and the `frick-agent-kit` bin, includes `dist`, `manifest.json`, `skills`, `agents`, `references`, `adapters`, and `README.md`, and opts into public provenance publishing.

- [ ] **Step 2: Implement the installer**

`installAgentKit` reads from the package root, copies shared references to `docs/frick`, copies Codex plugin and agents for the Codex harness, copies Claude Code skills and agents for the Claude harness, and copies Cursor skills, agents, and rules for the Cursor harness. Existing files are skipped unless `force: true`.

- [ ] **Step 3: Implement validation**

`validateCapabilityMatrix` confirms every manifest capability references an existing skill, at least one Codex agent, at least one Claude agent, at least one Cursor agent, and at least one Cursor rule.

- [ ] **Step 4: Implement the CLI**

`frick-agent-kit install --all --target .` calls `installAgentKit` and emits one JSON object with `ok`, `targetDir`, `harnesses`, `written`, `skipped`, and `dryRun`.

### Task 3: Add Canonical Skills, Agents, Rules, and References

**Files:**
- Create: `packages/agent-kit/skills/*/SKILL.md`
- Create: `packages/agent-kit/agents/*.md`
- Create: `packages/agent-kit/references/*.md`
- Create: `packages/agent-kit/adapters/codex/**`
- Create: `packages/agent-kit/adapters/claude-code/**`
- Create: `packages/agent-kit/adapters/cursor/**`

- [ ] **Step 1: Add full capability surface**

Create skills for orchestration, shared spine, parallel execution, schema, server, projections, jobs, blobs, auth/tenancy, migrations/versioning, React, TypeScript core, Swift/iOS, Kotlin/Android, design tokens, sync/cache/protocol debugging, push, dashboard operations, generated artifacts, cross-platform parity, testing, and release readiness.

- [ ] **Step 2: Add adapter projections**

Codex receives a plugin manifest plus `.codex/agents` TOML files. Claude Code receives `.claude/agents` markdown files. Cursor receives `.cursor/agents`, `.cursor/skills`, and `.cursor/rules` files, with rules grouped as core, authoring, platforms, debugging, and quality gates.

### Task 4: Wire Publishing and Docs

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/publish-npm.yml`
- Modify: `scripts/security-hardening.test.ts`
- Modify: `docs/authoring.md`
- Modify: `docs/versioning.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add `packages/agent-kit` to build, typecheck, and publish lists**

The root scripts include `packages/agent-kit` in `build:packages` and `typecheck`. The npm publish workflow includes `packages/agent-kit` in both package directory arrays.

- [ ] **Step 2: Update docs and release tests**

The hardening tests include `packages/agent-kit` in the public npm package set. Authoring docs describe the installer command. Versioning lists `@fricken/agent-kit`.

### Task 5: Verify

**Files:**
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Refresh workspace lockfile**

Run: `pnpm install --lockfile-only`

- [ ] **Step 2: Run focused tests**

Run: `pnpm exec vitest run packages/agent-kit/src/index.test.ts scripts/security-hardening.test.ts`

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

- [ ] **Step 4: Run generated drift check**

Run: `pnpm verify:generated`
