/**
 * Lightweight in-process metrics: counters and gauges only. The framework
 * exposes a JSON snapshot at `/_frick/inspect/metrics` (when inspection is
 * enabled). There is no retention, no histograms, no Prometheus exposition —
 * operators are expected to scrape periodically and forward to an external
 * metrics backend if they want durable aggregation.
 *
 * Counters and gauges are keyed by `${name}|${stableFieldString}` so that the
 * same `(name, fields)` pair always returns the same handle. Field maps are
 * sorted by key before stringification to make handles stable regardless of
 * insertion order.
 */

export interface Counter {
  inc(by?: number): void;
  readonly value: number;
}

export interface Gauge {
  set(value: number): void;
  readonly value: number;
}

export interface MetricSnapshotEntry {
  name: string;
  fields?: Record<string, string>;
  value: number;
}

export interface MetricSnapshot {
  counters: MetricSnapshotEntry[];
  gauges: MetricSnapshotEntry[];
}

export interface FrickMetrics {
  counter(name: string, fields?: Record<string, string>): Counter;
  gauge(name: string, fields?: Record<string, string>): Gauge;
  snapshot(): MetricSnapshot;
}

export class NegativeCounterIncrementError extends Error {
  readonly reason = "negativeCounterIncrement";
  constructor(name: string, by: number) {
    super(`Counter "${name}" cannot be incremented by ${by}; only non-negative values are allowed`);
    this.name = "NegativeCounterIncrementError";
  }
}

interface CounterEntry {
  name: string;
  fields?: Record<string, string>;
  fieldKey: string;
  handle: Counter;
  value: number;
}

interface GaugeEntry {
  name: string;
  fields?: Record<string, string>;
  fieldKey: string;
  handle: Gauge;
  value: number;
}

function stableFieldKey(fields?: Record<string, string>): string {
  if (!fields) return "";
  const keys = Object.keys(fields).sort();
  if (keys.length === 0) return "";
  const sorted: Record<string, string> = {};
  for (const k of keys) sorted[k] = fields[k]!;
  return JSON.stringify(sorted);
}

function frozenFields(fields?: Record<string, string>): Record<string, string> | undefined {
  if (!fields) return undefined;
  const keys = Object.keys(fields).sort();
  if (keys.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = fields[k]!;
  return out;
}

export function createInMemoryMetrics(): FrickMetrics {
  const counters = new Map<string, CounterEntry>();
  const gauges = new Map<string, GaugeEntry>();

  function counter(name: string, fields?: Record<string, string>): Counter {
    const fieldKey = stableFieldKey(fields);
    const mapKey = `${name}|${fieldKey}`;
    const existing = counters.get(mapKey);
    if (existing) return existing.handle;
    const entry: CounterEntry = {
      name,
      ...(frozenFields(fields) ? { fields: frozenFields(fields)! } : {}),
      fieldKey,
      value: 0,
      handle: {
        inc(by = 1) {
          if (!Number.isFinite(by) || by < 0) {
            throw new NegativeCounterIncrementError(name, by);
          }
          entry.value += by;
        },
        get value() {
          return entry.value;
        },
      },
    };
    counters.set(mapKey, entry);
    return entry.handle;
  }

  function gauge(name: string, fields?: Record<string, string>): Gauge {
    const fieldKey = stableFieldKey(fields);
    const mapKey = `${name}|${fieldKey}`;
    const existing = gauges.get(mapKey);
    if (existing) return existing.handle;
    const entry: GaugeEntry = {
      name,
      ...(frozenFields(fields) ? { fields: frozenFields(fields)! } : {}),
      fieldKey,
      value: 0,
      handle: {
        set(value) {
          if (!Number.isFinite(value)) {
            throw new Error(`Gauge "${name}" requires a finite number; got ${value}`);
          }
          entry.value = value;
        },
        get value() {
          return entry.value;
        },
      },
    };
    gauges.set(mapKey, entry);
    return entry.handle;
  }

  function snapshot(): MetricSnapshot {
    const compare = (a: { name: string; fieldKey: string }, b: { name: string; fieldKey: string }) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      if (a.fieldKey < b.fieldKey) return -1;
      if (a.fieldKey > b.fieldKey) return 1;
      return 0;
    };
    const counterEntries = Array.from(counters.values()).sort(compare);
    const gaugeEntries = Array.from(gauges.values()).sort(compare);
    return {
      counters: counterEntries.map((entry) => ({
        name: entry.name,
        ...(entry.fields ? { fields: entry.fields } : {}),
        value: entry.value,
      })),
      gauges: gaugeEntries.map((entry) => ({
        name: entry.name,
        ...(entry.fields ? { fields: entry.fields } : {}),
        value: entry.value,
      })),
    };
  }

  return { counter, gauge, snapshot };
}
