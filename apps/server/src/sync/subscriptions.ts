import type { WebSocket } from "ws";
import type { Principal } from "../authz.js";
import type { SubscribePayload } from "@fricken/protocol";

export interface SyncClient {
  socket: WebSocket;
  subscriptions: Map<string, SubscribePayload>;
  principal?: Principal;
  sessionToken?: string;
  /**
   * Storage app id this connection is routed to (FR-153). Resolved at Hello
   * from the advertised schemaId against the app registry, mirroring how
   * `principal.tenantId` pins the tenant. Defaults to `_default` (single-app
   * servers and pre-Hello connections) so every store call this connection
   * makes is partitioned by the originating app.
   */
  appId?: string;
}

export class SubscriptionRegistry {
  readonly #clients = new Set<SyncClient>();

  addClient(client: SyncClient): void {
    this.#clients.add(client);
  }

  removeClient(client: SyncClient): void {
    this.#clients.delete(client);
  }

  addSubscription(client: SyncClient, payload: SubscribePayload): void {
    client.subscriptions.set(payload.subscriptionId, payload);
  }

  streamSubscribers(stream: string, key: string): Array<{ client: SyncClient; subscription: SubscribePayload }> {
    return this.matching((subscription) => subscription.kind === "stream" && subscription.name === stream && subscription.key === key);
  }

  objectSubscribers(type: string): Array<{ client: SyncClient; subscription: SubscribePayload }> {
    return this.matching((subscription) => subscription.kind === "object" && subscription.name === type);
  }

  presenceSubscribers(name: string, key: string): Array<{ client: SyncClient; subscription: SubscribePayload }> {
    return this.matching((subscription) => subscription.kind === "presence" && subscription.name === name && subscription.key === key);
  }

  signalSubscribers(name: string, key: string): Array<{ client: SyncClient; subscription: SubscribePayload }> {
    return this.matching((subscription) => subscription.kind === "signal" && subscription.name === name && subscription.key === key);
  }

  projectionSubscribers(name: string): Array<{ client: SyncClient; subscription: SubscribePayload }> {
    // Projection subscriptions are coarse-grained today: a subscriber gets
    // every row change for the projection. The optional `key` is reserved
    // for future per-row scoping (e.g. feed-row-for-this-user) but is not
    // enforced here.
    return this.matching((subscription) => subscription.kind === "projection" && subscription.name === name);
  }

  closeAll(): void {
    for (const client of this.#clients) {
      client.socket.terminate();
    }
    this.#clients.clear();
  }

  private matching(
    predicate: (subscription: SubscribePayload) => boolean,
  ): Array<{ client: SyncClient; subscription: SubscribePayload }> {
    const matches: Array<{ client: SyncClient; subscription: SubscribePayload }> = [];
    for (const client of this.#clients) {
      for (const subscription of client.subscriptions.values()) {
        if (predicate(subscription)) {
          matches.push({ client, subscription });
        }
      }
    }
    return matches;
  }
}
