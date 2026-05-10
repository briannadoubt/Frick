export type FrickMode = "light" | "dark";
export type FrickDensity = "compact" | "regular" | "comfortable";
export type FrickBrand = "frick" | "frickenChat";
export type FrickIconPack = "native" | "frick";
export type FrickPlatform = "web" | "ios" | "android";

export type TokenPrimitive = string | number | boolean | TokenAlias;
export type TokenTree = { readonly [key: string]: TokenPrimitive | TokenTree };

export interface TokenAlias {
  readonly $alias: string;
}

export interface IconMapping {
  readonly family: "lucide" | "sf" | "material" | "frick";
  readonly name: string;
}

export interface IconAliasDefinition {
  readonly web: IconMapping;
  readonly ios: IconMapping;
  readonly android: IconMapping;
  readonly fallback: IconMapping;
}

export interface FrickDesignDefinition {
  readonly primitive: TokenTree;
  readonly semantic: TokenTree;
  readonly density: Record<FrickDensity, TokenTree>;
  readonly modes: Record<FrickMode, TokenTree>;
  readonly brands: Record<FrickBrand, TokenTree>;
  readonly component: TokenTree;
  readonly icons: Record<string, IconAliasDefinition>;
}

export interface ResolveOptions {
  readonly mode: FrickMode;
  readonly density: FrickDensity;
  readonly brand: FrickBrand;
  readonly iconPack: FrickIconPack;
  readonly platform: FrickPlatform;
}

export interface ResolvedDesign {
  readonly options: ResolveOptions;
  readonly primitive: Record<string, unknown>;
  readonly semantic: Record<string, any>;
  readonly component: Record<string, any>;
  readonly icons: Record<string, IconMapping>;
}
