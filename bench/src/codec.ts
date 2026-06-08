import { performance } from "node:perf_hooks";
import {
  FrameKind,
  decodeFrame,
  encodeFrame,
  packObjectRecord,
  packStreamEvent,
  productTestSchema,
  type FrickFrame,
  type FrickSchema,
} from "@fricken/protocol";
import { summarizeLatency, type LatencySummary } from "./harness.js";

/**
 * FR-99 — Codec speed benchmark suite.
 *
 * Measures wire-codec encode + decode throughput/latency over a set of
 * representative frame shapes, with NO server in the loop — it benchmarks the
 * `@fricken/protocol` msgpack codec (`encodeFrame` / `decodeFrame`) in pure
 * isolation. The same payload shapes are mirrored by the Swift
 * (`FrickCodecBenchmarkTests`) and Kotlin (`FrickCodecBenchmarkTest`) micro
 * benchmarks so results are comparable across platforms.
 *
 * Per payload shape we time:
 *   - `encode` — building the on-wire `Uint8Array` from the in-memory frame.
 *   - `decode` — parsing a pre-encoded `Uint8Array` back into a frame.
 *
 * Each is timed in batches (a tight loop of `--ops` iterations per sample,
 * `--samples` samples) so the per-op cost is amortized over a measurable batch
 * and we get a percentile distribution of batch timings. Correctness lives in
 * the protocol test suite; this module only measures.
 */

/** Representative payload shapes benchmarked on every platform. */
export type CodecPayloadName =
  | "appendMessage"
  | "objectUpsert"
  | "streamPage"
  | "delta";

export const CODEC_PAYLOAD_NAMES: readonly CodecPayloadName[] = [
  "appendMessage",
  "objectUpsert",
  "streamPage",
  "delta",
];

export interface CodecConfig {
  /** Operations (encode-or-decode calls) per timed sample. */
  readonly ops: number;
  /** Timed samples per direction per payload (each yields one batch timing). */
  readonly samples: number;
  /** Encoded-event count packed into the multi-event `streamPage`/`delta` shapes. */
  readonly pageEvents: number;
  /** Schema to drive the structural packers. Defaults to the product test fixture. */
  readonly schema?: FrickSchema;
}

export const DEFAULT_CODEC_CONFIG: CodecConfig = {
  ops: 2_000,
  samples: 30,
  pageEvents: 32,
};

export interface CodecDirectionResult {
  /** Total individual encode/decode calls measured (ops * samples). */
  readonly operations: number;
  /** Encoded byte length of one payload of this shape (encode/decode operate on this). */
  readonly bytes: number;
  /** Per-op latency percentiles, in microseconds (batch time / ops). */
  readonly perOpMicros: LatencySummary;
  /** Mean encode/decode calls per second across all samples. */
  readonly opsPerSec: number;
  /** Mean encoded bytes processed per second (opsPerSec * bytes). */
  readonly bytesPerSec: number;
}

export interface CodecPayloadResult {
  readonly bytes: number;
  readonly encode: CodecDirectionResult;
  readonly decode: CodecDirectionResult;
}

export interface CodecResult {
  readonly schemaVersion: 1;
  readonly tool: "frick-codec-bench";
  readonly startedAt: string;
  readonly config: CodecConfig;
  readonly env: {
    readonly node: string;
    readonly platform: string;
  };
  readonly totalDurationMs: number;
  readonly payloads: Record<CodecPayloadName, CodecPayloadResult>;
}

const STREAM = "MessageStream";
const OBJECT_TYPE = "Conversation";

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Build the set of representative frames to benchmark. Deterministic, so the
 * same shapes are produced run to run (and mirror the native benches). The
 * multi-event shapes (`streamPage`, `delta`) carry `pageEvents` packed events.
 */
export function buildCodecFrames(
  schema: FrickSchema,
  pageEvents: number,
): Record<CodecPayloadName, FrickFrame> {
  const packedEvents = Array.from({ length: pageEvents }, (_, i) =>
    packStreamEvent(schema, {
      stream: STREAM,
      streamId: "bench-conv",
      sequence: i + 1,
      eventId: `evt-${i}`,
      event: "MessageSent",
      payload: {
        messageId: `msg-${i}`,
        senderId: "user-bench",
        body: `representative message body number ${i} with some unicode ☃ and length`,
        createdAt: "2026-06-07T00:00:00.000Z",
      },
    }),
  );

  const packedConversation = packObjectRecord(schema, OBJECT_TYPE, "bench-conv", {
    kind: "group",
    title: "Representative bench conversation",
    createdBy: "user-bench",
    lastMessageEventId: "evt-31",
  });

  return {
    appendMessage: [
      FrameKind.Append,
      {
        requestId: "bench-append-1",
        stream: STREAM,
        key: "bench-conv",
        event: "MessageSent",
        payload: {
          messageId: "msg-append",
          senderId: "user-bench",
          body: "representative single-message append payload with unicode ☃",
          createdAt: "2026-06-07T00:00:00.000Z",
        },
      },
    ],
    objectUpsert: [
      FrameKind.ObjectUpsert,
      {
        requestId: "bench-upsert-1",
        objectType: OBJECT_TYPE,
        objectId: "bench-conv",
        value: {
          kind: "group",
          title: "Representative bench conversation",
          createdBy: "user-bench",
          lastMessageEventId: "evt-31",
        },
      },
    ],
    streamPage: [
      FrameKind.StreamPage,
      {
        subscriptionId: "bench-sub",
        events: packedEvents,
        cursor: pageEvents,
        hasMore: false,
      },
    ],
    delta: [
      FrameKind.Delta,
      {
        objects: [packedConversation],
        events: packedEvents,
        cursor: pageEvents,
      },
    ],
  };
}

/** Time a tight loop of `ops` calls, repeated for `samples`, returning per-op stats. */
function measureDirection(
  fn: () => void,
  ops: number,
  samples: number,
  bytes: number,
): CodecDirectionResult {
  const perOpMicros: number[] = [];
  const perSampleOpsPerSec: number[] = [];

  // Warm up so JIT compilation doesn't skew the first sample.
  for (let i = 0; i < ops; i += 1) fn();

  for (let s = 0; s < samples; s += 1) {
    const start = performance.now();
    for (let i = 0; i < ops; i += 1) fn();
    const elapsedMs = performance.now() - start;
    perOpMicros.push((elapsedMs * 1000) / ops);
    perSampleOpsPerSec.push(elapsedMs > 0 ? (ops / elapsedMs) * 1000 : 0);
  }

  const meanOpsPerSec =
    perSampleOpsPerSec.reduce((acc, v) => acc + v, 0) / perSampleOpsPerSec.length;

  return {
    operations: ops * samples,
    bytes,
    perOpMicros: summarizeLatency(perOpMicros),
    opsPerSec: round(meanOpsPerSec),
    bytesPerSec: round(meanOpsPerSec * bytes),
  };
}

/**
 * Run the codec suite and return a structured JSON result. Pure CPU work — no
 * server, no sockets, no I/O — so it is fast and deterministic.
 */
export function runCodec(configIn: Partial<CodecConfig> = {}): CodecResult {
  const config: CodecConfig = { ...DEFAULT_CODEC_CONFIG, ...configIn };
  const schema = config.schema ?? productTestSchema;
  const startedAt = new Date().toISOString();
  const totalStart = performance.now();

  const frames = buildCodecFrames(schema, config.pageEvents);

  const payloads = {} as Record<CodecPayloadName, CodecPayloadResult>;
  for (const name of CODEC_PAYLOAD_NAMES) {
    const frame = frames[name];
    const encoded = encodeFrame(frame);
    const bytes = encoded.byteLength;

    const encode = measureDirection(
      () => {
        encodeFrame(frame);
      },
      config.ops,
      config.samples,
      bytes,
    );
    const decode = measureDirection(
      () => {
        decodeFrame(encoded);
      },
      config.ops,
      config.samples,
      bytes,
    );

    payloads[name] = { bytes, encode, decode };
  }

  return {
    schemaVersion: 1,
    tool: "frick-codec-bench",
    startedAt,
    config,
    env: {
      node: process.version,
      platform: process.platform,
    },
    totalDurationMs: round(performance.now() - totalStart),
    payloads,
  };
}
