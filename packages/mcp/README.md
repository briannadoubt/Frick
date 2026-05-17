# @frick/mcp

MCP server for Frick runtime inspection.

The standard entrypoint for app developers is the Frick CLI:

```bash
frick mcp --endpoint http://127.0.0.1:4099
frick mcp --print-config --endpoint http://127.0.0.1:4099
```

Default mode is read-only. Mutating tools require explicit `--allow-writes`.
