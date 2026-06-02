# Frick MCP Agent-Native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the Frick Agent Kit with MCP-aware skills and agents, then add a CLI-owned `@fricken/mcp` package so agents can inspect and operate Frick apps through standard MCP.

**Architecture:** Keep the agent-kit as the app-building instruction layer and add `@fricken/mcp` as the runtime inspection layer. The MCP server uses stdio JSON-RPC, defaults to read-only tools over documented Frick HTTP/inspection surfaces, and is launched by `frick mcp` so the CLI remains the helm.

**Tech Stack:** TypeScript 5.9, Node 24, pnpm workspaces, Vitest, JSON-RPC 2.0 over MCP stdio newline transport.

---

### Task 1: Add Red Tests

**Files:**
- Create: `packages/mcp/src/index.test.ts`
- Modify: `packages/agent-kit/src/index.test.ts`
- Modify: `apps/cli/tests/cli.test.ts`

- [ ] **Step 1: Write MCP package tests**

Test that `createFrickMcpServer` handles `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get`. Use an injected fetcher so tests do not require a running Frick server.

- [ ] **Step 2: Write agent-kit coverage test**

Assert the manifest has a `frick-mcp-runtime` capability and that Codex, Claude Code, and Cursor each receive an MCP agent plus Cursor MCP rule.

- [ ] **Step 3: Write CLI test**

Assert `frick --help` lists `mcp`, and `frick mcp --print-config --endpoint http://127.0.0.1:4099` emits JSON without starting stdio mode.

### Task 2: Complete MCP-Aware Agent Kit Artifacts

**Files:**
- Modify: `packages/agent-kit/manifest.json`
- Add: `packages/agent-kit/skills/frick-mcp-runtime/SKILL.md`
- Add/modify: `packages/agent-kit/adapters/*/agents/frick-mcp.*`
- Add: `packages/agent-kit/adapters/cursor/rules/frick-mcp.mdc`
- Modify: `packages/agent-kit/references/*.md`

- [ ] **Step 1: Add MCP runtime capability**

Add a capability that maps to `frick-mcp-runtime`, each harness's MCP subagent, and Cursor's MCP rule.

- [ ] **Step 2: Add instructions**

Document when to use MCP resources, tools, prompts, read-only mode, write-gated mode, tenant/session context, and CLI startup commands.

### Task 3: Implement `@fricken/mcp`

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`
- Create: `packages/mcp/src/index.ts`
- Create: `packages/mcp/src/server.ts`
- Create: `packages/mcp/src/stdio.ts`

- [ ] **Step 1: Implement JSON-RPC handler**

Support MCP lifecycle and server feature methods with read-only default tools:
`frick_health`, `frick_ready`, `frick_inspect_server`, `frick_inspect_db`, `frick_inspect_jobs`, `frick_read_stream`, `frick_explain_error`, and `frick_mcp_config`.

- [ ] **Step 2: Implement stdio transport**

Read newline-delimited JSON-RPC messages from stdin and write only valid JSON-RPC messages to stdout.

### Task 4: Add `frick mcp`

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/index.ts`
- Add: `apps/cli/src/commands/mcp.ts`
- Modify: `apps/cli/README.md`
- Modify: `docs/operations.md`
- Modify: `docs/authoring.md`

- [ ] **Step 1: Add CLI command**

`frick mcp` starts stdio mode. `--print-config` emits a JSON command config for agent harnesses. Flags: `--endpoint`, `--readonly`, `--allow-writes`, `--tenant`, `--user`, `--token`.

- [ ] **Step 2: Document**

Explain that the CLI owns MCP startup and that default mode is local read-only.

### Task 5: Wire Package Publishing and Verify

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/publish-npm.yml`
- Modify: `scripts/security-hardening.test.ts`
- Modify: `docs/versioning.md`
- Modify: `CHANGELOG.md`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add `packages/mcp` to build/typecheck/publish lists**

- [ ] **Step 2: Run verification**

Run focused tests, `pnpm typecheck`, `pnpm test`, `pnpm verify:generated`, and `pnpm release:dry-run`.
