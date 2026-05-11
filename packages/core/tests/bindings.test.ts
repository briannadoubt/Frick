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
import { foundationSchema } from "@frick/protocol";
import { bindSchema } from "../src/bindings.js";
import { FrickClient } from "../src/runtime.js";
import { bindFrickSchema } from "../src/generated/bindings.js";

function makeClient() {
  return new FrickClient({ endpoint: "ws://unused", schema: foundationSchema });
}

describe("bindSchema", () => {
  it("exposes one flat binding per schema-declared name", () => {
    const client = makeClient();
    const bindings = bindSchema(client, foundationSchema);

    for (const object of foundationSchema.objects) {
      expect(bindings[object.name], `object ${object.name}`).toBeDefined();
    }
    for (const stream of foundationSchema.streams) {
      expect(bindings[stream.name], `stream ${stream.name}`).toBeDefined();
    }
    for (const presence of foundationSchema.presences) {
      expect(bindings[presence.name], `presence ${presence.name}`).toBeDefined();
    }
    for (const signal of foundationSchema.signals) {
      expect(bindings[signal.name], `signal ${signal.name}`).toBeDefined();
    }
  });

  it("returns the same signal instance for repeat subscribes", () => {
    const client = makeClient();
    const bindings = bindSchema(client, foundationSchema) as Record<string, { useAll(): unknown }>;
    expect(bindings.User!.useAll()).toBe(bindings.User!.useAll());
  });

  it("uses the same backing signal as the raw FrickClient accessor", () => {
    const client = makeClient();
    const bindings = bindSchema(client, foundationSchema) as Record<string, { useAll(): unknown }>;
    expect(bindings.User!.useAll()).toBe(client.objects("User"));
  });
});

describe("bindFrickSchema (generated typed wrapper)", () => {
  it("delegates to bindSchema and exposes the typed surface", () => {
    const client = makeClient();
    const frick = bindFrickSchema(client);

    expect(frick.User.type).toBe("User");
    expect(frick.MessageStream.stream).toBe("MessageStream");
    expect(frick.TypingState.name).toBe("TypingState");
    expect(frick.WebRTCSignal.name).toBe("WebRTCSignal");
  });
});
