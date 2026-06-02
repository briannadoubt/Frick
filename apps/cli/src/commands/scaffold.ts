/**
 * `frick scaffold <kind> <name>` — append a stub to an already-initialized
 * app. Objects and streams use PascalCase names; projections use kebab-case.
 *
 * Objects and streams append a typed literal between the `// frick:objects`
 * or `// frick:streams` markers in `src/schema.ts`. Projections create a
 * new file under `src/projections/<name>.ts` and wire it into `src/server.ts`
 * via the `// frick:projections:imports` and `// frick:projections:register`
 * markers.
 *
 * All three subcommands are idempotent: a second call with the same name is
 * refused with exit 3 rather than silently duplicating.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ParsedArgs } from "../argv.js";
import { CliRefusedError, CliUsageError } from "../errors.js";
import { emit, type OutputOptions } from "../output.js";

const OBJECT_MARKER = "// frick:objects";
const STREAM_MARKER = "// frick:streams";
const PROJECTION_IMPORTS_MARKER = "// frick:projections:imports";
const PROJECTION_REGISTER_MARKER = "// frick:projections:register";

function resolveDirectory(parsed: ParsedArgs): string {
  const flag = parsed.flags.directory ?? parsed.flags.cwd;
  if (typeof flag === "string" && flag.length > 0) {
    return isAbsolute(flag) ? flag : resolve(process.cwd(), flag);
  }
  return process.cwd();
}

function requirePositional(parsed: ParsedArgs, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (!value) {
    throw new CliUsageError(`frick scaffold requires ${label}`);
  }
  return value;
}

function assertPascalCase(name: string, label: string): void {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    throw new CliUsageError(`${label} must be PascalCase, got ${JSON.stringify(name)}`);
  }
}

function assertKebabCase(name: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new CliUsageError(`${label} must be kebab-case, got ${JSON.stringify(name)}`);
  }
}

async function readSchemaFile(directory: string): Promise<{ path: string; body: string }> {
  const path = join(directory, "src", "schema.ts");
  if (!existsSync(path)) {
    throw new CliRefusedError(
      `No src/schema.ts found in ${directory}. Run 'frick init' first.`,
      { path },
    );
  }
  return { path, body: await readFile(path, "utf8") };
}

function insertAfterMarker(body: string, marker: string, insertion: string): string {
  const idx = body.indexOf(marker);
  if (idx < 0) {
    throw new CliRefusedError(`schema.ts is missing marker ${marker}`);
  }
  // Find end of the marker line, then insert insertion immediately after.
  const lineEnd = body.indexOf("\n", idx);
  if (lineEnd < 0) {
    throw new CliRefusedError(`schema.ts marker ${marker} not at start of a line`);
  }
  return `${body.slice(0, lineEnd + 1)}${insertion}${body.slice(lineEnd + 1)}`;
}

function nextNumericId(body: string, sectionLabel: "objects" | "streams"): number {
  // Heuristic: count existing entries by counting `id: <n>,` near the top of
  // each appended block. We keep IDs monotonic per-section by counting how
  // many of our stub markers appear. This is a deliberate shortcut — the
  // developer is expected to renumber if they care; the framework validates
  // identity at runtime.
  const re = new RegExp(`// frick:${sectionLabel}:id (\\d+)`, "g");
  let maxId = 0;
  for (const match of body.matchAll(re)) {
    const n = Number(match[1]);
    if (n > maxId) maxId = n;
  }
  return maxId + 1;
}

function objectStub(name: string, id: number): string {
  return `  // frick:objects:id ${id} ${name}
  {
    id: ${id},
    name: ${JSON.stringify(name)},
    fields: [
      { id: 1, name: "displayName", kind: "string", required: true },
    ],
    indexes: [{ id: 1, name: "all", fields: ["displayName"] }],
  },
`;
}

function streamStub(name: string, id: number): string {
  return `  // frick:streams:id ${id} ${name}
  {
    id: ${id},
    name: ${JSON.stringify(name)},
    keyFields: [{ id: 1, name: "key", kind: "string", required: true }],
    events: [],
  },
`;
}

function appendToArrayLiteral(body: string, sectionName: "objects" | "streams", insertion: string): string {
  // Find `<section>: [` and the matching `]` to splice insertion at its tail.
  const header = `${sectionName}: [`;
  const headerIdx = body.indexOf(header);
  if (headerIdx < 0) {
    throw new CliRefusedError(`schema.ts is missing '${header}' literal`);
  }
  // Find the matching closing bracket. The scaffolded schema uses simple
  // shallow arrays so naive scanning is sufficient; if a future template
  // nests brackets inside the section, this needs upgrading.
  let depth = 0;
  let i = headerIdx + header.length - 1; // position at the '['
  for (; i < body.length; i++) {
    const ch = body[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new CliRefusedError(`schema.ts '${sectionName}' literal is unbalanced`);
  }
  // Insert before the closing bracket. Add a leading newline if the array is
  // currently empty (i.e. literal "[]").
  const before = body.slice(0, i);
  const after = body.slice(i);
  const needsNewlineBefore = before.endsWith("[");
  const prefix = needsNewlineBefore ? "\n" : "";
  return `${before}${prefix}${insertion}${after}`;
}

function sectionContainsName(body: string, sectionLabel: "objects" | "streams", name: string): boolean {
  const re = new RegExp(`// frick:${sectionLabel}:id \\d+ ${name}\\b`);
  return re.test(body);
}

async function scaffoldObject(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const name = requirePositional(parsed, 1, "<Name> for the object");
  assertPascalCase(name, "object name");
  const directory = resolveDirectory(parsed);
  const { path, body } = await readSchemaFile(directory);
  if (sectionContainsName(body, "objects", name)) {
    throw new CliRefusedError(`Object ${name} already exists in schema.ts`, { path });
  }
  const id = nextNumericId(body, "objects");
  const next = appendToArrayLiteral(body, "objects", objectStub(name, id));
  await writeFile(path, next, "utf8");
  emit({ ok: true, kind: "object", name, id, path }, out);
  return 0;
}

async function scaffoldStream(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const name = requirePositional(parsed, 1, "<Name> for the stream");
  assertPascalCase(name, "stream name");
  const directory = resolveDirectory(parsed);
  const { path, body } = await readSchemaFile(directory);
  if (sectionContainsName(body, "streams", name)) {
    throw new CliRefusedError(`Stream ${name} already exists in schema.ts`, { path });
  }
  const id = nextNumericId(body, "streams");
  const next = appendToArrayLiteral(body, "streams", streamStub(name, id));
  await writeFile(path, next, "utf8");
  emit({ ok: true, kind: "stream", name, id, path }, out);
  return 0;
}

function projectionFile(name: string): string {
  // The handler is intentionally minimal — apps fill in apply()/rebuild() once
  // they know which stream they're consuming. We deliberately do not import
  // from @fricken/server here because that would pin the scaffolded app to a
  // single server-internal API surface; the developer wires the types when
  // they implement the handler.
  return `/**
 * Projection scaffold for "${name}". Wire this into your server via the
 * registry returned from createFrickServer.
 */
export function create${toPascalCase(name)}Projection() {
  return {
    name: ${JSON.stringify(name)},
    sources: [] as const,
    handler: {
      apply(_event: unknown, _ctx: unknown) {
        return { changes: [] as unknown[] };
      },
    },
  };
}
`;
}

function toPascalCase(kebab: string): string {
  return kebab
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

async function readServerFile(directory: string): Promise<{ path: string; body: string }> {
  const path = join(directory, "src", "server.ts");
  if (!existsSync(path)) {
    throw new CliRefusedError(
      `No src/server.ts found in ${directory}. Run 'frick init' first.`,
      { path },
    );
  }
  return { path, body: await readFile(path, "utf8") };
}

async function scaffoldProjection(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const name = requirePositional(parsed, 1, "<name> for the projection (kebab-case)");
  assertKebabCase(name, "projection name");
  const directory = resolveDirectory(parsed);

  const projectionPath = join(directory, "src", "projections", `${name}.ts`);
  if (existsSync(projectionPath)) {
    throw new CliRefusedError(`Projection file already exists: ${projectionPath}`, {
      path: projectionPath,
    });
  }

  const { path: serverPath, body: serverBody } = await readServerFile(directory);
  const factoryName = `create${toPascalCase(name)}Projection`;
  if (serverBody.includes(factoryName)) {
    throw new CliRefusedError(`Projection ${name} appears already registered in server.ts`, {
      path: serverPath,
    });
  }

  await mkdir(dirname(projectionPath), { recursive: true });
  await writeFile(projectionPath, projectionFile(name), "utf8");

  const importLine = `import { ${factoryName} } from "./projections/${name}.js";\n`;
  // The scaffolded server treats projections as opt-in: we emit a reference
  // so the import is not dead code, and a TODO so the developer wires the
  // factory into their app's projection registry when they're ready.
  const registerLine = `// TODO: register ${factoryName}() with your projection registry\nvoid ${factoryName};\n`;

  let nextServer = insertAfterMarker(serverBody, PROJECTION_IMPORTS_MARKER, importLine);
  nextServer = insertAfterMarker(nextServer, PROJECTION_REGISTER_MARKER, registerLine);
  await writeFile(serverPath, nextServer, "utf8");

  emit(
    {
      ok: true,
      kind: "projection",
      name,
      projectionPath,
      serverPath,
    },
    out,
  );
  return 0;
}

export async function scaffoldCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "object") return scaffoldObject(parsed, out);
  if (sub === "stream") return scaffoldStream(parsed, out);
  if (sub === "projection") return scaffoldProjection(parsed, out);
  throw new CliUsageError(`Unknown scaffold subcommand: ${sub ?? "<missing>"}`, {
    expected: ["object", "stream", "projection"],
  });
}
