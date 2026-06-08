/**
 * FR-155 — web client SFU produce/consume driver.
 *
 * Makes the FR-83 single-box mediasoup SFU usable end-to-end from a browser.
 * Where {@link startP2PCall} (FR-81) negotiates media peer↔peer over the
 * `WebRTCSignal` relay, this driver negotiates media through a *server-side*
 * mediasoup router by driving the FR-155 SFU `CallCommand` ops
 * (`sfuConnectTransport` / `sfuProduce` / `sfuConsume`) over the SAME
 * request/response frame the lifecycle commands use. It:
 *
 *  1. Loads a mediasoup-client `Device` from the join grant's
 *     `routerRtpCapabilities`.
 *  2. Builds send + recv transports from the grant's transport params and wires
 *     their `connect`/`produce` events to `sfuConnectTransport`/`sfuProduce`.
 *  3. Produces the local stream's tracks.
 *  4. Consumes other participants' producers (driven by the caller feeding in
 *     producer ids it learns about, e.g. from call events) via `sfuConsume`,
 *     exposing the resulting remote tracks/streams.
 *
 * **Browser-free testability.** The mediasoup-client `Device`/`Transport` are
 * abstracted behind the minimal {@link SfuDeviceLike}/{@link SfuTransportLike}
 * interfaces and an injectable {@link CreateSfuDevice} factory (default lazily
 * `import("mediasoup-client")`'s `Device`). Nothing on the typecheck/test path
 * imports `mediasoup-client`; tests inject a fake device + fake transports + a
 * fake client and assert the full negotiate→produce→consume flow with no DOM.
 */

import type { CallMediaGrant } from "@fricken/protocol";
import type { CallCommandOp, CallCommandResultPayload } from "@fricken/protocol";

import type { FrameTransformInserter, SFrameTransform } from "./e2ee.js";
import type { MediaStreamLike, MediaStreamTrackLike } from "./p2p.js";

/** Media kind a producer/consumer carries. */
export type SfuMediaKind = "audio" | "video";

/**
 * The slice of {@link FrickClient} this driver depends on. Defining it
 * explicitly lets tests inject a fake (or an in-process loopback to the server
 * adapter) with no full client/runtime.
 */
export interface SfuCallClient {
  callCommand(command: CallCommandOp): Promise<CallCommandResultPayload>;
}

// -- mediasoup-client boundary ----------------------------------------------
//
// Minimal structural mirrors of the mediasoup-client shapes we use. Typed here
// (rather than importing mediasoup-client's `.d.ts`) so the test/typecheck path
// never needs the optional dependency.

/** Opaque, JSON-serializable RTP capabilities / parameters. */
export type SfuRtpCapabilities = Record<string, unknown>;
export type SfuRtpParameters = Record<string, unknown>;
export type SfuDtlsParameters = Record<string, unknown>;

/** Transport params from the join grant (id + ICE/DTLS bootstrap). */
export interface SfuTransportOptions {
  readonly id: string;
  readonly iceParameters: unknown;
  readonly iceCandidates: unknown;
  readonly dtlsParameters: unknown;
  readonly sctpParameters?: unknown;
}

/** Args mediasoup-client passes to a send transport's `produce` event handler. */
export interface SfuProduceEventArgs {
  readonly kind: SfuMediaKind;
  readonly rtpParameters: SfuRtpParameters;
  readonly appData?: Record<string, unknown>;
}

/** Options for `recvTransport.consume(...)`. */
export interface SfuConsumeOptions {
  readonly id: string;
  readonly producerId: string;
  readonly kind: SfuMediaKind;
  readonly rtpParameters: SfuRtpParameters;
}

/** A produced track handle (mediasoup-client `Producer`). */
export interface SfuProducerLike {
  readonly id: string;
  readonly kind: string;
  close(): void;
}

/** A consumed track handle (mediasoup-client `Consumer`). */
export interface SfuConsumerLike {
  readonly id: string;
  readonly producerId: string;
  readonly kind: string;
  readonly track: MediaStreamTrackLike;
  close(): void;
}

/**
 * Minimal mirror of a mediasoup-client `Transport`. The driver subscribes to
 * `connect` (DTLS handshake) and, for a send transport, `produce`.
 */
export interface SfuTransportLike {
  readonly id: string;
  /**
   * Fires once when the transport needs its DTLS handshake completed. The driver
   * forwards `dtlsParameters` to the server and then `callback()`s (or `errback`
   * on failure), mirroring mediasoup-client's connect contract.
   */
  on(
    event: "connect",
    listener: (
      args: { dtlsParameters: SfuDtlsParameters },
      callback: () => void,
      errback: (error: Error) => void,
    ) => void,
  ): void;
  /**
   * Fires when a send transport produces a track. The driver forwards to the
   * server and `callback({ id })`s with the server-assigned producer id.
   */
  on(
    event: "produce",
    listener: (
      args: SfuProduceEventArgs,
      callback: (result: { id: string }) => void,
      errback: (error: Error) => void,
    ) => void,
  ): void;
  /** Produce a local track on a send transport. */
  produce(options: { track: MediaStreamTrackLike }): Promise<SfuProducerLike>;
  /** Consume a remote producer on a recv transport. */
  consume(options: SfuConsumeOptions): Promise<SfuConsumerLike>;
  close(): void;
}

/**
 * Minimal mirror of a mediasoup-client `Device`. `load`ed with the router's RTP
 * capabilities, then used to build send/recv transports and to expose the
 * client's own `rtpCapabilities` for consume negotiation.
 */
export interface SfuDeviceLike {
  load(options: { routerRtpCapabilities: SfuRtpCapabilities }): Promise<void>;
  readonly rtpCapabilities: SfuRtpCapabilities;
  createSendTransport(options: SfuTransportOptions): SfuTransportLike;
  createRecvTransport(options: SfuTransportOptions): SfuTransportLike;
}

/** Factory the driver calls to obtain a `Device`. Defaults to mediasoup-client. */
export type CreateSfuDevice = () => SfuDeviceLike | Promise<SfuDeviceLike>;

/** A remote track delivered by the SFU, paired with its source producer id. */
export interface SfuRemoteTrack {
  readonly producerId: string;
  readonly consumerId: string;
  readonly kind: SfuMediaKind;
  readonly track: MediaStreamTrackLike;
}

export interface StartSfuCallOptions {
  readonly callId: string;
  /** This client's participant identity (used for self-echo filtering by callers). */
  readonly participant: { readonly userId: string; readonly deviceId: string };
  /**
   * The media join grant from `joinCall`. Its `connection` carries the
   * JSON-serialized `routerRtpCapabilities`, `sendTransport`, and `recvTransport`
   * params the SFU media plane minted (see `SfuMediaPlaneAdapter`).
   */
  readonly grant: CallMediaGrant;
  /** Local media to produce (mic/camera). Optional — a recv-only client omits it. */
  readonly localStream?: MediaStreamLike;
  /** Override the device factory (tests inject a fake). */
  readonly createDevice?: CreateSfuDevice;
  /**
   * FR-156 — opt-in, per-room end-to-end encryption. When provided, the driver
   * attaches the SFrame `transform` to every local producer (outbound encrypt
   * before the SFU sees the frame) and every remote consumer (inbound decrypt
   * after the SFU hands it back) via the injectable `inserter` (the browser
   * Encoded-Transform seam — a fake in tests). When omitted, the media path is
   * byte-for-byte as before: no transform is attached and no epoch traffic runs.
   */
  readonly e2ee?: SfuE2EEOptions;
}

/** Per-room E2EE wiring for {@link startSfuCall} (FR-156). */
export interface SfuE2EEOptions {
  /** The production SFrame transform (`SFrameCipherTransform`) keyed by the call's epochs. */
  readonly transform: SFrameTransform;
  /**
   * The insertion seam. The browser impl builds an `RTCRtpScriptTransform`
   * around `transform` per sender/receiver; tests inject a
   * `MemoryFrameTransformInserter` and pump frames through it.
   */
  readonly inserter: FrameTransformInserter;
}

/**
 * Live handle to an SFU call. Exposes the live transports, the local producers,
 * the remote tracks/streams as they're consumed, the connection state, and
 * `close()` to tear everything down.
 */
export interface SfuCallHandle {
  readonly device: SfuDeviceLike;
  readonly sendTransport: SfuTransportLike;
  readonly recvTransport: SfuTransportLike;
  /** The local producers, keyed by producer id. */
  readonly producers: ReadonlyMap<string, SfuProducerLike>;
  /** The remote tracks consumed so far, keyed by source producer id. */
  readonly remoteTracks: ReadonlyMap<string, SfuRemoteTrack>;
  /** Coarse connection state mirrored off the driver's own lifecycle. */
  readonly connectionState: SfuConnectionState;
  /**
   * Consume a remote participant's producer. The caller discovers producer ids
   * out of band (e.g. via call events) and feeds them here; the driver runs the
   * `sfuConsume` command and exposes the resulting remote track. Idempotent per
   * producer id — consuming the same producer twice returns the existing track.
   */
  consume(producerId: string): Promise<SfuRemoteTrack>;
  /** Subscribe to remote tracks arriving. Returns an unsubscribe. */
  onRemoteTrack(listener: (track: SfuRemoteTrack) => void): () => void;
  /** Subscribe to connection-state transitions. Returns an unsubscribe. */
  onStateChange(listener: (state: SfuConnectionState) => void): () => void;
  /** Tear down producers, consumers, transports, and the device. */
  close(): void;
}

export type SfuConnectionState = "new" | "connecting" | "connected" | "closed";

async function defaultCreateDevice(): Promise<SfuDeviceLike> {
  // Lazy import so the optional `mediasoup-client` dependency is never required
  // on the typecheck/test path. The specifier is held in a variable so the
  // typechecker does not try to resolve the (optional, possibly-absent) module;
  // narrow `any` at this import seam only.
  const specifier = "mediasoup-client";
  const mod = (await import(/* @vite-ignore */ specifier)) as unknown as {
    Device: new () => SfuDeviceLike;
  };
  return new mod.Device();
}

/** Parse a JSON-serialized field off the grant's opaque `connection` bag. */
function parseGrantField<T>(grant: CallMediaGrant, key: string): T {
  const raw = grant.connection?.[key];
  if (raw === undefined) {
    throw new Error(`SFU grant is missing required connection field "${key}"`);
  }
  return JSON.parse(raw) as T;
}

/**
 * Start (or join) an SFU-brokered call: load the device, build + connect the
 * send/recv transports, and produce the local stream's tracks. Remote tracks
 * are consumed on demand via the returned handle's `consume(producerId)`.
 */
export async function startSfuCall(
  client: SfuCallClient,
  options: StartSfuCallOptions,
): Promise<SfuCallHandle> {
  const { callId, grant, localStream, e2ee } = options;
  const createDevice = options.createDevice ?? defaultCreateDevice;
  /** E2EE transform detach fns (FR-156); empty when E2EE is off. */
  const e2eeDetachers: Array<() => void> = [];

  const routerRtpCapabilities = parseGrantField<SfuRtpCapabilities>(
    grant,
    "routerRtpCapabilities",
  );
  const sendParams = parseGrantField<SfuTransportOptions>(grant, "sendTransport");
  const recvParams = parseGrantField<SfuTransportOptions>(grant, "recvTransport");

  const device = await createDevice();
  await device.load({ routerRtpCapabilities });

  const producers = new Map<string, SfuProducerLike>();
  const remoteTracks = new Map<string, SfuRemoteTrack>();
  const consumers = new Map<string, SfuConsumerLike>();
  /** In-flight consume calls, deduped per producer id. */
  const consuming = new Map<string, Promise<SfuRemoteTrack>>();
  const trackListeners = new Set<(track: SfuRemoteTrack) => void>();
  const stateListeners = new Set<(state: SfuConnectionState) => void>();
  let state: SfuConnectionState = "new";
  let closed = false;

  function setState(next: SfuConnectionState): void {
    if (state === next || closed) return;
    state = next;
    for (const listener of stateListeners) listener(state);
  }

  const sendTransport = device.createSendTransport(sendParams);
  const recvTransport = device.createRecvTransport(recvParams);

  // Wire the DTLS handshake for both transports to `sfuConnectTransport`.
  for (const transport of [sendTransport, recvTransport]) {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      setState("connecting");
      void client
        .callCommand({
          op: "sfuConnectTransport",
          callId,
          transportId: transport.id,
          dtlsParameters,
        })
        .then(() => {
          callback();
          setState("connected");
        })
        .catch((error: unknown) => {
          errback(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  // Wire the send transport's `produce` event to `sfuProduce`; the server's
  // producer id is what mediasoup-client expects back.
  sendTransport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
    void client
      .callCommand({
        op: "sfuProduce",
        callId,
        transportId: sendTransport.id,
        kind,
        rtpParameters,
      })
      .then((result) => {
        const producerId = result.producer?.producerId;
        if (!producerId) {
          errback(new Error("sfuProduce result did not carry a producerId"));
          return;
        }
        callback({ id: producerId });
      })
      .catch((error: unknown) => {
        errback(error instanceof Error ? error : new Error(String(error)));
      });
  });

  // Produce each local track. mediasoup-client fires `connect` (once) then
  // `produce` synchronously inside `produce()`, so the commands above run here.
  if (localStream) {
    for (const track of localStream.getTracks()) {
      const producer = await sendTransport.produce({ track });
      producers.set(producer.id, producer);
      // FR-156: encrypt outbound frames before they reach the SFU. The producer
      // is the endpoint the Encoded Transform attaches to (a fake in tests).
      if (e2ee) {
        e2eeDetachers.push(
          e2ee.inserter.insert({
            direction: "encrypt",
            transform: e2ee.transform,
            endpoint: producer,
          }),
        );
      }
    }
  }

  async function consume(producerId: string): Promise<SfuRemoteTrack> {
    const existing = remoteTracks.get(producerId);
    if (existing) return existing;
    const inFlight = consuming.get(producerId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const result = await client.callCommand({
        op: "sfuConsume",
        callId,
        transportId: recvTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      const params = result.consumer;
      if (!params) {
        throw new Error("sfuConsume result did not carry a consumer");
      }
      const consumer = await recvTransport.consume({
        id: params.consumerId,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });
      consumers.set(consumer.id, consumer);
      // FR-156: decrypt inbound frames after they leave the SFU consumer.
      if (e2ee) {
        e2eeDetachers.push(
          e2ee.inserter.insert({
            direction: "decrypt",
            transform: e2ee.transform,
            endpoint: consumer,
          }),
        );
      }
      const remote: SfuRemoteTrack = {
        producerId: params.producerId,
        consumerId: consumer.id,
        kind: params.kind,
        track: consumer.track,
      };
      remoteTracks.set(producerId, remote);
      for (const listener of trackListeners) listener(remote);
      return remote;
    })();

    consuming.set(producerId, promise);
    try {
      return await promise;
    } finally {
      consuming.delete(producerId);
    }
  }

  const handle: SfuCallHandle = {
    device,
    sendTransport,
    recvTransport,
    producers,
    remoteTracks,
    get connectionState() {
      return state;
    },
    consume,
    onRemoteTrack(listener) {
      trackListeners.add(listener);
      return () => trackListeners.delete(listener);
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const detach of e2eeDetachers) detach();
      e2eeDetachers.length = 0;
      for (const consumer of consumers.values()) consumer.close();
      for (const producer of producers.values()) producer.close();
      sendTransport.close();
      recvTransport.close();
      trackListeners.clear();
      stateListeners.clear();
      state = "closed";
    },
  };

  return handle;
}
