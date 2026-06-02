import type { TemplateVariables } from "./index.js";

/**
 * Minimal scaffolded schema. Objects and streams start empty — the developer
 * grows the schema via `frick scaffold object <Name>` and `frick scaffold
 * stream <Name>`, both of which append to this file between the
 * `// frick:objects` / `// frick:streams` markers.
 *
 * The identity fields (`schemaId`, `schemaVersion`, `schemaRevision`) anchor
 * the schema across runs; bump `schemaRevision` whenever you ship a structural
 * change. `hash` is recomputed by the framework on validate, so the literal
 * "scaffold" is a placeholder the runtime will not read.
 */
export function renderSchemaTs(vars: TemplateVariables): string {
  return `import type { FrickSchema } from "@fricken/protocol";

export const schema: FrickSchema = {
  name: ${JSON.stringify(vars.appName)},
  schemaId: ${JSON.stringify(vars.appName)},
  schemaVersion: ${JSON.stringify(vars.version)},
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "scaffold",
  // frick:objects
  objects: [],
  // frick:streams
  streams: [],
  events: [],
  presences: [],
  signals: [],
  blobs: [],
  jobs: [],
  projections: [],
};
`;
}
