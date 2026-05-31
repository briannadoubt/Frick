import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AreaChart,
  BarChart,
  ChartSurface,
  Column,
  DataGrid,
  DataTable,
  DatePicker,
  DateRangePicker,
  DateTimePicker,
  LineChart,
  Metric,
  MetricCard,
  PieChart,
  Sparkline,
  Table,
  TimePicker,
  Timeline,
} from "./index.js";

const rows = [
  { id: "a", name: "Ada", status: "Live", score: 98 },
  { id: "g", name: "Grace", status: "Queued", score: 87 },
];

describe("Frick design web data components", () => {
  test("server-renders table columns and rows", () => {
    const html = renderToStaticMarkup(
      <DataTable rows={rows} rowKey="id">
        <Column id="name" header="Name" accessor="name" />
        <Column id="status" header="Status" accessor="status" />
        <Column id="score" header="Score" accessor={(row) => String(row.score)} align="end" />
      </DataTable>,
    );

    expect(html).toContain("<table");
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
    expect(html).toContain('data-align="end"');
  });

  test("server-renders grid, metric, and timeline surfaces", () => {
    const html = renderToStaticMarkup(
      <>
        <DataGrid columns={2}>
          <Metric label="Latency" value="42ms" delta="-8%" />
          <Metric label="Presence" value="12" />
        </DataGrid>
        <Timeline
          items={[
            { id: "1", title: "Opened", time: "09:00" },
            { id: "2", title: "Resolved", time: "09:14", tone: "success" },
          ]}
        />
      </>,
    );

    expect(html).toContain("frick-data-grid");
    expect(html).toContain("--frick-data-grid-columns:2");
    expect(html).toContain("frick-metric");
    expect(html).toContain("Resolved");
  });

  test("server-renders chart primitives with accessible SVG output", () => {
    const data = [2, 6, 4, 8];
    const html = renderToStaticMarkup(
      <ChartSurface title="Activity">
        <LineChart data={data} label="Line activity" />
        <BarChart data={data} label="Bar activity" />
        <AreaChart data={data} label="Area activity" />
        <PieChart data={[3, 2, 5]} label="Pie activity" />
        <Sparkline data={data} label="Spark activity" />
      </ChartSurface>,
    );

    expect(html).toContain("frick-chart-surface");
    expect(html).toContain('role="img"');
    expect(html).toContain("polyline");
    expect(html).toContain("rect");
    expect(html).toContain("path");
  });

  test("exposes canonical Phase-1 aliases for table and metric surfaces", () => {
    expect(Table).toBe(DataTable);
    expect(MetricCard).toBe(Metric);

    const html = renderToStaticMarkup(
      <Table rows={rows} rowKey="id">
        <Column id="name" header="Name" accessor="name" />
      </Table>,
    );
    expect(html).toContain("frick-data-table");
    expect(html).toContain("Ada");

    const metric = renderToStaticMarkup(<MetricCard label="Uptime" value="99.9%" />);
    expect(metric).toContain("frick-metric");
    expect(metric).toContain("Uptime");
  });

  test("server-renders date and time pickers with native input types", () => {
    const html = renderToStaticMarkup(
      <>
        <DatePicker label="Due date" />
        <TimePicker label="Start time" />
        <DateTimePicker label="Reminder" />
      </>,
    );

    expect(html).toContain('type="date"');
    expect(html).toContain('type="time"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("Due date");
    expect(html).toContain("Reminder");
  });

  test("date picker surfaces validation and hint affordances", () => {
    const html = renderToStaticMarkup(
      <DatePicker label="Birthday" hint="MM/DD/YYYY" error="Required" disabled />,
    );

    expect(html).toContain("frick-field__hint");
    expect(html).toContain("frick-field__error");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("Required");
  });

  test("date range picker renders grouped start/end inputs with cross-bounded constraints", () => {
    const html = renderToStaticMarkup(
      <DateRangePicker
        label="Window"
        value={{ start: "2026-05-01", end: "2026-05-09" }}
        hint="Pick a range"
        error="Out of range"
      />,
    );

    expect(html).toContain("frick-date-range");
    expect(html).toContain('role="group"');
    expect(html).toContain("Start");
    expect(html).toContain("End");
    // Two date inputs, one for start and one for end.
    expect(html.match(/type="date"/g)).toHaveLength(2);
    expect(html).toContain('value="2026-05-01"');
    expect(html).toContain('value="2026-05-09"');
    // Start's max is bounded by end; end's min is bounded by start.
    expect(html).toContain('max="2026-05-09"');
    expect(html).toContain('min="2026-05-01"');
    expect(html).toContain("frick-field__error");
    expect(html).toContain('aria-invalid="true"');
  });
});
