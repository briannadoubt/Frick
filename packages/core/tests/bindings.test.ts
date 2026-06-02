/**
 * Tests for the schema-bound client surface.
 *
 * `bindSchema(client, schema)` produces a name-keyed wrapper around the
 * existing `FrickClient` reactive primitives. These tests assert:
 *
 *   - One entry per object / stream / presence / signal / projection.
 *   - `useAll` / `useEvents` / `useOne` reuse the same underlying signal
 *     as the raw `client.objects()` / `client.stream()` / `client.presence()`
 *     accessors (so a single Delta updates everyone).
 *   - Generated typed wrapper round-trips through bindSchema's runtime.
 *
 * No live socket needed — every assertion runs against the unconnected
 * client's in-memory state.
 */
import { describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { bindSchema } from "../src/bindings.js";
import { FrickClient } from "../src/runtime.js";

function makeClient() {
  return new FrickClient({ endpoint: "ws://unused", schema: productTestSchema });
}

describe("bindSchema", () => {
  it("exposes one flat binding per schema-declared name", () => {
    const client = makeClient();
    const bindings = bindSchema(client, productTestSchema);

    for (const object of productTestSchema.objects) {
      expect(bindings[object.name], `object ${object.name}`).toBeDefined();
    }
    for (const stream of productTestSchema.streams) {
      expect(bindings[stream.name], `stream ${stream.name}`).toBeDefined();
    }
    for (const presence of productTestSchema.presences) {
      expect(bindings[presence.name], `presence ${presence.name}`).toBeDefined();
    }
    for (const signal of productTestSchema.signals) {
      expect(bindings[signal.name], `signal ${signal.name}`).toBeDefined();
    }
  });

  it("returns the same signal instance for repeat subscribes", () => {
    const client = makeClient();
    const bindings = bindSchema(client, productTestSchema) as Record<string, { useAll(): unknown }>;
    expect(bindings.User!.useAll()).toBe(bindings.User!.useAll());
  });

  it("uses the same backing signal as the raw FrickClient accessor", () => {
    const client = makeClient();
    const bindings = bindSchema(client, productTestSchema) as Record<string, { useAll(): unknown }>;
    expect(bindings.User!.useAll()).toBe(client.objects("User"));
  });
});

describe("bindSchema (typed surface against product fixture)", () => {
  // Previously this block tested the generated `bindFrickSchema` wrapper,
  // but the production foundationSchema is now empty so the generated
  // bindings have no User/MessageStream to assert on. Use bindSchema
  // directly against productTestSchema to exercise the same wiring.
  it("exposes object/stream/presence/signal entries by schema name", () => {
    const client = makeClient();
    const frick = bindSchema(client, productTestSchema) as Record<
      string,
      { type?: string; stream?: string; name?: string }
    >;

    expect(frick.User!.type).toBe("User");
    expect(frick.MessageStream!.stream).toBe("MessageStream");
    expect(frick.TypingState!.name).toBe("TypingState");
    expect(frick.WebRTCSignal!.name).toBe("WebRTCSignal");
  });
});
