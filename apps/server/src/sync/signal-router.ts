import { FrameKind, packSignalEnvelope, type SignalPayload } from "@frick/protocol";
import { sendFrame } from "./wire.js";
import type { FrickStore } from "../store.js";
import type { SubscriptionRegistry } from "./subscriptions.js";

export function routeSignal(
  store: FrickStore,
  subscriptions: SubscriptionRegistry,
  payload: SignalPayload,
): void {
  const envelope = packSignalEnvelope(store.schema, payload.name, payload.key, payload.value);
  for (const { client } of subscriptions.signalSubscribers(payload.name, payload.key)) {
    sendFrame(client.socket, [FrameKind.SignalDeliver, { envelope }]);
  }
}
