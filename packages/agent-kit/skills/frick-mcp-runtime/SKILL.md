---
name: frick-mcp-runtime
description: Use when connecting agents to a running Frick app through MCP, configuring `frick mcp`, inspecting live Frick runtime data, or adding safe MCP tools/resources/prompts.
---

# Frick MCP Runtime

Use MCP when an agent needs runtime context from a live Frick app. The Frick CLI owns startup:

```bash
frick mcp --endpoint http://127.0.0.1:4099
frick mcp --print-config --endpoint http://127.0.0.1:4099
```

Default mode is read-only. It exposes resources, tools, and prompts for schema identity, health/readiness, documented server/db/jobs inspection surfaces, stream pages, projection/debug context, and structured error explanation.

Guidance:
- Prefer MCP resources for context the agent should read: schema, health, readiness, server/db/jobs inspection, app spine, and stream pages.
- Prefer MCP tools for explicit actions: doctor, inspect server/db/jobs, read stream, explain error.
- Keep write tools behind `--allow-writes` and Frick auth/session/tenant checks.
- Do not bypass Frick authorization, tenant isolation, schema compatibility, or structured error envelopes.
- Do not expose raw SQL or private storage internals through MCP.
- Use `--tenant`, `--user`, and `--token` only for local/dev/admin contexts where the caller is allowed to inspect that scope.

When debugging, start with schema identity, Hello/HelloAck capabilities, session state, cursors, pending mutations, cache metadata, and structured errors.
