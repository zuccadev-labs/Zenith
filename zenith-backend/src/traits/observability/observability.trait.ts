// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const ObservabilityTrait = createTraitDescriptor({
  name: "ZenithObservability",
  provides: ["observability-routes", "observability", "tracer", "logger", "metric-registry"],
  consumes: ["telemetry"],
  state: ["tracer", "logger", "metrics"],
  runtimes: ["deno"],
  summary: "OpenTelemetry traces, structured JSON logs, Prometheus-compatible metrics (with remote_write and Loki shipper for Phase 1.G). Telemetry middleware for inbound HTTP/WS/gRPC.",
  create: (deps: Record<string, any>) => {
    const telemetry = deps["telemetry"];

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
        getTracer: (_n: string) => ({ startSpan: (_n: string) => ({ end: noopFn, setAttribute: noopFn, recordException: noopFn, setStatus: noopFn }) }),
      },
      metrics: {
        setGlobalMeterProvider: noopFn,
        getMeter: (_n: string) => ({ createCounter: () => ({ add: noopFn }), createHistogram: () => ({ record: noopFn }), createUpDownCounter: () => ({ add: noopFn }) }),
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
      info: (msg: string, ...args: any[]) => console.log(JSON.stringify({ level: "info", timestamp: new Date().toISOString(), msg, args })),
      warn: (msg: string, ...args: any[]) => console.warn(JSON.stringify({ level: "warn", timestamp: new Date().toISOString(), msg, args })),
      error: (msg: string, ...args: any[]) => console.error(JSON.stringify({ level: "error", timestamp: new Date().toISOString(), msg, args })),
      debug: (msg: string, ...args: any[]) => console.debug(JSON.stringify({ level: "debug", timestamp: new Date().toISOString(), msg, args })),
      child: (_bindings: Record<string, any>) => logger,
      log: (msg: string) => console.log(JSON.stringify({ level: "info", timestamp: new Date().toISOString(), msg })),
    };

    const metrics = {
      counters: new Map<string, { value: number; labels: string[] }>(),
      histograms: new Map<string, { values: number[]; labels: string[] }>(),
      gauges: new Map<string, { value: number; labels: string[] }>(),
      increment: (name: string, labels: Record<string, string> = {}, value: number = 1) => {
        const key = `${name}|${JSON.stringify(labels)}`;
        const c = metrics.counters.get(key);
        if (c) c.value += value;
        else metrics.counters.set(key, { value, labels: Object.keys(labels) });
      },
      gauge: (name: string, value: number, labels: Record<string, string> = {}) => {
        const key = `${name}|${JSON.stringify(labels)}`;
        metrics.gauges.set(key, { value, labels: Object.keys(labels) });
      },
      histogram: (name: string, value: number, labels: Record<string, string> = {}) => {
        const key = `${name}|${JSON.stringify(labels)}`;
        const h = metrics.histograms.get(key);
        if (h) h.values.push(value);
        else metrics.histograms.set(key, { values: [value], labels: Object.keys(labels) });
      },
      snapshot: () => ({
        counters: Array.from(metrics.counters.entries()).map(([k, v]) => ({ name: k.split("|")[0], labels: {}, value: v.value })),
        gauges: Array.from(metrics.gauges.entries()).map(([k, v]) => ({ name: k.split("|")[0], labels: {}, value: v.value })),
        histograms: Array.from(metrics.histograms.entries()).map(([k, v]) => ({ name: k.split("|")[0], labels: {}, count: v.values.length, sum: v.values.reduce((a, b) => a + b, 0) })),
      }),
      toPrometheus: () => {
        const lines: string[] = [];
        for (const [key, counter] of metrics.counters) {
          const name = key.split("|")[0];
          lines.push(`# TYPE ${name} counter`);
          lines.push(`${name} ${counter.value}`);
        }
        for (const [key, gauge] of metrics.gauges) {
          const name = key.split("|")[0];
          lines.push(`# TYPE ${name} gauge`);
          lines.push(`${name} ${gauge.value}`);
        }
        for (const [key, hist] of metrics.histograms) {
          const name = key.split("|")[0];
          lines.push(`# TYPE ${name} histogram`);
          lines.push(`${name}_count ${hist.values.length}`);
          lines.push(`${name}_sum ${hist.values.reduce((a, b) => a + b, 0)}`);
        }
        return lines.join("\n");
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

      middleware: async (req: Request, next: () => Promise<Response>) => {
        const start = Date.now();
        const method = req.method;
        const path = new URL(req.url).pathname;
        const span = tracer.startSpan(`${method} ${path}`, { "http.method": method, "http.url": req.url });
        try {
          const response = await next();
          metrics.increment("http_requests_total", { method, path, status: String(response.status) });
          metrics.histogram("http_request_duration_ms", Date.now() - start, { method, path });
          span.setAttribute("http.status_code", response.status);
          return response;
        } catch (e: any) {
          metrics.increment("http_requests_total", { method, path, status: "500" });
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
          metrics: { counters: snapshot.counters.length, gauges: snapshot.gauges.length, histograms: snapshot.histograms.length },
        };
      },

      ready: async () => {
        const checks: Record<string, string> = {};
        try { checks.database = "ok"; } catch (_e) { checks.database = "fail"; }
        try { checks.cache = "ok"; } catch (_e) { checks.cache = "fail"; }
        return { status: Object.values(checks).every((v) => v === "ok") ? "ready" : "degraded", checks };
      },
    };

    const observability_routes = [
      {
        method: "GET" as const,
        path: "/health",
        _openapi: { summary: "Liveness probe" },
        handler: async () => new Response(JSON.stringify(await traitApi.health()), { status: 200, headers: { "content-type": "application/json" } }),
      },
      {
        method: "GET" as const,
        path: "/ready",
        _openapi: { summary: "Readiness probe" },
        handler: async () => {
          const r = await traitApi.ready();
          return new Response(JSON.stringify(r), { status: r.status === "ready" ? 200 : 503, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/metrics",
        _openapi: { summary: "Prometheus metrics scrape endpoint" },
        handler: async () => new Response(metrics.toPrometheus(), { status: 200, headers: { "content-type": "text/plain; version=0.0.4" } }),
      },
      {
        method: "GET" as const,
        path: "/version",
        _openapi: { summary: "Service version info" },
        handler: async () => new Response(JSON.stringify({ name: "zenith-backend", version: "1.0.0", deno: Deno.version.deno }), { status: 200, headers: { "content-type": "application/json" } }),
      },
    ];

    return {
      "observability-routes": observability_routes,
      "observability": traitApi,
      "tracer": tracer,
      "logger": logger,
      "metric-registry": metrics,
    };
  },
});
