import { frickDesignDefinition } from "../frick.design.js";
import type { FrickBrand, FrickDensity, FrickIconPack, FrickMode, FrickPlatform, ResolvedDesign } from "../model.js";
import { resolveDesign } from "../resolver.js";

export interface DesignArtifact {
  readonly resolved: Record<string, ResolvedDesign>;
}

export function generateJsonArtifact(): DesignArtifact {
  const modes: FrickMode[] = ["light", "dark"];
  const densities: FrickDensity[] = ["compact", "regular", "comfortable"];
  const brands: FrickBrand[] = ["frick", "frickenChat"];
  const iconPacks: FrickIconPack[] = ["native", "frick"];
  const platforms: FrickPlatform[] = ["web", "ios", "android"];
  const resolved: Record<string, ResolvedDesign> = {};

  for (const platform of platforms) {
    for (const mode of modes) {
      for (const density of densities) {
        for (const brand of brands) {
          for (const iconPack of iconPacks) {
            const key = `${platform}.${mode}.${density}.${brand}.${iconPack}`;
            resolved[key] = resolveDesign(frickDesignDefinition, {
              mode,
              density,
              brand,
              iconPack,
              platform,
            });
          }
        }
      }
    }
  }

  return { resolved };
}
