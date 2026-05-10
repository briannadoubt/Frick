import type { FrickDesignDefinition, TokenAlias } from "./model.js";

export function alias(path: string): TokenAlias {
  return { $alias: path };
}

export function defineDesign(definition: FrickDesignDefinition): FrickDesignDefinition {
  return definition;
}
