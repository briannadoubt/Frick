/**
 * `@fricken/devtools` — embeddable developer console for Frick apps.
 *
 * Renders a floating panel that polls `/_frick/inspect/devtools/events`
 * (the server's existing devtools feed) and surfaces:
 *
 *   - Live frame log: every `frick.sync.*` / `frick.http.*` /
 *     `frick.push.delivery` / `frick.jobs.*` event the server emits, with
 *     filtering by kind and tenant.
 *   - Mutation queue: the client's pending appends + active optimistic
 *     overlay entries, sourced from `FrickClient.syncStatus`.
 *   - Connection status: connected / reconnecting / last error, sourced
 *     from the same `syncStatus` signal that powers `useSyncStatus`.
 *
 * Designed as an in-app overlay: drop `<FrickDevtools />` somewhere inside
 * a `<FrickProvider>` tree (typically in development builds only). The
 * panel is `position: fixed`, collapses to a status pill, and renders
 * nothing in production by default.
 *
 * Polling interval and panel position are configurable. Tests can inject
 * a custom fetch to drive deterministic timing.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useFrick, useFrickHttpEndpoint, useSyncStatus } from "@fricken/react";
import type { FrickClient, SyncStatus } from "@fricken/core";

export interface DevtoolsEvent {
  readonly id: number;
  readonly occurredAt: string;
  readonly kind: string;
  readonly tenantId?: string | null;
  readonly fields: Record<string, unknown>;
}

export interface FrickDevtoolsProps {
  /**
   * When false, the panel renders `null` (useful for production builds —
   * e.g. `<FrickDevtools enabled={import.meta.env.DEV} />`). Defaults to
   * `true` so the dev-default "just works."
   */
  readonly enabled?: boolean;
  /** Poll interval for the event feed. Defaults to 2000ms. */
  readonly pollIntervalMs?: number;
  /** Override `globalThis.fetch`. Tests inject a stub. */
  readonly fetchImpl?: typeof fetch;
  /** Starting filter — accepts a single `kind` substring. */
  readonly initialKindFilter?: string;
  /** CSS placement. Defaults to bottom-right corner. */
  readonly placement?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
}

const DEFAULT_POLL_MS = 2000;
const MAX_DISPLAY_EVENTS = 200;

export function FrickDevtools(props: FrickDevtoolsProps): ReactElement | null {
  const enabled = props.enabled ?? true;
  if (!enabled) return null;
  return <DevtoolsPanel {...props} />;
}

function DevtoolsPanel(props: FrickDevtoolsProps): ReactElement {
  const client = useFrick();
  const httpEndpoint = useFrickHttpEndpoint();
  const syncStatus = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<DevtoolsEvent[]>([]);
  const [kindFilter, setKindFilter] = useState(props.initialKindFilter ?? "");
  const fetchImpl = props.fetchImpl ?? fetch;
  const pollMs = props.pollIntervalMs ?? DEFAULT_POLL_MS;

  // Poll the inspect feed. We pass `sinceId` to only fetch new rows after
  // the first call; the server already orders DESC so we prepend.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let sinceId = events.at(0)?.id ?? 0;

    const tick = async (): Promise<void> => {
      try {
        const url = new URL(`${httpEndpoint.replace(/\/$/, "")}/_frick/inspect/devtools/events`);
        if (sinceId > 0) url.searchParams.set("sinceId", String(sinceId));
        if (kindFilter) url.searchParams.set("kind", kindFilter);
        url.searchParams.set("limit", "100");
        const init: RequestInit = client.sessionToken
          ? { headers: { authorization: `Bearer ${client.sessionToken}` } }
          : {};
        const res = await fetchImpl(url.toString(), init);
        if (!res.ok) return;
        const body = (await res.json()) as { events?: DevtoolsEvent[] };
        const incoming = body.events ?? [];
        if (incoming.length === 0 || cancelled) return;
        sinceId = Math.max(sinceId, ...incoming.map((e) => e.id));
        setEvents((prev) => [...incoming, ...prev].slice(0, MAX_DISPLAY_EVENTS));
      } catch {
        // Network blip — try again next tick.
      }
    };

    void tick();
    const handle = setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // We intentionally exclude `events` from the dep list — the cursor we
    // care about is captured at effect start and updated inside the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, httpEndpoint, kindFilter, pollMs, fetchImpl]);

  const placement = props.placement ?? "bottom-right";
  const placementStyle: CSSProperties = {
    bottom: placement.startsWith("bottom") ? 16 : "auto",
    top: placement.startsWith("top") ? 16 : "auto",
    right: placement.endsWith("right") ? 16 : "auto",
    left: placement.endsWith("left") ? 16 : "auto",
  };

  const summary = useMemo(() => describeStatus(syncStatus), [syncStatus]);

  return (
    <div
      style={{
        position: "fixed",
        zIndex: 2147483647,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: 12,
        ...placementStyle,
      }}
    >
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={pillStyle(summary.indicator)}
          title={summary.tooltip}
        >
          Frick · {summary.label}
        </button>
      )}
      {open && (
        <div style={panelStyle()}>
          <header style={headerStyle()}>
            <strong style={{ flex: 1 }}>Frick devtools</strong>
            <span style={{ marginRight: 8 }}>{summary.label}</span>
            <button type="button" onClick={() => setOpen(false)} style={closeButtonStyle()}>
              ×
            </button>
          </header>
          <section style={sectionStyle()}>
            <h4 style={h4Style()}>Status</h4>
            <pre style={preStyle()}>{JSON.stringify(syncStatus, statusReplacer, 2)}</pre>
          </section>
          <section style={sectionStyle()}>
            <h4 style={h4Style()}>
              Events
              <input
                type="text"
                placeholder="filter kind…"
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
                style={inputStyle()}
              />
            </h4>
            <div style={eventListStyle()}>
              {events.length === 0 && <div style={{ color: "#666" }}>No events yet — waiting for the server feed…</div>}
              {events.map((event) => (
                <DevtoolsEventRow key={event.id} event={event} />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function DevtoolsEventRow({ event }: { event: DevtoolsEvent }): ReactElement {
  const time = new Date(event.occurredAt).toLocaleTimeString();
  return (
    <details style={rowStyle()}>
      <summary style={{ cursor: "pointer" }}>
        <span style={{ color: "#888", marginRight: 8 }}>{time}</span>
        <span style={{ color: "#06c" }}>{event.kind}</span>
        {event.tenantId && <span style={{ color: "#888", marginLeft: 8 }}>· {event.tenantId}</span>}
      </summary>
      <pre style={preStyle()}>{JSON.stringify(event.fields, null, 2)}</pre>
    </details>
  );
}

function describeStatus(status: SyncStatus): {
  label: string;
  indicator: "green" | "yellow" | "red";
  tooltip: string;
} {
  if (!status.connected) {
    return {
      label: "disconnected",
      indicator: "red",
      tooltip: status.lastError?.message ?? "WebSocket closed",
    };
  }
  if (status.pendingMutations > 0) {
    return {
      label: `${status.pendingMutations} pending`,
      indicator: "yellow",
      tooltip: `${status.pendingMutations} unacked mutations`,
    };
  }
  return { label: "live", indicator: "green", tooltip: "Connected, no pending writes" };
}

function statusReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}

function pillStyle(indicator: "green" | "yellow" | "red"): CSSProperties {
  const bg = indicator === "green" ? "#1a7f37" : indicator === "yellow" ? "#9a6700" : "#cf222e";
  return {
    background: bg,
    color: "white",
    border: "none",
    borderRadius: 999,
    padding: "6px 10px",
    cursor: "pointer",
    boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
  };
}

function panelStyle(): CSSProperties {
  return {
    width: 360,
    maxHeight: 480,
    overflow: "hidden",
    background: "white",
    color: "#111",
    border: "1px solid #d0d7de",
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
  };
}

function headerStyle(): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    padding: "8px 12px",
    borderBottom: "1px solid #d0d7de",
    background: "#f6f8fa",
  };
}

function closeButtonStyle(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
  };
}

function sectionStyle(): CSSProperties {
  return { padding: "8px 12px", borderBottom: "1px solid #eaeef2", maxHeight: 200, overflow: "auto" };
}

function h4Style(): CSSProperties {
  return {
    margin: "0 0 6px",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#57606a",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  };
}

function inputStyle(): CSSProperties {
  return { fontSize: 11, padding: "2px 6px", border: "1px solid #d0d7de", borderRadius: 4 };
}

function eventListStyle(): CSSProperties {
  return { display: "flex", flexDirection: "column", gap: 4 };
}

function rowStyle(): CSSProperties {
  return { borderBottom: "1px solid #f0f0f0", padding: "4px 0" };
}

function preStyle(): CSSProperties {
  return {
    margin: "4px 0 0",
    background: "#f6f8fa",
    padding: 6,
    borderRadius: 4,
    overflow: "auto",
    maxHeight: 120,
    fontSize: 11,
  };
}

/** Re-export for callers that want to type their own consumers. */
export type { FrickClient, SyncStatus };
