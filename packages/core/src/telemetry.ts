import {
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
  metrics,
  trace,
  type Counter,
  type Histogram,
  type Span,
  type Tracer,
  type Meter,
} from "@opentelemetry/api";

export type FrickClientTelemetryAttributes = Record<string, string | number | boolean>;

export interface FrickClientTelemetrySpanStart {
  name: string;
  kind?: "client" | "internal";
  attributes?: FrickClientTelemetryAttributes;
}

export interface FrickClientTelemetrySpanResult {
  status?: "ok" | "error";
  attributes?: FrickClientTelemetryAttributes;
  error?: unknown;
}

export interface FrickClientTelemetrySpan {
  readonly traceId?: string | undefined;
  injectHeaders?(headers: Record<string, string>): void;
  setAttributes?(attributes: FrickClientTelemetryAttributes): void;
  end(result?: FrickClientTelemetrySpanResult): void;
}

export interface FrickClientTelemetryRuntime {
  startSpan(input: FrickClientTelemetrySpanStart): FrickClientTelemetrySpan;
  recordCounter?(name: string, value: number, attributes?: FrickClientTelemetryAttributes): void;
  recordHistogram?(name: string, value: number, attributes?: FrickClientTelemetryAttributes): void;
}

export interface OpenTelemetryClientRuntimeOptions {
  tracerName?: string;
  meterName?: string;
  version?: string;
}

const noopClientTelemetrySpan: FrickClientTelemetrySpan = {
  end: () => {},
};

export function createNoopClientTelemetryRuntime(): FrickClientTelemetryRuntime {
  return {
    startSpan: () => noopClientTelemetrySpan,
    recordCounter: () => {},
    recordHistogram: () => {},
  };
}

let configuredDefaultClientTelemetryRuntime: FrickClientTelemetryRuntime | undefined;

export function defaultClientTelemetryRuntime(): FrickClientTelemetryRuntime {
  return configuredDefaultClientTelemetryRuntime ?? sharedOpenTelemetryClientRuntime;
}

export function setDefaultClientTelemetryRuntime(
  runtime: FrickClientTelemetryRuntime | undefined,
): () => void {
  const previous = configuredDefaultClientTelemetryRuntime;
  configuredDefaultClientTelemetryRuntime = runtime;
  return () => {
    configuredDefaultClientTelemetryRuntime = previous;
  };
}

export function createOpenTelemetryClientRuntime(
  options: OpenTelemetryClientRuntimeOptions = {},
): FrickClientTelemetryRuntime {
  const tracerName = options.tracerName ?? "frick-client";
  const meterName = options.meterName ?? "frick-client";
  let tracer: Tracer | undefined;
  let meter: Meter | undefined;
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();

  const getTracer = (): Tracer => {
    tracer ??= trace.getTracer(tracerName, options.version);
    return tracer;
  };
  const getMeter = (): Meter => {
    meter ??= metrics.getMeter(meterName, options.version);
    return meter;
  };

  return {
    startSpan(input) {
      const span = getTracer().startSpan(input.name, {
        kind: input.kind === "internal" ? SpanKind.INTERNAL : SpanKind.CLIENT,
        ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
      });
      return openTelemetrySpan(span);
    },
    recordCounter(name, value, attributes) {
      let counter = counters.get(name);
      if (!counter) {
        counter = getMeter().createCounter(name);
        counters.set(name, counter);
      }
      counter.add(value, attributes);
    },
    recordHistogram(name, value, attributes) {
      let histogram = histograms.get(name);
      if (!histogram) {
        histogram = getMeter().createHistogram(name, name.endsWith("_ms") ? { unit: "ms" } : undefined);
        histograms.set(name, histogram);
      }
      histogram.record(value, attributes);
    },
  };
}

const sharedOpenTelemetryClientRuntime = createOpenTelemetryClientRuntime();

export function startClientTelemetrySpan(
  telemetry: FrickClientTelemetryRuntime,
  input: FrickClientTelemetrySpanStart,
): FrickClientTelemetrySpan {
  try {
    return telemetry.startSpan(input);
  } catch {
    return noopClientTelemetrySpan;
  }
}

export function injectClientTelemetryHeaders(
  span: FrickClientTelemetrySpan,
  headers: Record<string, string>,
): void {
  try {
    span.injectHeaders?.(headers);
  } catch {
    // Telemetry must never affect framework requests.
  }
}

export function setClientTelemetryAttributes(
  span: FrickClientTelemetrySpan,
  attributes: FrickClientTelemetryAttributes,
): void {
  try {
    span.setAttributes?.(attributes);
  } catch {
    // Telemetry must never affect framework behavior.
  }
}

export function finishClientTelemetrySpan(
  span: FrickClientTelemetrySpan,
  result?: FrickClientTelemetrySpanResult,
): void {
  try {
    span.end(result);
  } catch {
    // Telemetry must never affect framework behavior.
  }
}

export function recordClientTelemetryCounter(
  telemetry: FrickClientTelemetryRuntime,
  name: string,
  value: number,
  attributes?: FrickClientTelemetryAttributes,
): void {
  try {
    telemetry.recordCounter?.(name, value, attributes);
  } catch {
    // Telemetry must never affect framework behavior.
  }
}

export function recordClientTelemetryHistogram(
  telemetry: FrickClientTelemetryRuntime,
  name: string,
  value: number,
  attributes?: FrickClientTelemetryAttributes,
): void {
  try {
    telemetry.recordHistogram?.(name, value, attributes);
  } catch {
    // Telemetry must never affect framework behavior.
  }
}

function openTelemetrySpan(span: Span): FrickClientTelemetrySpan {
  const spanContext = span.spanContext();
  const traceId = isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
  return {
    traceId,
    injectHeaders(headers) {
      if (!isSpanContextValid(spanContext)) return;
      const flags = spanContext.traceFlags.toString(16).padStart(2, "0");
      headers.traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
    },
    setAttributes(attributes) {
      span.setAttributes(attributes);
    },
    end(result) {
      if (result?.attributes) {
        span.setAttributes(result.attributes);
      }
      if (result?.error !== undefined) {
        recordSpanException(span, result.error);
      }
      if (result?.status === "error") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    },
  };
}

function recordSpanException(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
  } else if (typeof error === "string") {
    span.recordException(error);
  } else {
    span.recordException(String(error));
  }
}
