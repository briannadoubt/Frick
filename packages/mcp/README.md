# @frick/mcp

MCP server for live Frick runtime inspection. It gives agent harnesses a
read-only way to inspect a running app without importing server internals.

The standard entrypoint for app developers is the Frick CLI:

```bash
frick mcp --endpoint http://127.0.0.1:4099
frick mcp --print-config --endpoint http://127.0.0.1:4099
```

Default mode is read-only. It exposes resources for health, readiness,
documented server/db/jobs inspection, and current schema identity; tools for
doctor, server/db/jobs inspection, stream reads, and structured-error
explanation; and prompts for runtime debugging. Mutating tools such as stream
append are unavailable unless the CLI starts MCP with `--allow-writes`.

Use `--tenant`, `--user`, and `--token` to scope runtime requests. Those values
must represent a caller that is allowed to inspect the target tenant or user;
the MCP layer should not bypass Frick auth, tenant isolation, schema
compatibility checks, or structured error envelopes.
