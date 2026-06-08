/**
 * FR-83 — `SfuBackend`: Frick's own abstraction over an SFU's media lifecycle.
 *
 * This is the boundary the SFU media-plane adapter ({@link
 * ../sfu-media-plane.ts}) drives. It is a *Frick-owned* interface — deliberately
 * **not** mediasoup's types — so that:
 *
 *  1. Nothing on the typecheck/test path ever imports `"mediasoup"` (a native
 *     module that compiles a C++ worker). The gate stays green without it.
 *  2. The real backend ({@link MediasoupSfuBackend}) is one swappable impl; the
 *     deterministic {@link FakeSfuBackend} powers all tests.
 *
 * The shapes below are a minimal, structural subset of the mediasoup concepts we
 * actually use (router RTP capabilities, WebRTC transport ICE/DTLS params,
 * producers, consumers). They are typed loosely enough (e.g. capabilities as an
 * opaque JSON-able object) that we never need mediasoup's `.d.ts` to describe
 * them, while still carrying the exact bytes a browser client needs to bootstrap
 * a mediasoup-client `Device` and establish send/recv transports.
 *
 * Lifecycle (per call):
 *   ensureRouter(callId)          -> RouterHandle (idempotent per callId)
 *   getRouterRtpCapabilities()    -> RtpCapabilities (client Device.load input)
 *   createWebRtcTransport()       -> TransportHandle (+ ICE/DTLS params)
 *   connectTransport()            -> DTLS handshake (client dtlsParameters)
 *   produce()                     -> ProducerHandle (a participant's track)
 *   consume()                     -> ConsumerHandle (another participant's track)
 *   close*()                      -> tear down consumer/producer/transport/router
 */

/** Opaque, JSON-serializable RTP capabilities (router or client). */
export type RtpCapabilities = Record<string, unknown>;

/** Opaque, JSON-serializable RTP parameters for a producer/consumer track. */
export type RtpParameters = Record<string, unknown>;

/** Media kind a producer/consumer carries. */
export type MediaKind = "audio" | "video";

/** A single ICE candidate the client gathers from to reach the SFU. */
export interface IceCandidate {
  readonly foundation: string;
  readonly priority: number;
  readonly ip: string;
  readonly protocol: "udp" | "tcp";
  readonly port: number;
  readonly type: string;
}

/** ICE parameters (ufrag/pwd) for a WebRTC transport. */
export interface IceParameters {
  readonly usernameFragment: string;
  readonly password: string;
  readonly iceLite?: boolean;
}

/** DTLS parameters (role + fingerprints) for a WebRTC transport. */
export interface DtlsParameters {
  readonly role?: "auto" | "client" | "server";
  readonly fingerprints: readonly { readonly algorithm: string; readonly value: string }[];
}

/** A media codec the router is configured to route. */
export interface SfuCodec {
  readonly kind: MediaKind;
  readonly mimeType: string;
  readonly clockRate: number;
  readonly channels?: number;
  readonly parameters?: Record<string, unknown>;
  readonly preferredPayloadType?: number;
}

/** Handle to a per-call router. */
export interface RouterHandle {
  readonly id: string;
}

/** Handle to a participant's WebRTC transport, with the client bootstrap params. */
export interface TransportHandle {
  readonly id: string;
  readonly iceParameters: IceParameters;
  readonly iceCandidates: readonly IceCandidate[];
  readonly dtlsParameters: DtlsParameters;
}

/** Handle to a producer (one participant's outbound track). */
export interface ProducerHandle {
  readonly id: string;
  readonly kind: MediaKind;
}

/** Handle to a consumer (another participant's track delivered to this one). */
export interface ConsumerHandle {
  readonly id: string;
  readonly producerId: string;
  readonly kind: MediaKind;
  readonly rtpParameters: RtpParameters;
}

export interface CreateWebRtcTransportInput {
  readonly callId: string;
  /** The announced IP mediasoup advertises in ICE candidates. */
  readonly announcedIp: string;
  /** Direction hint, purely informational for the backend. */
  readonly direction: "send" | "recv";
}

export interface ConnectTransportInput {
  readonly callId: string;
  readonly transportId: string;
  /** Client-provided DTLS parameters completing the handshake. */
  readonly dtlsParameters: DtlsParameters;
}

export interface ProduceInput {
  readonly callId: string;
  readonly transportId: string;
  readonly kind: MediaKind;
  readonly rtpParameters: RtpParameters;
}

export interface ConsumeInput {
  readonly callId: string;
  readonly transportId: string;
  readonly producerId: string;
  /** The consuming client's RTP capabilities (Device.rtpCapabilities). */
  readonly rtpCapabilities: RtpCapabilities;
}

/**
 * The SFU media lifecycle Frick drives. All methods are async so a real backend
 * can do worker I/O; the fake resolves synchronously and deterministically.
 */
export interface SfuBackend {
  /** Create the router for `callId` if absent; idempotent — returns the same handle. */
  ensureRouter(callId: string): Promise<RouterHandle>;

  /** Whether a router currently exists for `callId`. */
  hasRouter(callId: string): boolean;

  /**
   * The router's RTP capabilities — a browser client loads these into its
   * mediasoup-client `Device` before creating transports. Throws if no router.
   */
  getRouterRtpCapabilities(callId: string): Promise<RtpCapabilities>;

  /** Create a WebRTC transport on the call's router. Throws if no router. */
  createWebRtcTransport(input: CreateWebRtcTransportInput): Promise<TransportHandle>;

  /** Complete the DTLS handshake for a transport with client params. */
  connectTransport(input: ConnectTransportInput): Promise<void>;

  /** Start producing a track on a transport. Returns the new producer handle. */
  produce(input: ProduceInput): Promise<ProducerHandle>;

  /** Consume an existing producer onto a transport. Returns the consumer handle. */
  consume(input: ConsumeInput): Promise<ConsumerHandle>;

  /** Close a consumer. Idempotent. */
  closeConsumer(callId: string, consumerId: string): Promise<void>;

  /** Close a producer. Idempotent. */
  closeProducer(callId: string, producerId: string): Promise<void>;

  /** Close a transport (and its producers/consumers). Idempotent. */
  closeTransport(callId: string, transportId: string): Promise<void>;

  /** Close the call's router and everything under it. Idempotent. */
  closeRouter(callId: string): Promise<void>;

  /** Release all workers/resources held by the backend. */
  close(): Promise<void>;
}

/** Raised by a backend when an operation references missing state. */
export class SfuBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SfuBackendError";
  }
}
