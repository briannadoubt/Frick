import {
  SpanKind,
  SpanStatusCode,
  metrics,
  trace,
  type Counter,
  type Histogram,
  type Tracer,
  type UpDownCounter,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { FrameKind } from "@frick/protocol";
import type { FrickConfig } from "../config.js";
import type { FrickLogger } from "../logger.js";

export interface FrickHttpTelemetryRequest {
  requestId: string;
  method: string;
  path: string;
  host: string | undefined;
}

export interface FrickHttpTelemetryResult {
  statusCode: number;
  durationMs: number;
  tenantId: string | undefined;
  userId: string | undefined;
}

export interface FrickHttpTelemetrySpan {
  end(result: FrickHttpTelemetryResult): void;
}

export interface FrickWebSocketConnectionTelemetry {
  clientId: string;
  tenantId: string | undefined;
  userId: string | undefined;
}

export interface FrickWebSocketConnectionTelemetryPrincipal {
  tenantId: string;
  userId: string;
}

export type FrickWebSocketCloseCategory =
  | "normal"
  | "going_away"
  | "protocol_error"
  | "unsupported_data"
  | "no_status"
  | "abnormal"
  | "invalid_payload"
  | "policy_violation"
  | "too_large"
  | "mandatory_extension"
  | "internal_error"
  | "service_restart"
  | "try_again_later"
  | "bad_gateway"
  | "tls_handshake"
  | "private"
  | "unknown";

export interface FrickWebSocketConnectionTelemetryResult {
  durationMs: number;
  frameCounts: Record<string, number>;
  closeCode: number | undefined;
  closeCategory: FrickWebSocketCloseCategory;
}

export interface FrickWebSocketConnectionTelemetrySpan {
  authenticate?(principal: FrickWebSocketConnectionTelemetryPrincipal): void;
  end(result: FrickWebSocketConnectionTelemetryResult): void;
}

export interface FrickWebSocketFrameTelemetry {
  kind: string;
  byteLength: number;
  tenantId: string | undefined;
  userId: string | undefined;
}

export interface FrickJobTelemetryRun {
  jobId: number;
  jobType: string;
  tenantId: string;
  attemptCount: number;
  workerId: string;
}

export interface FrickJobTelemetryResult {
  status: "completed" | "failed" | "dead_lettered";
  durationMs: number;
  errorCode?: string;
  retryable?: boolean;
}

export interface FrickJobTelemetrySpan {
  end(result: FrickJobTelemetryResult): void;
}

export interface FrickTelemetryRuntime {
  readonly enabled: boolean;
  start(): Promise<void>;
  startHttpRequest(input: FrickHttpTelemetryRequest): FrickHttpTelemetrySpan;
  startWebSocketConnection?(input: FrickWebSocketConnectionTelemetry): FrickWebSocketConnectionTelemetrySpan;
  recordWebSocketFrame?(input: FrickWebSocketFrameTelemetry): void;
  startJobRun?(input: FrickJobTelemetryRun): FrickJobTelemetrySpan;
  shutdown(): Promise<void>;
}

const noopHttpSpan: FrickHttpTelemetrySpan = {
  end: () => {},
};
const noopWebSocketConnectionSpan: FrickWebSocketConnectionTelemetrySpan = {
  end: () => {},
};
const noopJobSpan: FrickJobTelemetrySpan = {
  end: () => {},
};

export function createNoopTelemetryRuntime(): FrickTelemetryRuntime {
  return {
    enabled: false,
    start: async () => {},
    startHttpRequest: () => noopHttpSpan,
    startWebSocketConnection: () => noopWebSocketConnectionSpan,
    recordWebSocketFrame: () => {},
    startJobRun: () => noopJobSpan,
    shutdown: async () => {},
  };
}

export function createFrickTelemetryRuntime(input: {
  config: Pick<
    FrickConfig,
    | "otelEnabled"
    | "otelServiceName"
    | "otelExporterOtlpEndpoint"
    | "otelExporterOtlpTracesEndpoint"
    | "otelExporterOtlpMetricsEndpoint"
    | "otelMetricExportIntervalMs"
  >;
  logger: FrickLogger;
}): FrickTelemetryRuntime {
  const { config, logger } = input;
  if (!config.otelEnabled) {
    return createNoopTelemetryRuntime();
  }

  const sdk = new NodeSDK({
    serviceName: config.otelServiceName,
    traceExporter: new OTLPTraceExporter(
      exporterConfig(config.otelExporterOtlpEndpoint, config.otelExporterOtlpTracesEndpoint, "traces"),
    ),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(
          exporterConfig(config.otelExporterOtlpEndpoint, config.otelExporterOtlpMetricsEndpoint, "metrics"),
        ),
        exportIntervalMillis: config.otelMetricExportIntervalMs,
      }),
    ],
  });
  let started = false;
  let instruments:
    | {
        tracer: Tracer;
        requestCounter: Counter;
        requestDuration: Histogram;
        webSocketConnections: UpDownCounter;
        webSocketFrames: Counter;
        webSocketFrameBytes: Histogram;
        webSocketConnectionDuration: Histogram;
        jobRuns: Counter;
        jobDuration: Histogram;
      }
    | undefined;

  function ensureInstruments() {
    if (instruments) return instruments;
    const tracer = trace.getTracer("frick-server");
    const meter = metrics.getMeter("frick-server");
    instruments = {
      tracer,
      requestCounter: meter.createCounter("frick.http.server.requests", {
        description: "HTTP requests served by the Frick server",
      }),
      requestDuration: meter.createHistogram("frick.http.server.duration_ms", {
        description: "HTTP server request duration in milliseconds",
        unit: "ms",
      }),
      webSocketConnections: meter.createUpDownCounter("frick.ws.connections.current", {
        description: "Active Frick WebSocket connections",
      }),
      webSocketFrames: meter.createCounter("frick.ws.frames.total", {
        description: "Inbound Frick WebSocket frames",
      }),
      webSocketFrameBytes: meter.createHistogram("frick.ws.frame.bytes", {
        description: "Inbound Frick WebSocket frame size in bytes",
        unit: "By",
      }),
      webSocketConnectionDuration: meter.createHistogram("frick.ws.connection.duration_ms", {
        description: "Frick WebSocket connection duration in milliseconds",
        unit: "ms",
      }),
      jobRuns: meter.createCounter("frick.jobs.runs.total", {
        description: "Frick background job runs",
      }),
      jobDuration: meter.createHistogram("frick.jobs.run.duration_ms", {
        description: "Frick background job run duration in milliseconds",
        unit: "ms",
      }),
    };
    return instruments;
  }

  return {
    enabled: true,
    async start() {
      if (started) return;
      try {
        sdk.start();
        started = true;
        ensureInstruments();
        logger.info("frick.otel.started", {
          event: "frick.otel.started",
          serviceName: config.otelServiceName,
          exporterOtlpEndpoint: config.otelExporterOtlpEndpoint,
        });
      } catch (err) {
        logger.warn("frick.otel.start_failed", {
          event: "frick.otel.start_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    startHttpRequest(request) {
      if (!started) return noopHttpSpan;
      const { tracer, requestCounter, requestDuration } = ensureInstruments();
      const attributes = {
        "http.request.method": request.method,
        "url.path": request.path,
        "server.address": request.host ?? "",
        "frick.request_id": request.requestId,
      };
      const span = tracer.startSpan(`HTTP ${request.method} ${request.path}`, {
        kind: SpanKind.SERVER,
        attributes,
      });
      return {
        end(result) {
          const resultAttributes = {
            ...attributes,
            "http.response.status_code": result.statusCode,
            ...(result.tenantId !== undefined ? { "frick.tenant_id": result.tenantId } : {}),
            ...(result.userId !== undefined ? { "enduser.id": result.userId } : {}),
          };
          span.setAttributes(resultAttributes);
          if (result.statusCode >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          span.end();
          requestCounter.add(1, {
            method: request.method,
            status: String(result.statusCode),
          });
          requestDuration.record(result.durationMs, {
            method: request.method,
            status: String(result.statusCode),
          });
        },
      };
    },
    startWebSocketConnection(input) {
      if (!started) return noopWebSocketConnectionSpan;
      const { tracer, webSocketConnections, webSocketConnectionDuration } = ensureInstruments();
      let attributes = connectionSpanAttributes(input);
      let metricAttributes = webSocketConnectionMetricAttributes(input.userId !== undefined);
      const span = tracer.startSpan("WebSocket /_frick/sync", {
        kind: SpanKind.SERVER,
        attributes,
      });
      webSocketConnections.add(1, metricAttributes);
      return {
        authenticate(principal) {
          const nextAttributes = {
            ...attributes,
            "frick.tenant_id": principal.tenantId,
            "enduser.id": principal.userId,
          };
          attributes = nextAttributes;
          span.setAttributes(nextAttributes);
          const nextMetricAttributes = webSocketConnectionMetricAttributes(true);
          if (metricAttributes.authenticated !== nextMetricAttributes.authenticated) {
            webSocketConnections.add(-1, metricAttributes);
            webSocketConnections.add(1, nextMetricAttributes);
            metricAttributes = nextMetricAttributes;
          }
        },
        end(result) {
          const resultAttributes = {
            ...attributes,
            ...(result.closeCode !== undefined ? { "frick.ws.close_code": result.closeCode } : {}),
            "frick.ws.close_category": result.closeCategory,
          };
          span.setAttributes(resultAttributes);
          for (const [kind, count] of Object.entries(result.frameCounts)) {
            span.setAttribute(`frick.ws.frames.${kind}`, count);
          }
          webSocketConnections.add(-1, metricAttributes);
          webSocketConnectionDuration.record(result.durationMs, metricAttributes);
          span.end();
        },
      };
    },
    recordWebSocketFrame(input) {
      if (!started) return;
      const { webSocketFrames, webSocketFrameBytes } = ensureInstruments();
      const attributes = {
        kind: boundedWebSocketFrameKind(input.kind),
      };
      webSocketFrames.add(1, attributes);
      webSocketFrameBytes.record(input.byteLength, attributes);
    },
    startJobRun(input) {
      if (!started) return noopJobSpan;
      const { tracer, jobRuns, jobDuration } = ensureInstruments();
      const attributes = {
        "frick.job.id": input.jobId,
        "frick.job.type": input.jobType,
        "frick.tenant_id": input.tenantId,
        "frick.job.attempt_count": input.attemptCount,
        "frick.job.worker_id": input.workerId,
      };
      const span = tracer.startSpan(`job ${input.jobType}`, {
        kind: SpanKind.INTERNAL,
        attributes,
      });
      return {
        end(result) {
          const resultAttributes = {
            ...attributes,
            "frick.job.status": result.status,
            ...(result.errorCode !== undefined ? { "frick.job.error_code": result.errorCode } : {}),
            ...(result.retryable !== undefined ? { "frick.job.retryable": String(result.retryable) } : {}),
          };
          span.setAttributes(resultAttributes);
          if (result.status !== "completed") {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          span.end();
          jobRuns.add(1, {
            jobType: input.jobType,
            status: result.status,
          });
          jobDuration.record(result.durationMs, {
            jobType: input.jobType,
            status: result.status,
          });
        },
      };
    },
    async shutdown() {
      if (!started) return;
      started = false;
      try {
        await sdk.shutdown();
      } catch (err) {
        logger.warn("frick.otel.shutdown_failed", {
          event: "frick.otel.shutdown_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

function connectionSpanAttributes(input: FrickWebSocketConnectionTelemetry): Record<string, string> {
  return {
    "network.protocol.name": "websocket",
    "url.path": "/_frick/sync",
    "frick.ws.client_id": input.clientId,
    ...(input.tenantId !== undefined ? { "frick.tenant_id": input.tenantId } : {}),
    ...(input.userId !== undefined ? { "enduser.id": input.userId } : {}),
  };
}

function webSocketConnectionMetricAttributes(authenticated: boolean): { authenticated: string } {
  return { authenticated: String(authenticated) };
}

function boundedWebSocketFrameKind(kind: string): string {
  return knownFrameKindLabels.has(kind) ? kind : "unknown";
}

const knownFrameKindLabels = new Set([
  ...Object.keys(FrameKind).filter((key) => Number.isNaN(Number(key))),
  "unknown",
]);

function exporterConfig(
  baseEndpoint: string | undefined,
  signalEndpointOverride: string | undefined,
  signal: "traces" | "metrics",
): { url?: string } {
  if (signalEndpointOverride) return { url: signalEndpointOverride };
  if (!baseEndpoint) return {};
  return { url: signalEndpoint(baseEndpoint, signal) };
}

function signalEndpoint(baseEndpoint: string, signal: "traces" | "metrics"): string {
  const trimmed = baseEndpoint.replace(/\/+$/, "");
  if (trimmed.endsWith(`/v1/${signal}`)) return trimmed;
  if (trimmed.endsWith("/v1/traces") || trimmed.endsWith("/v1/metrics")) {
    return trimmed.replace(/\/v1\/(?:traces|metrics)$/, `/v1/${signal}`);
  }
  return `${trimmed}/v1/${signal}`;
}
