# @frick/agent-kit

Portable Frick agent compatibility pack for Codex, Claude Code, and Cursor.

```bash
pnpm dlx @frick/agent-kit install --all --target ./my-frick-app
```

The installer writes:

- Codex plugin, skills, and subagent profiles under `.agents/` and `.codex/`.
- Claude Code skills and subagent profiles under `.claude/`.
- Cursor skills, subagent profiles, plugin metadata, and `.cursor/rules/*.mdc`.
- `docs/frick/spine.md`, the shared app spine every agent should read before splitting work.
- MCP-aware skills, agents, and Cursor rules that point agents at `frick mcp` for live app inspection.

By default existing files are preserved. Pass `--force` only when intentionally refreshing generated agent-kit files.

```bash
frick-agent-kit install --target . --codex --claude --cursor
frick-agent-kit install --target . --all --dry-run
```
