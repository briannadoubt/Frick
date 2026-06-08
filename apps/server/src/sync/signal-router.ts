import { FrameKind, packSignalEnvelope, type SignalPayload } from "@fricken/protocol";
import { sendFrame } from "./wire.js";
import { DEFAULT_APP_ID } from "../app-id.js";
import type { FrickStore } from "../store.js";
import type { SubscriptionRegistry } from "./subscriptions.js";

export async function routeSignal(
  store: FrickStore,
  subscriptions: SubscriptionRegistry,
  payload: SignalPayload,
  tenantId: string,
  options: { maxBufferedAmount?: number } = {},
  appId: string = DEFAULT_APP_ID,
): Promise<void> {
  if ((await store.tenants.get(tenantId))?.archivedAt !== undefined) {
    return;
  }
  const envelope = packSignalEnvelope(store.schema, payload.name, payload.key, payload.value);
  for (const { client } of subscriptions.signalSubscribers(payload.name, payload.key)) {
    if (!client.principal || client.principal.tenantId !== tenantId) {
      continue;
    }
    // App isolation (FR-153): never deliver a signal to a subscriber pinned to
    // a different app. `client.appId` is set at Hello; default for single-app.
    if ((client.appId ?? DEFAULT_APP_ID) !== appId) {
      continue;
    }
    sendFrame(client.socket, [FrameKind.SignalDeliver, { envelope }], options);
  }
}
