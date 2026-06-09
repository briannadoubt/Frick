import {
  SfuBackendError,
  type ConnectTransportInput,
  type ConsumeInput,
  type ConsumerHandle,
  type CreateWebRtcTransportInput,
  type ProduceInput,
  type ProducerHandle,
  type RouterHandle,
  type RtpCapabilities,
  type SfuCodec,
  type SfuBackend,
  type TransportHandle,
} from "./sfu-backend.js";

/**
 * FR-83 — Real {@link SfuBackend} backed by **mediasoup** (single-box).
 *
 * mediasoup is a *native* module: it spawns C++ worker processes and its install
 * compiles/downloads a worker binary. To keep the typecheck/test gate green
 * **without** mediasoup ever being built, this file:
 *
 *  - declares **zero** top-level `import` (or `import type`) of `"mediasoup"`;
 *  - lazy-loads it with `await import("mediasoup")` *inside* {@link #ensureWorker},
 *    so the dependency is only touched at runtime when an operator actually runs
 *    the SFU;
 *  - types the import boundary loosely (`any`) and re-exposes everything through
 *    Frick's own {@link SfuBackend} shapes. The narrow `any` at this seam is
 *    deliberate — it's the price of never needing mediasoup's `.d.ts` on the
 *    typecheck path.
 *
 * **Enabling the real backend.** mediasoup is listed in
 * `apps/server/package.json` `optionalDependencies`, so `pnpm install` discovers
 * it but does not fail the workspace if its native build can't run. If it is not
 * present (or its build was skipped), install it explicitly:
 *
 * ```sh
 * pnpm add mediasoup --filter @fricken/server
 * ```
 *
 * The lazy `import("mediasoup")` resolves it at runtime when present and throws a
 * clear {@link SfuBackendError} when it is not — so the rest of Frick (and the
 * whole test suite) never depends on it being built.
 *
 * Scope: single box. One worker, one router per call, send/recv WebRtcTransports
 * per participant. SFU-to-SFU PipeTransport cascading and multi-box placement are
 * out of scope (FR-154 / future).
 */

/** Minimal structural view of the mediasoup module we touch (lazy-loaded). */
interface MediasoupModule {
  createWorker(options: unknown): Promise<MediasoupWorker>;
}
/**
 * Minimal structural view of a mediasoup worker. Exported so an injected
 * {@link MediasoupSfuBackendOptions.createWorker} factory (tests) can return a
 * compatible double without importing mediasoup.
 */
export interface MediasoupWorker {
  createRouter(options: { mediaCodecs: unknown[] }): Promise<MediasoupRouter>;
  /** Worker lifecycle events (notably `'died'` when the C++ process crashes). */
  on?(event: string, listener: (...args: unknown[]) => void): void;
  close(): void;
}
export interface MediasoupRouter {
  readonly id: string;
  readonly rtpCapabilities: RtpCapabilities;
  canConsume(options: { producerId: string; rtpCapabilities: RtpCapabilities }): boolean;
  createWebRtcTransport(options: unknown): Promise<MediasoupTransport>;
  close(): void;
}
export interface MediasoupTransport {
  readonly id: string;
  readonly iceParameters: TransportHandle["iceParameters"];
  readonly iceCandidates: readonly TransportHandle["iceCandidates"][number][];
  readonly dtlsParameters: TransportHandle["dtlsParameters"];
  connect(options: { dtlsParameters: unknown }): Promise<void>;
  produce(options: { kind: string; rtpParameters: unknown }): Promise<MediasoupProducer>;
  consume(options: {
    producerId: string;
    rtpCapabilities: unknown;
    paused?: boolean;
  }): Promise<MediasoupConsumer>;
  close(): void;
}
export interface MediasoupProducer {
  readonly id: string;
  readonly kind: string;
  close(): void;
}
export interface MediasoupConsumer {
  readonly id: string;
  readonly producerId: string;
  readonly kind: string;
  readonly rtpParameters: RtpCapabilities;
  close(): void;
}

export interface MediasoupSfuBackendOptions {
  /** Media codecs the per-call routers are configured with. */
  readonly mediaCodecs: readonly SfuCodec[];
  /**
   * RTC port range for WebRTC transports (mediasoup worker config). Defaults to
   * 40000–49999.
   */
  readonly rtcMinPort?: number;
  readonly rtcMaxPort?: number;
  /** mediasoup worker log level. Defaults to `"warn"`. */
  readonly logLevel?: "debug" | "warn" | "error" | "none";
  /**
   * Injectable worker factory. Defaults to the lazy `import("mediasoup")` +
   * `createWorker`. Tests inject a deterministic fake so the worker-init retry
   * (sfu-media-5) and 'died'-handler (sfu-media-6) paths are exercisable without
   * building the native module.
   */
  readonly createWorker?: (config: {
    logLevel: "debug" | "warn" | "error" | "none";
    rtcMinPort: number;
    rtcMaxPort: number;
  }) => Promise<MediasoupWorker>;
}

const DEFAULT_RTC_MIN_PORT = 40000;
const DEFAULT_RTC_MAX_PORT = 49999;

interface RouterEntry {
  readonly router: MediasoupRouter;
  readonly transports: Map<string, MediasoupTransport>;
  readonly producers: Map<string, MediasoupProducer>;
  readonly consumers: Map<string, MediasoupConsumer>;
}

export class MediasoupSfuBackend implements SfuBackend {
  readonly #options: MediasoupSfuBackendOptions;
  readonly #routers = new Map<string, RouterEntry>();
  #worker: MediasoupWorker | undefined;
  #workerInit: Promise<MediasoupWorker> | undefined;

  constructor(options: MediasoupSfuBackendOptions) {
    this.#options = options;
  }

  async ensureRouter(callId: string): Promise<RouterHandle> {
    const existing = this.#routers.get(callId);
    if (existing) {
      return { id: existing.router.id };
    }
    const worker = await this.#ensureWorker();
    const router = await worker.createRouter({
      mediaCodecs: this.#options.mediaCodecs.map((c) => ({
        kind: c.kind,
        mimeType: c.mimeType,
        clockRate: c.clockRate,
        ...(c.channels !== undefined ? { channels: c.channels } : {}),
        ...(c.parameters !== undefined ? { parameters: c.parameters } : {}),
        ...(c.preferredPayloadType !== undefined
          ? { preferredPayloadType: c.preferredPayloadType }
          : {}),
      })),
    });
    this.#routers.set(callId, {
      router,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    });
    return { id: router.id };
  }

  hasRouter(callId: string): boolean {
    return this.#routers.has(callId);
  }

  async getRouterRtpCapabilities(callId: string): Promise<RtpCapabilities> {
    return this.#requireRouter(callId).router.rtpCapabilities;
  }

  async createWebRtcTransport(input: CreateWebRtcTransportInput): Promise<TransportHandle> {
    const entry = this.#requireRouter(input.callId);
    const transport = await entry.router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: input.announcedIp }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
    entry.transports.set(transport.id, transport);
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(input: ConnectTransportInput): Promise<void> {
    const transport = this.#requireTransport(input.callId, input.transportId);
    await transport.connect({ dtlsParameters: input.dtlsParameters });
  }

  async produce(input: ProduceInput): Promise<ProducerHandle> {
    const entry = this.#requireRouter(input.callId);
    const transport = this.#requireTransport(input.callId, input.transportId);
    const producer = await transport.produce({
      kind: input.kind,
      rtpParameters: input.rtpParameters,
    });
    entry.producers.set(producer.id, producer);
    return { id: producer.id, kind: producer.kind as ProducerHandle["kind"] };
  }

  async consume(input: ConsumeInput): Promise<ConsumerHandle> {
    const entry = this.#requireRouter(input.callId);
    const transport = this.#requireTransport(input.callId, input.transportId);
    if (
      !entry.router.canConsume({
        producerId: input.producerId,
        rtpCapabilities: input.rtpCapabilities,
      })
    ) {
      throw new SfuBackendError(
        `Client cannot consume producer ${input.producerId} on call ${input.callId}`,
      );
    }
    const consumer = await transport.consume({
      producerId: input.producerId,
      rtpCapabilities: input.rtpCapabilities,
      paused: false,
    });
    entry.consumers.set(consumer.id, consumer);
    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind as ConsumerHandle["kind"],
      rtpParameters: consumer.rtpParameters,
    };
  }

  async closeConsumer(callId: string, consumerId: string): Promise<void> {
    const entry = this.#routers.get(callId);
    const consumer = entry?.consumers.get(consumerId);
    if (consumer) {
      consumer.close();
      entry!.consumers.delete(consumerId);
    }
  }

  async closeProducer(callId: string, producerId: string): Promise<void> {
    const entry = this.#routers.get(callId);
    const producer = entry?.producers.get(producerId);
    if (producer) {
      producer.close();
      entry!.producers.delete(producerId);
    }
  }

  async closeTransport(callId: string, transportId: string): Promise<void> {
    const entry = this.#routers.get(callId);
    const transport = entry?.transports.get(transportId);
    if (transport) {
      transport.close();
      entry!.transports.delete(transportId);
    }
  }

  async closeRouter(callId: string): Promise<void> {
    const entry = this.#routers.get(callId);
    if (entry) {
      entry.router.close(); // closes its transports/producers/consumers too
      this.#routers.delete(callId);
    }
  }

  async close(): Promise<void> {
    for (const callId of [...this.#routers.keys()]) {
      await this.closeRouter(callId);
    }
    this.#worker?.close();
    this.#worker = undefined;
    this.#workerInit = undefined;
  }

  /**
   * Lazy-load mediasoup and spin up a single worker on first use. The dynamic
   * import is the *only* reference to `"mediasoup"` in the codebase — nothing on
   * the typecheck path ever resolves it.
   */
  async #ensureWorker(): Promise<MediasoupWorker> {
    if (this.#worker) {
      return this.#worker;
    }
    if (!this.#workerInit) {
      this.#workerInit = this.#startWorker();
    }
    try {
      this.#worker = await this.#workerInit;
    } catch (error) {
      // Do NOT cache a rejected init promise: a transient createWorker failure
      // (ENOMEM, no free ports, EAGAIN spawning the C++ worker) would otherwise
      // brick the backend forever, with every future call re-awaiting the same
      // stale rejection. Clear it so the next call retries a fresh worker
      // (sfu-media-5).
      this.#workerInit = undefined;
      throw error;
    }
    return this.#worker;
  }

  async #startWorker(): Promise<MediasoupWorker> {
    const config = {
      logLevel: this.#options.logLevel ?? ("warn" as const),
      rtcMinPort: this.#options.rtcMinPort ?? DEFAULT_RTC_MIN_PORT,
      rtcMaxPort: this.#options.rtcMaxPort ?? DEFAULT_RTC_MAX_PORT,
    };
    const create = this.#options.createWorker;
    let worker: MediasoupWorker;
    if (create) {
      worker = await create(config);
    } else {
      let mediasoup: MediasoupModule;
      try {
        // Narrow `any` at the native-module boundary: see the file doc comment.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mediasoup = (await import("mediasoup" as string)) as any as MediasoupModule;
      } catch {
        throw new SfuBackendError(
          "mediasoup is not installed. Enable the real SFU backend with " +
            "`pnpm add mediasoup --filter @fricken/server` (it is an optional native dependency).",
        );
      }
      worker = await mediasoup.createWorker(config);
    }
    // A mediasoup worker is a separate C++ process that can crash. When it dies,
    // every router under it is dead too: drop our handle + the now-orphaned
    // router entries so the next operation re-allocates a fresh worker/routers
    // instead of silently forwarding nothing (sfu-media-6).
    worker.on?.("died", () => {
      this.#handleWorkerDeath(worker);
    });
    return worker;
  }

  /**
   * React to a mediasoup worker 'died' event: if it is still our active worker,
   * drop it and invalidate all routers spawned from it so callers re-allocate.
   * Guarded against a stale event from a worker we already replaced.
   */
  #handleWorkerDeath(worker: MediasoupWorker): void {
    if (this.#worker !== undefined && this.#worker !== worker) {
      return;
    }
    this.#worker = undefined;
    this.#workerInit = undefined;
    // Routers from the dead worker are unusable — drop them so ensureRouter
    // rebuilds on a fresh worker rather than handing back dead handles.
    this.#routers.clear();
  }

  #requireRouter(callId: string): RouterEntry {
    const entry = this.#routers.get(callId);
    if (!entry) {
      throw new SfuBackendError(`No router allocated for call ${callId}`);
    }
    return entry;
  }

  #requireTransport(callId: string, transportId: string): MediasoupTransport {
    const transport = this.#requireRouter(callId).transports.get(transportId);
    if (!transport) {
      throw new SfuBackendError(`No transport ${transportId} on router for call ${callId}`);
    }
    return transport;
  }
}
