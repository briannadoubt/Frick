import {
  SpanKind,
  SpanStatusCode,
  metrics,
  trace,
  type Counter,
  type Histogram,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
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

export interface FrickTelemetryRuntime {
  readonly enabled: boolean;
  start(): Promise<void>;
  startHttpRequest(input: FrickHttpTelemetryRequest): FrickHttpTelemetrySpan;
  shutdown(): Promise<void>;
}

const noopHttpSpan: FrickHttpTelemetrySpan = {
  end: () => {},
};

export function createNoopTelemetryRuntime(): FrickTelemetryRuntime {
  return {
    enabled: false,
    start: async () => {},
    startHttpRequest: () => noopHttpSpan,
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
