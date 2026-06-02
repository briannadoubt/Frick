import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { frickTokens } from "./generated/tokens.js";

/**
 * Runtime design context axes.
 *
 * These mirror the canonical `@fricken/design` model. Each axis accepts the
 * well-known values plus any custom string, so apps can register their own
 * brands / icon packs without changing this package. Custom values fall back
 * to the package defaults at the CSS layer (see `tokens.css`).
 */
export type FrickDesignMode = "system" | "light" | "dark" | (string & {});
export type FrickDesignDensity = "compact" | "regular" | "comfortable" | (string & {});
export type FrickDesignBrand = "frick" | "frickenChat" | "custom" | (string & {});
export type FrickDesignIconPack = "native" | "frick" | "custom" | (string & {});

/** Resolved, read-only view of the active design context. */
export interface FrickDesignRuntime {
  readonly mode: FrickDesignMode;
  readonly density: FrickDesignDensity;
  readonly brand: FrickDesignBrand;
  readonly iconPack: FrickDesignIconPack;
  /**
   * The `data-frick-*` attributes that select the matching CSS custom-property
   * block in `tokens.css`. Exposed so consumers can apply the active context to
   * their own DOM subtrees (e.g. portals rendered outside the provider).
   */
  readonly dataAttributes: FrickDesignDataAttributes;
  /** Static token metadata generated from the canonical design definition. */
  readonly tokens: typeof frickTokens;
  /** Switch one or more axes at runtime. No-op when the provider is controlled. */
  readonly setDesignContext: (next: Partial<FrickDesignAxes>) => void;
  readonly setMode: (mode: FrickDesignMode) => void;
  readonly setDensity: (density: FrickDesignDensity) => void;
  readonly setBrand: (brand: FrickDesignBrand) => void;
  readonly setIconPack: (iconPack: FrickDesignIconPack) => void;
}

export interface FrickDesignAxes {
  mode: FrickDesignMode;
  density: FrickDesignDensity;
  brand: FrickDesignBrand;
  iconPack: FrickDesignIconPack;
}

export interface FrickDesignDataAttributes {
  "data-frick-mode": FrickDesignMode;
  "data-frick-density": FrickDesignDensity;
  "data-frick-brand": FrickDesignBrand;
  "data-frick-icon-pack": FrickDesignIconPack;
}

export interface FrickDesignProviderProps {
  children: ReactNode;
  /** Controlled mode. When omitted, the provider manages mode internally. */
  mode?: FrickDesignMode;
  /** Controlled density. When omitted, the provider manages density internally. */
  density?: FrickDesignDensity;
  /** Controlled brand. When omitted, the provider manages brand internally. */
  brand?: FrickDesignBrand;
  /** Controlled icon pack. When omitted, the provider manages it internally. */
  iconPack?: FrickDesignIconPack;
  /** Initial mode for the uncontrolled case. */
  defaultMode?: FrickDesignMode;
  /** Initial density for the uncontrolled case. */
  defaultDensity?: FrickDesignDensity;
  /** Initial brand for the uncontrolled case. */
  defaultBrand?: FrickDesignBrand;
  /** Initial icon pack for the uncontrolled case. */
  defaultIconPack?: FrickDesignIconPack;
  /** Notified whenever the active context changes (controlled or not). */
  onDesignContextChange?: (next: FrickDesignAxes) => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * The package default context. These match the `:root` block emitted by
 * `tokens.css` (light / regular / frick / native), i.e. the values produced by
 * `pnpm design:generate` for the default web artifact.
 */
export const defaultFrickDesignAxes: FrickDesignAxes = {
  mode: "light",
  density: "regular",
  brand: "frick",
  iconPack: "native",
};

/** Map an axes object to the `data-frick-*` attributes that select a token block. */
export function dataAttributesFor(axes: FrickDesignAxes): FrickDesignDataAttributes {
  return {
    "data-frick-mode": axes.mode,
    "data-frick-density": axes.density,
    "data-frick-brand": axes.brand,
    "data-frick-icon-pack": axes.iconPack,
  };
}

/**
 * Pure runtime-switch reducer: apply a partial axes change, honoring which axes
 * are controlled (controlled axes are never mutated by setters). Exposed so the
 * runtime-switch semantics are testable without a DOM.
 */
export function mergeDesignAxes(
  current: FrickDesignAxes,
  next: Partial<FrickDesignAxes>,
  controlled: Partial<Record<keyof FrickDesignAxes, boolean>> = {},
): FrickDesignAxes {
  return {
    mode: controlled.mode ? current.mode : next.mode ?? current.mode,
    density: controlled.density ? current.density : next.density ?? current.density,
    brand: controlled.brand ? current.brand : next.brand ?? current.brand,
    iconPack: controlled.iconPack ? current.iconPack : next.iconPack ?? current.iconPack,
  };
}

const noop = () => undefined;

const FrickDesignContext = createContext<FrickDesignRuntime>({
  ...defaultFrickDesignAxes,
  dataAttributes: dataAttributesFor(defaultFrickDesignAxes),
  tokens: frickTokens,
  setDesignContext: noop,
  setMode: noop,
  setDensity: noop,
  setBrand: noop,
  setIconPack: noop,
});

export function FrickDesignProvider({
  children,
  mode,
  density,
  brand,
  iconPack,
  defaultMode = defaultFrickDesignAxes.mode,
  defaultDensity = defaultFrickDesignAxes.density,
  defaultBrand = defaultFrickDesignAxes.brand,
  defaultIconPack = defaultFrickDesignAxes.iconPack,
  onDesignContextChange,
  className,
  style,
}: FrickDesignProviderProps) {
  // Uncontrolled state seeds from the `default*` props. Controlled props, when
  // provided, always win over internal state on each render.
  const [uncontrolled, setUncontrolled] = useState<FrickDesignAxes>({
    mode: defaultMode,
    density: defaultDensity,
    brand: defaultBrand,
    iconPack: defaultIconPack,
  });

  const axes: FrickDesignAxes = {
    mode: mode ?? uncontrolled.mode,
    density: density ?? uncontrolled.density,
    brand: brand ?? uncontrolled.brand,
    iconPack: iconPack ?? uncontrolled.iconPack,
  };

  const isControlled = {
    mode: mode !== undefined,
    density: density !== undefined,
    brand: brand !== undefined,
    iconPack: iconPack !== undefined,
  };

  const setDesignContext = useCallback(
    (next: Partial<FrickDesignAxes>) => {
      // Only mutate axes that the provider actually owns (uncontrolled ones).
      setUncontrolled((current) => mergeDesignAxes(current, next, isControlled));
      onDesignContextChange?.({
        mode: next.mode ?? axes.mode,
        density: next.density ?? axes.density,
        brand: next.brand ?? axes.brand,
        iconPack: next.iconPack ?? axes.iconPack,
      });
    },
    [
      axes.mode,
      axes.density,
      axes.brand,
      axes.iconPack,
      isControlled.mode,
      isControlled.density,
      isControlled.brand,
      isControlled.iconPack,
      onDesignContextChange,
    ],
  );

  const setMode = useCallback((next: FrickDesignMode) => setDesignContext({ mode: next }), [setDesignContext]);
  const setDensity = useCallback(
    (next: FrickDesignDensity) => setDesignContext({ density: next }),
    [setDesignContext],
  );
  const setBrand = useCallback((next: FrickDesignBrand) => setDesignContext({ brand: next }), [setDesignContext]);
  const setIconPack = useCallback(
    (next: FrickDesignIconPack) => setDesignContext({ iconPack: next }),
    [setDesignContext],
  );

  const dataAttributes = useMemo(() => dataAttributesFor(axes), [axes.mode, axes.density, axes.brand, axes.iconPack]);

  const value = useMemo<FrickDesignRuntime>(
    () => ({
      mode: axes.mode,
      density: axes.density,
      brand: axes.brand,
      iconPack: axes.iconPack,
      dataAttributes,
      tokens: frickTokens,
      setDesignContext,
      setMode,
      setDensity,
      setBrand,
      setIconPack,
    }),
    [
      axes.mode,
      axes.density,
      axes.brand,
      axes.iconPack,
      dataAttributes,
      setDesignContext,
      setMode,
      setDensity,
      setBrand,
      setIconPack,
    ],
  );

  const classes = ["frick-design", className].filter(Boolean).join(" ");

  return (
    <FrickDesignContext.Provider value={value}>
      <div className={classes} {...dataAttributes} style={style}>
        {children}
      </div>
    </FrickDesignContext.Provider>
  );
}

/** Read (and mutate) the active runtime design context. */
export function useDesignContext(): FrickDesignRuntime {
  return useContext(FrickDesignContext);
}

/**
 * Back-compat alias for {@link useDesignContext}. Existing call sites and the
 * `<FrickDesignProvider>` naming use this; prefer `useDesignContext` for new code.
 */
export function useFrickDesign(): FrickDesignRuntime {
  return useDesignContext();
}
