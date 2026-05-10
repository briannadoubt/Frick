import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import { frickTokens } from "./generated/tokens.js";

export type FrickDesignMode = "light" | "dark" | "system" | (string & {});
export type FrickDesignDensity = "comfortable" | "compact" | (string & {});
export type FrickDesignBrand = "frick" | (string & {});
export type FrickDesignIconPack = "lucide" | (string & {});

export interface FrickDesignRuntime {
  mode: FrickDesignMode;
  density: FrickDesignDensity;
  brand: FrickDesignBrand;
  iconPack: FrickDesignIconPack;
  tokens: typeof frickTokens;
}

export interface FrickDesignProviderProps {
  children: ReactNode;
  mode?: FrickDesignMode;
  density?: FrickDesignDensity;
  brand?: FrickDesignBrand;
  iconPack?: FrickDesignIconPack;
  className?: string;
  style?: CSSProperties;
}

const defaultRuntime: FrickDesignRuntime = {
  mode: "light",
  density: "comfortable",
  brand: "frick",
  iconPack: "lucide",
  tokens: frickTokens,
};

const FrickDesignContext = createContext<FrickDesignRuntime>(defaultRuntime);

export function FrickDesignProvider({
  children,
  mode = defaultRuntime.mode,
  density = defaultRuntime.density,
  brand = defaultRuntime.brand,
  iconPack = defaultRuntime.iconPack,
  className,
  style,
}: FrickDesignProviderProps) {
  const value = useMemo(
    () => ({ mode, density, brand, iconPack, tokens: frickTokens }),
    [brand, density, iconPack, mode],
  );
  const classes = ["frick-design", className].filter(Boolean).join(" ");

  return (
    <FrickDesignContext.Provider value={value}>
      <div
        className={classes}
        data-frick-mode={mode}
        data-frick-density={density}
        data-frick-brand={brand}
        data-frick-icon-pack={iconPack}
        style={style}
      >
        {children}
      </div>
    </FrickDesignContext.Provider>
  );
}

export function useFrickDesign(): FrickDesignRuntime {
  return useContext(FrickDesignContext);
}
