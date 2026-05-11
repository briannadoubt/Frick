import type { TemplateVariables } from "./index.js";

/**
 * Optional config file. The runtime treats every key as optional — this is
 * here so `frick doctor` can find a config to validate against and so the
 * developer has a visible place to override env-var-driven defaults.
 */
export function renderFrickConfigJson(vars: TemplateVariables): string {
  const body = {
    appName: vars.appName,
    port: vars.port,
    env: "development",
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
