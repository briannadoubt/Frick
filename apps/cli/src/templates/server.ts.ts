import type { TemplateVariables } from "./index.js";

/**
 * Scaffolded entry point. `createFrickServer` accepts an optional schema
 * override so apps can ship their own schema on top of Frick's empty
 * foundation. The scaffolded schema starts empty; until you add at least one
 * object/stream you'll be running only framework primitives.
 *
 * The `// frick:projections` marker is consumed by
 * `frick scaffold projection <name>` to inject `import` and `register(...)`
 * lines without re-parsing the file.
 */
export function renderServerTs(vars: TemplateVariables): string {
  return `import { createFrickServer } from "@frick/server";
import { schema } from "./schema.js";

// frick:projections:imports

const port = Number(process.env.PORT ?? ${vars.port});

const app = createFrickServer({ schema, port });

// frick:projections:register

await app.listen();
`;
}
