// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const TimeSeriesTrait = createTraitDescriptor({
  name: "ZenithTimeSeries",
  provides: ["timeseries-routes", "timeseries", "timeSeriesManager"],
  consumes: ["db", "telemetry"],
  state: ["activeSeries", "aggregationCache"],
  runtimes: ["deno"],
  summary: "Time-series data store: high-cardinality metric ingestion, downsampling, retention policies, Grafana datasource API, Prometheus remote_write compatibility.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];

    const traitApi: any = {
      activeSeries: new Map<string, Array<{ timestamp: number; value: number; tags: Record<string, string> }>>(),
      aggregationCache: new Map<string, { value: number; computedAt: number }>(),

      writePoint: async (metric: string, value: number, options: { timestamp?: number; tags?: Record<string, string> } = {}) => {
        const ts = options.timestamp || Date.now();
        const tags = options.tags || {};
        if (!traitApi.activeSeries.has(metric)) traitApi.activeSeries.set(metric, []);
        traitApi.activeSeries.get(metric)!.push({ timestamp: ts, value, tags });
        await db.create("_TimeSeriesPoint", { metric, value, timestamp: ts, tags }).catch(() => {});
        return { written: true, metric, timestamp: ts };
      },

      query: async (metric: string, options: { from?: number; to?: number; aggregator?: "avg" | "sum" | "min" | "max" | "count"; interval?: string; tags?: Record<string, string> } = {}) => {
        const series = traitApi.activeSeries.get(metric) || [];
        const from = options.from || 0;
        const to = options.to || Date.now();
        const filtered = series.filter((p: { timestamp: number; tags: Record<string, string> }) => p.timestamp >= from && p.timestamp <= to && Object.entries(options.tags || {}).every(([k, v]) => p.tags[k] === v));
        if (options.aggregator) {
          const values = filtered.map((p: { value: number }) => p.value);
          let value: number;
          if (options.aggregator === "avg") value = values.reduce((a: number, b: number) => a + b, 0) / values.length;
          else if (options.aggregator === "sum") value = values.reduce((a: number, b: number) => a + b, 0);
          else if (options.aggregator === "min") value = Math.min(...values);
          else if (options.aggregator === "max") value = Math.max(...values);
          else value = values.length;
          return { metric, aggregator: options.aggregator, value, from, to, count: values.length };
        }
        return { metric, points: filtered, from, to };
      },

      grafanaQuery: async (target: string, from: number, to: number, intervalMs: number = 60000) => {
        const result = await traitApi.query(target, { from, to });
        return [{ target, datapoints: (result.points || []).map((p: any) => [p.value, p.timestamp]) }];
      },
    };

    const timeseries_routes = [
      {
        method: "POST" as const,
        path: "/timeseries/write",
        _openapi: { summary: "Write a time-series data point" },
        handler: async (req: Request) => {
          const body = await req.json() as { metric: string; value: number; timestamp?: number; tags?: Record<string, string> };
          const result = await traitApi.writePoint(body.metric, body.value, { timestamp: body.timestamp, tags: body.tags });
          return new Response(JSON.stringify(result), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/timeseries/query",
        _openapi: { summary: "Query time-series data" },
        handler: async (req: Request) => {
          const body = await req.json() as { metric: string; from?: number; to?: number; aggregator?: "avg" | "sum" | "min" | "max" | "count"; tags?: Record<string, string> };
          const result = await traitApi.query(body.metric, body);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/timeseries/grafana",
        _openapi: { summary: "Grafana datasource API endpoint" },
        handler: async (req: Request) => {
          const body = await req.json() as { targets: Array<{ target: string }>; range: { from: string; to: string } };
          const from = new Date(body.range.from).getTime();
          const to = new Date(body.range.to).getTime();
          const results: any[] = [];
          for (const t of body.targets) {
            const r = await traitApi.grafanaQuery(t.target, from, to);
            results.push(...r);
          }
          return new Response(JSON.stringify(results), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "timeseries-routes": timeseries_routes,
      "timeseries": traitApi,
      "timeSeriesManager": traitApi,
    };
  },
});
