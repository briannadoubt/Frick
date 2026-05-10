import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AreaChart,
  BarChart,
  ChartSurface,
  Column,
  DataGrid,
  DataTable,
  LineChart,
  Metric,
  PieChart,
  Sparkline,
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
});
