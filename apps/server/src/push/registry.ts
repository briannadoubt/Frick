/**
 * Adapter registry for the push framework. Mirrors the shape of
 * {@link FrickJobRegistry}: register at boot, resolve by string, throw on
 * duplicate registration. We deliberately fail loudly on duplicates because
 * silently shadowing an adapter is an easy way to mis-route real production
 * notifications — every minute of crash beats one customer notification sent
 * to the wrong adapter.
 */

import type { FrickPushAdapter } from "./types.js";

export interface FrickPushRegistry {
  registerAdapter(adapter: FrickPushAdapter): void;
  resolveAdapter(platform: string): FrickPushAdapter | undefined;
  list(): FrickPushAdapter[];
}

export class DuplicatePushAdapterError extends Error {
  readonly reason = "duplicatePushAdapter";
  constructor(readonly platform: string) {
    super(`A push adapter is already registered for platform "${platform}"`);
    this.name = "DuplicatePushAdapterError";
  }
}

export function createFrickPushRegistry(): FrickPushRegistry {
  const adapters = new Map<string, FrickPushAdapter>();
  return {
    registerAdapter(adapter) {
      if (adapters.has(adapter.platform)) {
        throw new DuplicatePushAdapterError(adapter.platform);
      }
      adapters.set(adapter.platform, adapter);
    },
    resolveAdapter(platform) {
      return adapters.get(platform);
    },
    list() {
      return Array.from(adapters.values()).sort((a, b) =>
        a.platform.localeCompare(b.platform),
      );
    },
  };
}
