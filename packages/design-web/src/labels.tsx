import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Localizable labels for the built-in component chrome (FR-103).
 *
 * Components render a handful of fixed strings the consumer can't pass in (e.g.
 * the workspace inspector's "Close" button). Rather than hard-code English,
 * those strings are read from this context so an app can localize them once at
 * the provider boundary. Every key has an English default, so wrapping in a
 * provider is optional and partial overrides are fine.
 *
 * This is a presentation-layer hook only — it has no bearing on the wire
 * protocol or component data.
 */
export interface FrickComponentLabels {
  /** Accessible/visible label for the workspace inspector close button. */
  closeInspector: string;
}

/** The built-in English labels. Always a complete fallback. */
export const defaultComponentLabels: FrickComponentLabels = {
  closeInspector: "Close",
};

const FrickLabelsContext = createContext<FrickComponentLabels>(defaultComponentLabels);

export interface FrickLabelsProviderProps {
  children: ReactNode;
  /**
   * Partial label overrides. Any key omitted falls through to the English
   * defaults, so apps only translate the labels they care about.
   */
  labels?: Partial<FrickComponentLabels>;
}

/**
 * Provide localized component labels to a subtree. Overrides are merged over the
 * English defaults, so passing `{ closeInspector: "Cerrar" }` localizes just
 * that label and leaves the rest in English.
 */
export function FrickLabelsProvider({ children, labels }: FrickLabelsProviderProps) {
  const value = useMemo<FrickComponentLabels>(
    () => (labels ? { ...defaultComponentLabels, ...labels } : defaultComponentLabels),
    [labels],
  );
  return <FrickLabelsContext.Provider value={value}>{children}</FrickLabelsContext.Provider>;
}

/** Read the active component labels (English defaults outside any provider). */
export function useComponentLabels(): FrickComponentLabels {
  return useContext(FrickLabelsContext);
}

/**
 * Resolve a single label, honoring an inline per-component override first, then
 * the labels context, then the English default. Components accept an optional
 * `label`-style prop for one-off overrides without a provider.
 */
export function resolveLabel(
  override: string | undefined,
  contextValue: string,
): string {
  return override ?? contextValue;
}
