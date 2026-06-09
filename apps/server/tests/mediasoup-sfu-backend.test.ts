import { describe, expect, it } from "vitest";

import {
  MediasoupSfuBackend,
  type MediasoupRouter,
  type MediasoupWorker,
} from "../src/calls/index.js";

/**
 * Stability regression tests for {@link MediasoupSfuBackend} (sfu-media-5,
 * sfu-media-6). mediasoup itself is never built/imported — an injected
 * `createWorker` factory returns a deterministic fake worker so the worker-init
 * retry and 'died'-handler paths are exercisable on the test path.
 */

function fakeRouter(id: string): MediasoupRouter {
  return {
    id,
    rtpCapabilities: { codecs: [] },
    canConsume: () => true,
    createWebRtcTransport: async () => {
      throw new Error("not used in these tests");
    },
    close: () => {},
  };
}

interface FakeWorker extends MediasoupWorker {
  emitDied(): void;
}

function fakeWorker(): FakeWorker {
  let routerSeq = 0;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    createRouter: async () => fakeRouter(`router-${++routerSeq}`),
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    close() {},
    emitDied() {
      for (const listener of listeners.get("died") ?? []) {
        listener();
      }
    },
  };
}

describe("MediasoupSfuBackend stability", () => {
  // sfu-media-5
  it("does not cache a rejected worker-init promise — retries after a transient failure", async () => {
    let attempts = 0;
    const backend = new MediasoupSfuBackend({
      mediaCodecs: [],
      createWorker: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient: ENOMEM");
        }
        return fakeWorker();
      },
    });

    // First ensureRouter triggers a worker init that fails.
    await expect(backend.ensureRouter("call-1")).rejects.toThrow(/transient/);
    expect(attempts).toBe(1);

    // A second attempt must retry a *fresh* worker rather than re-awaiting the
    // cached rejection — the backend is not permanently bricked.
    const router = await backend.ensureRouter("call-1");
    expect(router.id).toBe("router-1");
    expect(attempts).toBe(2);
  });

  // sfu-media-6
  it("drops the worker + its routers when the worker 'died' event fires", async () => {
    const workers: FakeWorker[] = [];
    const backend = new MediasoupSfuBackend({
      mediaCodecs: [],
      createWorker: async () => {
        const w = fakeWorker();
        workers.push(w);
        return w;
      },
    });

    await backend.ensureRouter("call-1");
    expect(backend.hasRouter("call-1")).toBe(true);
    expect(workers).toHaveLength(1);

    // The C++ worker process crashes.
    workers[0]!.emitDied();

    // Its routers are now invalid and must be dropped (no silent dead handles).
    expect(backend.hasRouter("call-1")).toBe(false);

    // The next allocation rebuilds on a fresh worker.
    await backend.ensureRouter("call-2");
    expect(backend.hasRouter("call-2")).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it("ignores a 'died' event from a worker that was already replaced", async () => {
    const workers: FakeWorker[] = [];
    const backend = new MediasoupSfuBackend({
      mediaCodecs: [],
      createWorker: async () => {
        const w = fakeWorker();
        workers.push(w);
        return w;
      },
    });

    await backend.ensureRouter("call-1");
    workers[0]!.emitDied(); // first worker dies → routers dropped
    await backend.ensureRouter("call-2"); // second worker comes up
    expect(backend.hasRouter("call-2")).toBe(true);

    // A late 'died' from the *first* (already-replaced) worker must not nuke the
    // live second worker's routers.
    workers[0]!.emitDied();
    expect(backend.hasRouter("call-2")).toBe(true);
  });
});
