import { describe, expect, it } from "vitest";
import type {
  CallCommandOp,
  CallCommandResultPayload,
  CallMediaGrant,
} from "@fricken/protocol";
import {
  startSfuCall,
  type CreateSfuDevice,
  type MediaStreamLike,
  type MediaStreamTrackLike,
  type SfuConsumeOptions,
  type SfuConsumerLike,
  type SfuDeviceLike,
  type SfuProducerLike,
  type SfuProduceEventArgs,
  type SfuRtpCapabilities,
  type SfuTransportLike,
  type SfuTransportOptions,
} from "../src/index.js";

/**
 * FR-155 — web client SFU produce/consume driver, driven against a fake
 * mediasoup-client `Device`/transports + a fake server that mirrors the
 * `SfuMediaPlaneAdapter` produce/consume companion. No DOM / no
 * `mediasoup-client`. Asserts: device loads with the grant's router caps;
 * transports complete their DTLS handshake via `sfuConnectTransport`; a local
 * track produces via `sfuProduce` → producerId; a remote producer is consumed
 * via `sfuConsume` → consumer with rtpParameters; and `close()` tears down.
 */

// -- fake mediasoup-client ---------------------------------------------------

type ConnectListener = (
  args: { dtlsParameters: Record<string, unknown> },
  callback: () => void,
  errback: (e: Error) => void,
) => void;
type ProduceListener = (
  args: SfuProduceEventArgs,
  callback: (r: { id: string }) => void,
  errback: (e: Error) => void,
) => void;

class FakeTransport implements SfuTransportLike {
  connectListener: ConnectListener | undefined;
  produceListener: ProduceListener | undefined;
  closed = false;
  readonly consumed: SfuConsumeOptions[] = [];
  #producerSeq = 0;

  constructor(
    readonly id: string,
    readonly direction: "send" | "recv",
  ) {}

  on(event: "connect" | "produce", listener: ConnectListener | ProduceListener): void {
    if (event === "connect") this.connectListener = listener as ConnectListener;
    else this.produceListener = listener as ProduceListener;
  }

  async produce(options: { track: MediaStreamTrackLike }): Promise<SfuProducerLike> {
    // mediasoup-client fires `connect` (once) then `produce` synchronously.
    await this.#fireConnect();
    const kind = options.track.kind === "audio" ? "audio" : "video";
    const id = await new Promise<string>((resolve, reject) => {
      this.produceListener?.(
        { kind, rtpParameters: { dummy: `rtp-${this.#producerSeq++}` } },
        (r) => resolve(r.id),
        reject,
      );
    });
    return { id, kind, close: () => undefined };
  }

  async consume(options: SfuConsumeOptions): Promise<SfuConsumerLike> {
    await this.#fireConnect();
    this.consumed.push(options);
    const track: MediaStreamTrackLike = { kind: options.kind, id: `track-${options.id}` };
    return {
      id: options.id,
      producerId: options.producerId,
      kind: options.kind,
      track,
      close: () => undefined,
    };
  }

  #connected = false;
  async #fireConnect(): Promise<void> {
    if (this.#connected || !this.connectListener) return;
    this.#connected = true;
    await new Promise<void>((resolve, reject) => {
      this.connectListener?.({ dtlsParameters: { role: "client" } }, resolve, reject);
    });
  }

  close(): void {
    this.closed = true;
  }
}

class FakeDevice implements SfuDeviceLike {
  loadedWith: SfuRtpCapabilities | undefined;
  readonly rtpCapabilities: SfuRtpCapabilities = { codecs: ["fake-client-caps"] };
  sendTransport: FakeTransport | undefined;
  recvTransport: FakeTransport | undefined;

  async load(options: { routerRtpCapabilities: SfuRtpCapabilities }): Promise<void> {
    this.loadedWith = options.routerRtpCapabilities;
  }

  createSendTransport(options: SfuTransportOptions): SfuTransportLike {
    this.sendTransport = new FakeTransport(options.id, "send");
    return this.sendTransport;
  }

  createRecvTransport(options: SfuTransportOptions): SfuTransportLike {
    this.recvTransport = new FakeTransport(options.id, "recv");
    return this.recvTransport;
  }
}

// -- fake server (mirrors SfuMediaPlaneAdapter produce/consume) ---------------

interface RecordedCommand {
  readonly command: CallCommandOp;
}

class FakeServer {
  readonly commands: RecordedCommand[] = [];
  readonly connectedTransports: string[] = [];
  #producerSeq = 0;
  #consumerSeq = 0;
  /** Producers other participants have created, available to consume. */
  readonly remoteProducers = new Map<string, { kind: "audio" | "video" }>();

  async callCommand(command: CallCommandOp): Promise<CallCommandResultPayload> {
    this.commands.push({ command });
    const requestId = "req";
    switch (command.op) {
      case "sfuConnectTransport":
        this.connectedTransports.push(command.transportId);
        return { requestId, op: "sfuConnectTransport" };
      case "sfuProduce": {
        const producerId = `producer-${this.#producerSeq++}`;
        return {
          requestId,
          op: "sfuProduce",
          producer: { producerId, kind: command.kind },
        };
      }
      case "sfuConsume": {
        const producer = this.remoteProducers.get(command.producerId);
        if (!producer) throw new Error(`no such producer ${command.producerId}`);
        return {
          requestId,
          op: "sfuConsume",
          consumer: {
            consumerId: `consumer-${this.#consumerSeq++}`,
            producerId: command.producerId,
            kind: producer.kind,
            rtpParameters: { source: command.producerId },
          },
        };
      }
      default:
        throw new Error(`unexpected op ${command.op}`);
    }
  }
}

// -- fixtures ----------------------------------------------------------------

function makeGrant(): CallMediaGrant {
  return {
    callId: "call-1",
    mediaSessionId: "router-1",
    userId: "u1",
    deviceId: "d1",
    token: "0.mac",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    connection: {
      routerRtpCapabilities: JSON.stringify({ codecs: ["router-caps"] }),
      sendTransport: JSON.stringify({
        id: "send-1",
        iceParameters: { usernameFragment: "u", password: "p" },
        iceCandidates: [],
        dtlsParameters: { fingerprints: [] },
      }),
      recvTransport: JSON.stringify({
        id: "recv-1",
        iceParameters: { usernameFragment: "u", password: "p" },
        iceCandidates: [],
        dtlsParameters: { fingerprints: [] },
      }),
      announcedIp: "203.0.113.7",
    },
  };
}

function makeLocalStream(): MediaStreamLike {
  const tracks: MediaStreamTrackLike[] = [
    { kind: "audio", id: "mic" },
    { kind: "video", id: "cam" },
  ];
  return { id: "local", getTracks: () => tracks };
}

describe("startSfuCall", () => {
  it("loads the device, connects transports, and produces local tracks", async () => {
    const server = new FakeServer();
    const device = new FakeDevice();
    const createDevice: CreateSfuDevice = () => device;

    const handle = await startSfuCall(server, {
      callId: "call-1",
      participant: { userId: "u1", deviceId: "d1" },
      grant: makeGrant(),
      localStream: makeLocalStream(),
      createDevice,
    });

    // Device loaded with the grant's router capabilities.
    expect(device.loadedWith).toEqual({ codecs: ["router-caps"] });

    // Send transport's DTLS handshake completed via sfuConnectTransport.
    expect(server.connectedTransports).toContain("send-1");

    // Both local tracks produced → two producers with server-assigned ids.
    expect(handle.producers.size).toBe(2);
    expect([...handle.producers.keys()]).toEqual(["producer-0", "producer-1"]);

    const produceCommands = server.commands.filter((c) => c.command.op === "sfuProduce");
    expect(produceCommands).toHaveLength(2);
    expect(handle.connectionState).toBe("connected");

    handle.close();
    expect(device.sendTransport?.closed).toBe(true);
    expect(device.recvTransport?.closed).toBe(true);
    expect(handle.connectionState).toBe("closed");
  });

  it("consumes a remote producer via sfuConsume and exposes the remote track", async () => {
    const server = new FakeServer();
    server.remoteProducers.set("producer-remote", { kind: "video" });
    const device = new FakeDevice();

    const received: string[] = [];
    const handle = await startSfuCall(server, {
      callId: "call-1",
      participant: { userId: "u1", deviceId: "d1" },
      grant: makeGrant(),
      createDevice: () => device,
    });
    handle.onRemoteTrack((t) => received.push(t.producerId));

    const remote = await handle.consume("producer-remote");

    expect(remote.kind).toBe("video");
    expect(remote.producerId).toBe("producer-remote");
    expect(remote.consumerId).toBe("consumer-0");
    expect(remote.track.kind).toBe("video");
    expect(received).toEqual(["producer-remote"]);

    // The recv transport got the consumer params from the sfuConsume result.
    expect(device.recvTransport?.consumed[0]).toMatchObject({
      id: "consumer-0",
      producerId: "producer-remote",
      kind: "video",
      rtpParameters: { source: "producer-remote" },
    });

    // The consume command carried the device's own rtp capabilities.
    const consumeCmd = server.commands.find((c) => c.command.op === "sfuConsume");
    expect(consumeCmd?.command).toMatchObject({
      op: "sfuConsume",
      producerId: "producer-remote",
      rtpCapabilities: { codecs: ["fake-client-caps"] },
    });
  });

  it("dedupes consume per producer id (idempotent)", async () => {
    const server = new FakeServer();
    server.remoteProducers.set("p", { kind: "audio" });
    const device = new FakeDevice();
    const handle = await startSfuCall(server, {
      callId: "call-1",
      participant: { userId: "u1", deviceId: "d1" },
      grant: makeGrant(),
      createDevice: () => device,
    });

    const [a, b] = await Promise.all([handle.consume("p"), handle.consume("p")]);
    expect(a).toBe(b);
    const consumeCalls = server.commands.filter((c) => c.command.op === "sfuConsume");
    expect(consumeCalls).toHaveLength(1);

    // A second consume after resolution still returns the cached track.
    expect(await handle.consume("p")).toBe(a);
    expect(server.commands.filter((c) => c.command.op === "sfuConsume")).toHaveLength(1);
  });

  it("propagates a produce failure from the server", async () => {
    const failing = {
      async callCommand(command: CallCommandOp): Promise<CallCommandResultPayload> {
        if (command.op === "sfuConnectTransport") {
          return { requestId: "r", op: "sfuConnectTransport" };
        }
        throw new Error("produce rejected by plane");
      },
    };
    const device = new FakeDevice();
    await expect(
      startSfuCall(failing, {
        callId: "call-1",
        participant: { userId: "u1", deviceId: "d1" },
        grant: makeGrant(),
        localStream: makeLocalStream(),
        createDevice: () => device,
      }),
    ).rejects.toThrow(/produce rejected/);
  });
});
