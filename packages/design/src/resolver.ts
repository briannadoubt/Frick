import type {
  FrickDesignDefinition,
  IconMapping,
  ResolveOptions,
  ResolvedDesign,
  TokenAlias,
  TokenTree,
} from "./model.js";

export function resolveDesign(definition: FrickDesignDefinition, options: ResolveOptions): ResolvedDesign {
  const source = mergeTrees(
    {
      primitive: definition.primitive,
      semantic: definition.semantic,
      component: definition.component,
    },
    definition.density[options.density] ?? {},
    definition.modes[options.mode] ?? {},
    definition.brands[options.brand] ?? {},
  );
  const resolver = createAliasResolver(source);

  return {
    options,
    primitive: resolver.resolveTree(source.primitive as TokenTree),
    semantic: resolver.resolveTree(source.semantic as TokenTree),
    component: resolver.resolveTree(source.component as TokenTree),
    icons: resolveIcons(definition, options),
  };
}

function resolveIcons(definition: FrickDesignDefinition, options: ResolveOptions): Record<string, IconMapping> {
  return Object.fromEntries(
    Object.entries(definition.icons).map(([name, mapping]) => [
      name,
      options.iconPack === "native" ? mapping[options.platform] : mapping.fallback,
    ]),
  );
}

function createAliasResolver(root: TokenTree) {
  const resolvePath = (path: string, seen: string[] = []): unknown => {
    if (path.startsWith("icon.")) {
      return path.slice("icon.".length);
    }
    if (seen.includes(path)) {
      throw new Error(`Circular alias ${[...seen, path].join(" -> ")}`);
    }
    const value = getPath(root, path);
    if (value === undefined) {
      throw new Error(`Unresolved alias ${path}`);
    }
    if (isAlias(value)) {
      return resolvePath(value.$alias, [...seen, path]);
    }
    if (isTokenTree(value)) {
      return resolveTree(value, [...seen, path]);
    }
    return value;
  };

  const resolveTree = (tree: TokenTree, seen: string[] = []): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(tree).map(([key, value]) => {
        if (isAlias(value)) {
          return [key, resolvePath(value.$alias, seen)];
        }
        if (isTokenTree(value)) {
          return [key, resolveTree(value, seen)];
        }
        return [key, value];
      }),
    );

  return { resolveTree };
}

function getPath(root: TokenTree, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (isTokenTree(current) && segment in current) {
      return current[segment];
    }
    return undefined;
  }, root);
}

export function mergeTrees(...trees: TokenTree[]): TokenTree {
  const output: Record<string, unknown> = {};
  for (const tree of trees) {
    for (const [key, value] of Object.entries(tree)) {
      const existing = output[key];
      output[key] = isTokenTree(existing) && isTokenTree(value) ? mergeTrees(existing, value) : value;
    }
  }
  return output as TokenTree;
}

function isAlias(value: unknown): value is TokenAlias {
  return isTokenTree(value) && "$alias" in value && typeof value.$alias === "string";
}

function isTokenTree(value: unknown): value is TokenTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
