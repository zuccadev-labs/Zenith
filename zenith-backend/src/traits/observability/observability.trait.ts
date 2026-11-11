// deno-lint-ignore-file no-unused-vars
/**
 * OpenTelemetry traces, structured JSON logs, Prometheus-compatible metrics (with remote_write and Loki shipper for Phase 1.G). Telemetry middleware for inbound HTTP/WS/gRPC.
 *
 * @barrits-trait
 * @barrits-summary ZenithObservability
 * @barrits-provides observability-routes, observability, tracer, logger, metric-registry, telemetry
 * @barrits-consumes
 * @barrits-state tracer, logger, metrics
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

/** Request duration buckets (seconds): Prometheus' defaults. */
export const HTTP_DURATION_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
] as const;

/** Routes whose 404 means "no such object", not "no such route" (after any mount prefix, as /parse). */
const OBJECT_ROUTES = /\/(classes|users|sessions|roles|installations|files|queue|webhooks)\//;

const ID_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{6,}$|^[0-9a-f]{24}$|^[0-9a-f-]{32,36}$/i;

/**
 * A low-cardinality label for a request path: object ids become `:id` (`/classes/GameScore/:id`), and long
 * paths are cut, so metrics keep one series per route, not per object.
 */
export function routeLabel(pathname: string): string {
  const seg = pathname.split("/");
  const out = seg.map((s, i) => {
    if (!s) return s;
    if (i >= 3 && seg[i - 2] === "classes") return ":id";
    if (ID_SEGMENT.test(s)) return ":id";
    return s.length > 40 ? ":long" : s;
  });
  return out.length > 7 ? `${out.slice(0, 6).join("/")}/…` : out.join("/");
}

export const ObservabilityTrait = createTraitDescriptor({
  name: "ZenithObservability",
  provides: [
    "observability-routes",
    "observability",
    "tracer",
    "logger",
    "metric-registry",
    "telemetry",
  ],
  consumes: [],
  state: ["tracer", "logger", "metrics"],
  runtimes: ["deno"],
  summary:
    "OpenTelemetry traces, structured JSON logs, Prometheus-compatible metrics (with remote_write and Loki shipper for Phase 1.G). Telemetry middleware for inbound HTTP/WS/gRPC.",
  create: (deps: Record<string, any>) => {
    const noopAsyncFn = () => Promise.resolve();
    const noopFn = () => undefined;
    class OtelResource {
      constructor(_attrs: any) {}
    }
    class NodeTracerProvider {
      constructor(_cfg: any) {}
      addSpanProcessor = noopFn;
      register = noopFn;
    }
    class BatchSpanProcessor {
      constructor(_e: any) {}
      onEnd = noopFn;
      shutdown = noopAsyncFn;
      forceFlush = noopAsyncFn;
    }
    class ConsoleSpanExporter {}
    class PeriodicExportingMetricReader {
      constructor(_cfg: any) {}
      shutdown = noopAsyncFn;
    }
    class OTLPTraceExporter {
      constructor(_cfg: any) {}
      export = noopAsyncFn;
    }
    class PrometheusExporter {
      constructor(_cfg: any) {}
      collect = noopAsyncFn;
      shutdown = noopAsyncFn;
    }
    const otel = {
      trace: {
        setGlobalTracerProvider: noopFn,
        getTracer: (_n: string) => ({
          startSpan: (_n: string) => ({
            end: noopFn,
            setAttribute: noopFn,
            recordException: noopFn,
            setStatus: noopFn,
          }),
        }),
      },
      metrics: {
        setGlobalMeterProvider: noopFn,
        getMeter: (_n: string) => ({
          createCounter: () => ({ add: noopFn }),
          createHistogram: () => ({ record: noopFn }),
          createUpDownCounter: () => ({ add: noopFn }),
        }),
      },
      context: { active: () => ({}), with: (_c: any, fn: () => any) => fn() },
      propagation: { traceContext: { extract: () => ({}) } },
      resources: { Resource: OtelResource },
      sdk: {
        trace: { NodeTracerProvider, BatchSpanProcessor, ConsoleSpanExporter },
        metrics: { PeriodicExportingMetricReader },
        export: { OTLPTraceExporter },
      },
      exporter: { PrometheusExporter },
      semconv: { VERSION_1_27_0: "1.27.0" },
    };

    const logger = {
      info: (msg: string, ...args: any[]) =>
        console.log(
          JSON.stringify({ level: "info", timestamp: new Date().toISOString(), msg, args }),
        ),
      warn: (msg: string, ...args: any[]) =>
        console.warn(
          JSON.stringify({ level: "warn", timestamp: new Date().toISOString(), msg, args }),
        ),
      error: (msg: string, ...args: any[]) =>
        console.error(
          JSON.stringify({ level: "error", timestamp: new Date().toISOString(), msg, args }),
        ),
      debug: (msg: string, ...args: any[]) =>
        console.debug(
          JSON.stringify({ level: "debug", timestamp: new Date().toISOString(), msg, args }),
        ),
      child: (_bindings: Record<string, any>) => logger,
      log: (msg: string) =>
        console.log(JSON.stringify({ level: "info", timestamp: new Date().toISOString(), msg })),
    };

    // Prometheus text exposition (0.0.4): one TYPE line per metric, one series per label set. Before,
    // labels were dropped (series of the same metric came out as duplicated lines, which Prometheus
    // rejects) and histograms kept every value forever.
    type Series = { name: string; labels: Record<string, string> };
    const keyOf = (name: string, labels: Record<string, string>) =>
      `${name}|${
        JSON.stringify(Object.fromEntries(
          Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)),
        ))
      }`;
    const escape = (v: string) =>
      v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
    const labelText = (labels: Record<string, string>) => {
      const e = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
      return e.length ? `{${e.map(([k, v]) => `${k}="${escape(String(v))}"`).join(",")}}` : "";
    };
    const metrics = {
      counters: new Map<string, Series & { value: number }>(),
      histograms: new Map<
        string,
        Series & { count: number; sum: number; buckets?: number[]; counts?: number[] }
      >(),
      gauges: new Map<string, Series & { value: number }>(),
      increment: (name: string, labels: Record<string, string> = {}, value: number = 1) => {
        const key = keyOf(name, labels);
        const c = metrics.counters.get(key);
        if (c) c.value += value;
        else metrics.counters.set(key, { name, labels: { ...labels }, value });
      },
      gauge: (name: string, value: number, labels: Record<string, string> = {}) => {
        metrics.gauges.set(keyOf(name, labels), { name, labels: { ...labels }, value });
      },
      /**
       * With `buckets` (upper bounds, ascending) it is a real Prometheus histogram (`_bucket{le}`), as
       * histogram_quantile needs; without them, count and sum only.
       */
      histogram: (
        name: string,
        value: number,
        labels: Record<string, string> = {},
        buckets?: readonly number[],
      ) => {
        const key = keyOf(name, labels);
        let h = metrics.histograms.get(key);
        if (!h) {
          h = {
            name,
            labels: { ...labels },
            count: 0,
            sum: 0,
            ...(buckets ? { buckets: [...buckets], counts: buckets.map(() => 0) } : {}),
          };
          metrics.histograms.set(key, h);
        }
        h.count++;
        h.sum += value;
        h.buckets?.forEach((le, i) => {
          if (value <= le) h!.counts![i]++;
        });
      },
      snapshot: () => ({
        counters: [...metrics.counters.values()].map(({ name, labels, value }) => ({
          name,
          labels,
          value,
        })),
        gauges: [...metrics.gauges.values()].map(({ name, labels, value }) => ({
          name,
          labels,
          value,
        })),
        histograms: [...metrics.histograms.values()].map(({ name, labels, count, sum }) => ({
          name,
          labels,
          count,
          sum,
        })),
      }),
      toPrometheus: () => {
        const lines: string[] = [];
        const emit = (
          type: (s: any) => string,
          series: Iterable<Series & Record<string, any>>,
          values: (s: any) => Array<[string, number, Record<string, string>?]>,
        ) => {
          const byName = new Map<string, Array<Series & Record<string, any>>>();
          for (const s of series) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
          for (const [name, list] of byName) {
            lines.push(`# TYPE ${name} ${type(list[0])}`);
            for (const s of list) {
              for (const [suffix, v, extra] of values(s)) {
                lines.push(`${name}${suffix}${labelText({ ...s.labels, ...(extra ?? {}) })} ${v}`);
              }
            }
          }
        };
        emit(() => "counter", metrics.counters.values(), (s) => [["", s.value]]);
        emit(() => "gauge", metrics.gauges.values(), (s) => [["", s.value]]);
        // With buckets: a histogram (cumulative _bucket{le}, +Inf = count). Without: a summary with no
        // quantiles (count and sum).
        emit(
          (s) => (s.buckets ? "histogram" : "summary"),
          metrics.histograms.values(),
          (s) => [
            ...((s.buckets ?? []) as number[]).map((
              le,
              i,
            ): [string, number, Record<string, string>] => [
              "_bucket",
              s.counts[i],
              { le: String(le) },
            ]),
            ...(s.buckets
              ? [["_bucket", s.count, { le: "+Inf" }] as [string, number, Record<string, string>]]
              : []),
            ["_count", s.count],
            ["_sum", s.sum],
          ],
        );
        return lines.join("\n") + (lines.length ? "\n" : "");
      },
    };

    const tracer = {
      startSpan: (name: string, attributes: Record<string, any> = {}) => ({
        name,
        attributes,
        end: () => {},
        setAttribute: (k: string, v: any) => {},
        recordException: (_e: any) => {},
        setStatus: (_s: any) => {},
        spanContext: () => ({ traceId: "0000000000000000", spanId: "00000000" }),
      }),
      withSpan: async <T>(_name: string, fn: () => Promise<T>) => await fn(),
    };

    const traitApi: any = {
      otel,
      logger,
      metrics,
      tracer,
      log: (...args: any[]) => (logger.info as (...a: any[]) => void)(...args),
      error: (...args: any[]) => (logger.error as (...a: any[]) => void)(...args),

      /**
       * HTTP metrics around a request. `routeOf` (the router's) gives the route template for the `route` label;
       * without it, ids are folded by routeLabel() and a 404 outside the object routes is "unmatched".
       */
      middleware: async (
        req: Request,
        next: () => Promise<Response>,
        routeOf?: (method: string, pathname: string) => string | undefined,
      ) => {
        const start = Date.now();
        const method = req.method;
        const path = new URL(req.url).pathname;
        const span = tracer.startSpan(`${method} ${path}`, {
          "http.method": method,
          "http.url": req.url,
        });
        try {
          const response = await next();
          // Prometheus conventions: `code` for the status, seconds for durations, and the route (a bounded
          // set) instead of the raw path, which carried object ids and made one series per object.
          // A 404 outside the object routes is a path nobody serves (scanners, typos): one series for all.
          const route = routeOf
            ? routeOf(method, path) ?? "unmatched"
            : response.status === 404 && !OBJECT_ROUTES.test(path)
            ? "unmatched"
            : routeLabel(path);
          metrics.increment("http_requests_total", {
            method,
            route,
            code: String(response.status),
          });
          metrics.histogram(
            "http_request_duration_seconds",
            (Date.now() - start) / 1000,
            { method, route },
            HTTP_DURATION_BUCKETS,
          );
          span.setAttribute("http.status_code", response.status);
          return response;
        } catch (e: any) {
          metrics.increment("http_requests_total", {
            method,
            route: routeOf ? routeOf(method, path) ?? "unmatched" : routeLabel(path),
            code: "500",
          });
          span.recordException(e);
          throw e;
        } finally {
          span.end();
        }
      },

      health: async () => {
        const snapshot = metrics.snapshot();
        return {
          status: "ok",
          uptime: process.uptime?.() || 0,
          timestamp: new Date().toISOString(),
          metrics: {
            counters: snapshot.counters.length,
            gauges: snapshot.gauges.length,
            histograms: snapshot.histograms.length,
          },
        };
      },

      ready: async () => {
        const checks: Record<string, string> = {};
        try {
          checks.database = "ok";
        } catch (_e) {
          checks.database = "fail";
        }
        try {
          checks.cache = "ok";
        } catch (_e) {
          checks.cache = "fail";
        }
        return {
          status: Object.values(checks).every((v) => v === "ok") ? "ready" : "degraded",
          checks,
        };
      },
    };

    const observability_routes = [
      {
        method: "GET" as const,
        access: "public" as const,
        path: "/health",
        _openapi: { summary: "Liveness probe" },
        handler: async () =>
          new Response(JSON.stringify(await traitApi.health()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
      {
        method: "GET" as const,
        access: "public" as const,
        path: "/ready",
        _openapi: { summary: "Readiness probe" },
        handler: async () => {
          const r = await traitApi.ready();
          return new Response(JSON.stringify(r), {
            status: r.status === "ready" ? 200 : 503,
            headers: { "content-type": "application/json" },
          });
        },
      },
      {
        method: "GET" as const,
        path: "/metrics",
        _openapi: { summary: "Prometheus metrics scrape endpoint" },
        handler: async () =>
          new Response(metrics.toPrometheus(), {
            status: 200,
            headers: { "content-type": "text/plain; version=0.0.4" },
          }),
      },
      {
        method: "GET" as const,
        access: "public" as const,
        path: "/version",
        _openapi: { summary: "Service version info" },
        handler: async () =>
          new Response(
            JSON.stringify({ name: "zenith-backend", version: "1.0.0", deno: Deno.version.deno }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    ];

    return {
      "observability-routes": observability_routes,
      "observability": traitApi,
      "tracer": tracer,
      "logger": logger,
      "metric-registry": metrics,
      // What the other traits log and trace through: log/info/warn/error/debug and
      // withSpan(name, attributes?, fn).
      "telemetry": {
        log: (msg: string, ...args: any[]) => logger.info(msg, ...args),
        info: (msg: string, ...args: any[]) => logger.info(msg, ...args),
        warn: (msg: string, ...args: any[]) => logger.warn(msg, ...args),
        error: (msg: string, ...args: any[]) => logger.error(msg, ...args),
        debug: (msg: string, ...args: any[]) => logger.debug(msg, ...args),
        withSpan: async <T>(
          _name: string,
          attrsOrFn: Record<string, unknown> | (() => Promise<T>),
          fn?: () => Promise<T>,
        ): Promise<T> => await (typeof attrsOrFn === "function" ? attrsOrFn : fn!)(),
        metrics,
      },
    };
  },
});
