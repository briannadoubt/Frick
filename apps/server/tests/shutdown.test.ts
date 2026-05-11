import { describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";

describe("graceful shutdown", () => {
  it("listen + close in quick succession resolves without errors", async () => {
    const server = createFrickServer({ port: 0, dbPath: ":memory:" });
    await server.listen();
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("close() is idempotent and safe to call twice", async () => {
    const server = createFrickServer({ port: 0, dbPath: ":memory:" });
    await server.listen();
    const first = server.close();
    const second = server.close();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it("does not leak 'server already closed' errors when called immediately after listen", async () => {
    // Spec-required minimum: listen + close in quick succession resolves
    // without surfacing the "Server is not running" sentinel from node:http.
    const server = createFrickServer({ port: 0, dbPath: ":memory:" });
    await server.listen();
    let caught: unknown;
    try {
      await server.close();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeUndefined();
  });
});
