/**
 * The scrape listener: `GET /metrics` on its own port (ZENITH_METRICS_PORT), without credentials.
 *
 * The `/metrics` route of each app lives under its mount (`/parse/metrics`) and behind the app pipeline (Application
 * ID and a key), so Prometheus could not read it: the Helm chart's ServiceMonitor pointed at a port 9090 that
 * nothing served. This listener is the standard answer: a separate port, not exposed by the Service's public port nor
 * the Ingress, reachable only from the monitoring namespace (NetworkPolicy), that serves nothing but metrics.
 *
 * Several apps share the process: their series are merged into one exposition, each with an `app` label, and one
 * `# TYPE` line per metric family (Prometheus rejects a family declared twice).
 */

/** One app's metrics: its exposition text and the labels that identify it (`{ app: "myAppId" }`). */
export interface MetricsSource {
  labels: Record<string, string>;
  text: () => string;
}

const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

/** Adds `labels` to a sample line (`name{a="b"} 1` or `name 1`). */
function withLabels(line: string, labels: Record<string, string>): string {
  const extra = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`).join(",");
  if (!extra) return line;
  const brace = line.indexOf("{");
  const space = line.indexOf(" ");
  if (brace !== -1 && brace < space) {
    const rest = line.slice(brace + 1);
    return `${line.slice(0, brace)}{${extra}${rest.startsWith("}") ? "" : ","}${rest}`;
  }
  return `${line.slice(0, space)}{${extra}}${line.slice(space)}`;
}

/** Merges several expositions into one: one `# TYPE` per family, every sample with its source's labels. */
export function mergeExpositions(
  parts: Array<{ labels: Record<string, string>; text: string }>,
): string {
  const families = new Map<string, { type: string; samples: string[] }>();
  const untyped: string[] = [];
  for (const { labels, text } of parts) {
    let current: { type: string; samples: string[] } | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const type = /^# TYPE (\S+) (\S+)$/.exec(line);
      if (type) {
        const [, name, kind] = type;
        current = families.get(name);
        if (!current) families.set(name, current = { type: kind, samples: [] });
        continue;
      }
      if (line.startsWith("#")) continue; // HELP and comments: the merged output carries TYPE only
      (current?.samples ?? untyped).push(withLabels(line, labels));
    }
  }
  const out: string[] = [];
  for (const [name, f] of families) out.push(`# TYPE ${name} ${f.type}`, ...f.samples);
  out.push(...untyped);
  return out.length ? out.join("\n") + "\n" : "";
}

/** Starts the listener. `hostname` defaults to every interface: inside a pod, the pod network. */
export function serveMetrics(opts: {
  port: number;
  hostname?: string;
  sources: () => MetricsSource[];
  signal?: AbortSignal;
}): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve(
    {
      port: opts.port,
      hostname: opts.hostname ?? "0.0.0.0",
      signal: opts.signal,
      onListen: ({ port }) => console.log(`📈 Metrics listening on :${port}/metrics`),
    },
    (req) => {
      const { pathname } = new URL(req.url);
      if (pathname !== "/metrics") return new Response("not found\n", { status: 404 });
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const body = mergeExpositions(
        opts.sources().map((s) => ({ labels: s.labels, text: s.text() })),
      );
      return new Response(req.method === "HEAD" ? null : body, {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    },
  );
}
