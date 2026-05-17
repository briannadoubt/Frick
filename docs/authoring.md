# App Authoring

This guide is for developers building a Frick application. If you instead need
to operate an existing app, see [operations.md](./operations.md).

The Frick CLI ships a `frick init` and `frick scaffold` set of commands so a
developer can go from zero to a running app in two commands:

```
frick init my-app
cd my-app && pnpm dev
```

For agent-assisted app builds, ask `init` to install the Frick Agent Kit and
emit an MCP config in one step:

```
frick init my-app --agents all --mcp
```

You can also install or refresh the kit later:

```
pnpm dlx @frick/agent-kit install --all --target .
```

The kit adds Codex, Claude Code, and Cursor skills/subagents, Cursor rules,
and `docs/frick/spine.md`, a shared contract that backend and platform agents
read before splitting work.

When an agent needs live runtime context from the app it is building, start the
CLI-owned MCP server:

```
frick mcp --endpoint http://127.0.0.1:4099
```

Use `frick mcp --print-config` to emit a machine-readable stdio config for
agent harnesses. The MCP server is read-only by default.

## Getting Started

`frick init <directory>` scaffolds a new Frick application at the given path.

```
frick init my-app --port 4099 --name my-app --version 0.1.0
```

Flags:

| Flag                  | Default              | Notes                                                                 |
| --------------------- | -------------------- | --------------------------------------------------------------------- |
| `--name <name>`       | basename of `<dir>`  | Lands in `package.json#name` and the schema's `name` / `schemaId`.    |
| `--port <port>`       | `4099`               | Default port the scaffolded server listens on.                        |
| `--version <ver>`     | `0.1.0`              | Used for the app version and the scaffolded schema's `schemaVersion`. |
| `--no-install`        | install runs by default | Skip `pnpm install`. Useful for tests and CI prep.                 |
| `--skip-schema-check` | check runs           | Skip the in-process schema validation that runs after scaffolding.    |
| `--agents <value>`    | unset                | Install Frick Agent Kit surfaces. Use `all`, `none`, or a comma-separated subset of `codex,claude,cursor`. |
| `--mcp`               | unset                | Include read-only `frick mcp` stdio config in the final JSON output. |

`init` refuses to overwrite an existing file in the target directory — it is
strictly for fresh scaffolds, not migration. After files are written, unless
`--no-install` was passed, the CLI shells out to `pnpm install`, and unless
`--skip-schema-check` was passed it then runs an in-process
`frick schema check` against the scaffolded schema's identity fields. The
final JSON record summarizes which files were created and the result of both
follow-up steps.

## Expected directory structure

```
my-app/
├── package.json          # name, version, scripts, @frick/* dependencies
├── tsconfig.json         # standard strict TS config, ESNext modules
├── frick.config.json     # optional, overrides FRICK_* env vars
├── src/
│   ├── schema.ts         # exports `schema: FrickSchema`
│   └── server.ts         # imports schema, calls createFrickServer({ schema, port })
└── tests/
    └── smoke.test.ts     # boots the server in-process, asserts /health returns 200
```

`src/schema.ts` contains marker comments (`// frick:objects`,
`// frick:streams`) and `src/server.ts` contains marker comments
(`// frick:projections:imports`, `// frick:projections:register`). The
scaffold commands locate these markers when appending new declarations —
don't delete the markers or scaffold will refuse to extend the file.

## How the scaffolded server connects to the framework

The scaffolded `src/server.ts` is a thin module that imports `createFrickServer`
from `@frick/server` and passes it the schema you author in `src/schema.ts`.
Everything else — HTTP routes, the SQLite store, the sync gateway, the
projection registry, the auth surface — is owned by the framework. That keeps
the app source narrow: the developer's job is to declare schema objects and
streams (and optionally a projection or two), and the framework wires the rest.
Read the boundaries doc at [framework-boundaries.md](./framework-boundaries.md)
for the full ownership map.

## Next steps

Once you have an app skeleton, grow it with the `scaffold` family:

- `frick scaffold object <Name>` — append a PascalCase object type stub to
  `src/schema.ts`. Idempotent — refuses to add a duplicate.
- `frick scaffold stream <Name>` — same, but for streams.
- `frick scaffold projection <name>` — kebab-case projection name; creates a
  new file under `src/projections/<name>.ts` and wires it into `src/server.ts`
  via the projection markers.

Search indexes registered through `createFrickServer({ search: { indexes } })`
are indexed by the framework, but query access is conservative. The built-in
`messages-fts` index and indexes whose source is a foundation primitive with
framework visibility checks keep tenant-user access. Indexes over custom app
objects, streams, or projections require an explicit `policyHooks` allow for
the `search.query` action before tenant users can query them; admin principals
can still query for inspection and operations.

For schema evolution and the migration story, see
[operations.md](./operations.md#backup-and-restore) and the framework
hardening spec in `internal/`.

## Templates evolution

The templates are inlined as TypeScript modules under
`apps/cli/src/templates/` and are versioned with the framework — running
`frick init` always produces a layout compatible with the current
`@frick/server` cut. We do not promise forward compatibility with older
`@frick/*` releases. To upgrade an existing scaffold, bump the dependency
pins in your app's `package.json` and re-run `frick schema check` to catch
any drift; we do not currently ship an automatic re-scaffold path.
