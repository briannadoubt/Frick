/**
 * Tiny helper around {@link DevToolsEventStore.record} so emission sites stay
 * one-liners. Centralising the try/catch means a single weird payload never
 * tears down the originating handler — recording to the DevTools feed is
 * always best-effort.
 */
import type { FrickStore } from "../store.js";

export interface DevToolsEmitInput {
  readonly kind: string;
  readonly tenantId?: string | undefined;
  readonly fields?: Record<string, unknown>;
}

export function emitDevToolsEvent(store: FrickStore, input: DevToolsEmitInput): void {
  try {
    store.devtoolsEvents.record({
      kind: input.kind,
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.fields !== undefined ? { fields: input.fields } : {}),
    });
  } catch {
    // Best-effort — never break the caller.
  }
}
