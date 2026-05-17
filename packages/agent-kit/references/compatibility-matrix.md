# Frick Agent Harness Compatibility Matrix

| Surface | Codex | Claude Code | Cursor |
| --- | --- | --- | --- |
| Plugin | `.agents/plugins/frick-agent-kit/.codex-plugin/plugin.json` | `.claude/plugins/frick-agent-kit/plugin.json` | `.cursor/plugins/frick-agent-kit/plugin.json` |
| Skills | `.agents/plugins/frick-agent-kit/skills/*/SKILL.md` | `.claude/skills/*/SKILL.md` | `.cursor/skills/*/SKILL.md` |
| Subagents | `.codex/agents/*.toml` | `.claude/agents/*.md` | `.cursor/agents/*.md` |
| Rules | `AGENTS.md` and skill metadata | `CLAUDE.md` or project instructions when present | `.cursor/rules/*.mdc` |
| MCP | `frick mcp` command in MCP config | `frick mcp` command in MCP config | `frick mcp` command in MCP config plus `.cursor/rules/frick-mcp.mdc` |

The canonical source is the package manifest and `skills/*/SKILL.md`. Adapter files should stay projections of that source.
