import {
  SfuBackendError,
  type ConnectTransportInput,
  type ConsumeInput,
  type ConsumerHandle,
  type CreateWebRtcTransportInput,
  type DtlsParameters,
  type IceCandidate,
  type IceParameters,
  type ProduceInput,
  type ProducerHandle,
  type RouterHandle,
  type RtpCapabilities,
  type SfuBackend,
  type TransportHandle,
} from "./sfu-backend.js";

/**
 * FR-83 — Deterministic in-memory {@link SfuBackend} for tests and local dev.
 *
 * Does **no networking** and never touches mediasoup. Router/transport/producer/
 * consumer ids are derived from a monotonic counter (or injectable id factories)
 * so the same sequence of calls always yields identical handles — exactly the
 * determinism the SFU adapter tests rely on to assert ICE/DTLS params without
 * standing up a C++ worker.
 *
 * State is tracked so idempotency and the "throw without a router" guards behave
 * like the real backend would: routers, transports, producers, and consumers are
 * stored per call and torn down on close.
 */
export interface FakeSfuBackendOptions {
  /** Override router ids (defaults to `fake-router-<callId>-<n>`). */
  readonly routerId?: (callId: string, ordinal: number) => string;
  /** Override transport ids (defaults to `fake-transport-<n>`). */
  readonly transportId?: (ordinal: number) => string;
  /** Override producer ids (defaults to `fake-producer-<n>`). */
  readonly producerId?: (ordinal: number) => string;
  /** Override consumer ids (defaults to `fake-consumer-<n>`). */
  readonly consumerId?: (ordinal: number) => string;
  /** Router RTP capabilities returned to clients. A fixed JSON object by default. */
  readonly routerRtpCapabilities?: RtpCapabilities;
  /** ICE parameters injected onto every transport. */
  readonly iceParameters?: IceParameters;
  /** ICE candidate template; `ip`/`port` are filled from the transport input. */
  readonly iceCandidate?: (input: CreateWebRtcTransportInput, ordinal: number) => IceCandidate;
  /** DTLS parameters injected onto every transport. */
  readonly dtlsParameters?: DtlsParameters;
}

const DEFAULT_ROUTER_RTP_CAPABILITIES: RtpCapabilities = {
  codecs: [
    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, preferredPayloadType: 100 },
    { kind: "video", mimeType: "video/VP8", clockRate: 90000, preferredPayloadType: 101 },
  ],
  headerExtensions: [],
};

const DEFAULT_ICE_PARAMETERS: IceParameters = {
  usernameFragment: "fakeufrag",
  password: "fakepassword0123456789",
  iceLite: true,
};

const DEFAULT_DTLS_PARAMETERS: DtlsParameters = {
  role: "auto",
  fingerprints: [{ algorithm: "sha-256", value: "AA:BB:CC:DD:EE:FF" }],
};

interface FakeTransport {
  readonly id: string;
  connected: boolean;
}

interface FakeRouter {
  readonly id: string;
  readonly transports: Map<string, FakeTransport>;
  readonly producers: Map<string, ProducerHandle>;
  readonly consumers: Map<string, ConsumerHandle>;
}

export class FakeSfuBackend implements SfuBackend {
  readonly #options: FakeSfuBackendOptions;
  readonly #routers = new Map<string, FakeRouter>();
  #counter = 0;

  constructor(options: FakeSfuBackendOptions = {}) {
    this.#options = options;
  }

  async ensureRouter(callId: string): Promise<RouterHandle> {
    const existing = this.#routers.get(callId);
    if (existing) {
      return { id: existing.id };
    }
    const ordinal = ++this.#counter;
    const id = this.#options.routerId?.(callId, ordinal) ?? `fake-router-${callId}-${ordinal}`;
    this.#routers.set(callId, {
      id,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    });
    return { id };
  }

  hasRouter(callId: string): boolean {
    return this.#routers.has(callId);
  }

  async getRouterRtpCapabilities(callId: string): Promise<RtpCapabilities> {
    this.#requireRouter(callId);
    return this.#options.routerRtpCapabilities ?? DEFAULT_ROUTER_RTP_CAPABILITIES;
  }

  async createWebRtcTransport(input: CreateWebRtcTransportInput): Promise<TransportHandle> {
    const router = this.#requireRouter(input.callId);
    const ordinal = ++this.#counter;
    const id = this.#options.transportId?.(ordinal) ?? `fake-transport-${ordinal}`;
    router.transports.set(id, { id, connected: false });
    const candidate =
      this.#options.iceCandidate?.(input, ordinal) ??
      ({
        foundation: "udpcandidate",
        priority: 1_000_000 + ordinal,
        ip: input.announcedIp,
        protocol: "udp",
        port: 40000 + ordinal,
        type: "host",
      } satisfies IceCandidate);
    return {
      id,
      iceParameters: this.#options.iceParameters ?? DEFAULT_ICE_PARAMETERS,
      iceCandidates: [candidate],
      dtlsParameters: this.#options.dtlsParameters ?? DEFAULT_DTLS_PARAMETERS,
    };
  }

  async connectTransport(input: ConnectTransportInput): Promise<void> {
    const router = this.#requireRouter(input.callId);
    const transport = router.transports.get(input.transportId);
    if (!transport) {
      throw new SfuBackendError(
        `No transport ${input.transportId} on router for call ${input.callId}`,
      );
    }
    transport.connected = true;
  }

  async produce(input: ProduceInput): Promise<ProducerHandle> {
    const router = this.#requireRouter(input.callId);
    if (!router.transports.has(input.transportId)) {
      throw new SfuBackendError(
        `No transport ${input.transportId} on router for call ${input.callId}`,
      );
    }
    const ordinal = ++this.#counter;
    const id = this.#options.producerId?.(ordinal) ?? `fake-producer-${ordinal}`;
    const handle: ProducerHandle = { id, kind: input.kind };
    router.producers.set(id, handle);
    return handle;
  }

  async consume(input: ConsumeInput): Promise<ConsumerHandle> {
    const router = this.#requireRouter(input.callId);
    if (!router.transports.has(input.transportId)) {
      throw new SfuBackendError(
        `No transport ${input.transportId} on router for call ${input.callId}`,
      );
    }
    const producer = router.producers.get(input.producerId);
    if (!producer) {
      throw new SfuBackendError(
        `Cannot consume: no producer ${input.producerId} on router for call ${input.callId}`,
      );
    }
    const ordinal = ++this.#counter;
    const id = this.#options.consumerId?.(ordinal) ?? `fake-consumer-${ordinal}`;
    const handle: ConsumerHandle = {
      id,
      producerId: producer.id,
      kind: producer.kind,
      rtpParameters: { codecs: [], encodings: [{ ssrc: 1_000 + ordinal }] },
    };
    router.consumers.set(id, handle);
    return handle;
  }

  async closeConsumer(callId: string, consumerId: string): Promise<void> {
    this.#routers.get(callId)?.consumers.delete(consumerId);
  }

  async closeProducer(callId: string, producerId: string): Promise<void> {
    this.#routers.get(callId)?.producers.delete(producerId);
  }

  async closeTransport(callId: string, transportId: string): Promise<void> {
    this.#routers.get(callId)?.transports.delete(transportId);
  }

  async closeRouter(callId: string): Promise<void> {
    this.#routers.delete(callId);
  }

  async close(): Promise<void> {
    this.#routers.clear();
  }

  // -- test/inspection helpers ---------------------------------------------

  /** How many transports currently exist on a call's router. */
  transportCount(callId: string): number {
    return this.#routers.get(callId)?.transports.size ?? 0;
  }

  /** How many producers currently exist on a call's router. */
  producerCount(callId: string): number {
    return this.#routers.get(callId)?.producers.size ?? 0;
  }

  /** Is a transport recorded as DTLS-connected? */
  isTransportConnected(callId: string, transportId: string): boolean {
    return this.#routers.get(callId)?.transports.get(transportId)?.connected ?? false;
  }

  #requireRouter(callId: string): FakeRouter {
    const router = this.#routers.get(callId);
    if (!router) {
      throw new SfuBackendError(`No router allocated for call ${callId}`);
    }
    return router;
  }
}
