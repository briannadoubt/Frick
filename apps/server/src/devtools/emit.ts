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
  // Best-effort + fire-and-forget: recording is async now (the store may be
  // Postgres-backed), but emission sites must never await or throw. record()
  // already swallows its own errors; the .catch() here is belt-and-suspenders
  // against an unexpected rejection so it can never surface as unhandled.
  void store.devtoolsEvents
    .record({
      kind: input.kind,
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.fields !== undefined ? { fields: input.fields } : {}),
    })
    .catch(() => {
      // Best-effort — never break the caller.
    });
}
