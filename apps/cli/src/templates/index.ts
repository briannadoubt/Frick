/**
 * Template entry point. Each template returns the file contents as a string
 * given a {@link TemplateVariables} record. Templates are intentionally inline
 * TypeScript template literals (rather than separate `.tpl` files on disk) so
 * the build pipeline doesn't need to ship a `templates/` data directory next
 * to the compiled JS — `tsc` already emits everything we need.
 *
 * Templates are versioned with the framework: `frick init` always produces a
 * layout compatible with the `@frick/server` version that ships in the same
 * monorepo cut. We do not promise forward compatibility with older `@frick/*`
 * releases.
 */
export { renderPackageJson } from "./package.json.js";
export { renderTsconfigJson } from "./tsconfig.json.js";
export { renderSchemaTs } from "./schema.ts.js";
export { renderServerTs } from "./server.ts.js";
export { renderSmokeTestTs } from "./smoke.test.ts.js";
export { renderFrickConfigJson } from "./frick.config.json.js";

export interface TemplateVariables {
  /** Application name; lands in package.json `name` and the schema identity. */
  appName: string;
  /** Default port for the scaffolded server. */
  port: number;
  /** Version string used for both the app and the `@frick/*` dependency pins. */
  version: string;
}
