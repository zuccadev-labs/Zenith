import { assert, assertEquals } from "@std/assert";
import { ObservabilityTrait } from "../../src/traits/observability/observability.trait.ts";

const registry = () => (ObservabilityTrait as any).create({ traits: {} })["metric-registry"];

Deno.test("metrics: Prometheus exposition keeps labels, one TYPE line per metric, escaped values", () => {
  const m = registry();
  m.increment("zenith_jobs_total", { type: "email", result: "completed" });
  m.increment("zenith_jobs_total", { result: "completed", type: "email" }, 2); // same series, any label order
  m.increment("zenith_jobs_total", { type: "email", result: "failed" });
  m.gauge("zenith_webhook_messages", 3, { status: "pending" });
  m.histogram("zenith_webhook_delivery_ms", 10, { result: "ok" });
  m.histogram("zenith_webhook_delivery_ms", 30, { result: "ok" });
  m.increment("odd", { path: 'a"b\\c\nd' });
  const text: string = m.toPrometheus();
  assertEquals(
    text.split("\n").filter((l: string) => l === "# TYPE zenith_jobs_total counter").length,
    1,
  );
  assert(text.includes('zenith_jobs_total{result="completed",type="email"} 3'), text);
  assert(text.includes('zenith_jobs_total{result="failed",type="email"} 1'));
  assert(text.includes('zenith_webhook_messages{status="pending"} 3'));
  assert(text.includes('zenith_webhook_delivery_ms_count{result="ok"} 2'));
  assert(text.includes('zenith_webhook_delivery_ms_sum{result="ok"} 40'));
  assert(text.includes('odd{path="a\\"b\\\\c\\nd"} 1'), "quotes, backslashes and newlines escaped");
  assert(text.endsWith("\n"));
});

Deno.test("metrics: histograms keep count and sum, not every value", () => {
  const m = registry();
  for (let i = 0; i < 10_000; i++) m.histogram("h", 1);
  const [h] = m.snapshot().histograms;
  assertEquals([h.count, h.sum], [10_000, 10_000]);
  assertEquals(Object.keys(h).sort(), ["count", "labels", "name", "sum"]);
});

Deno.test("metrics: the durable queue reports jobs by type and result, and its backlog", async () => {
  const { createTraitDescriptor } = await import("@zuccadev-labs/barrits");
  const { composeZenith } = await import("../../src/core/compose.ts");
  const { createJobQueueTrait } = await import("../../src/traits/queue/job.queue.trait.ts");
  const { fakeDb } = await import("./_fake_db.ts");
  const db = fakeDb();
  const caps = composeZenith([
    createTraitDescriptor({
      name: "Db",
      provides: ["db"],
      consumes: [],
      state: [],
      runtimes: ["deno"],
      create: () => ({ db }),
    }),
    ObservabilityTrait,
    createJobQueueTrait({ random: () => 0.5 }),
  ]).traits as any;
  caps.queue.registerWorker("ok", () => "done");
  caps.queue.registerWorker("bad", () => {
    throw new Error("no");
  });
  await caps.queue.enqueue("ok", {});
  await caps.queue.enqueue("bad", {}, { maxAttempts: 1 });
  await caps.queue.enqueue("later", {}, { delayMs: 60_000 });
  await caps.queue.processDue(10);
  await caps.queue.reportBacklog();
  const text: string = caps["metric-registry"].toPrometheus();
  assert(text.includes('zenith_jobs_total{result="completed",type="ok"} 1'), text);
  assert(text.includes('zenith_jobs_total{result="failed",type="bad"} 1'));
  assert(text.includes('zenith_jobs{status="pending"} 1'));
  assert(text.includes('zenith_jobs{status="failed"} 1'));
  assert(text.includes('zenith_job_duration_ms_count{result="completed",type="ok"} 1'));
});

Deno.test("metrics: a histogram with buckets is exposed as a Prometheus histogram (cumulative, +Inf)", () => {
  const m = registry();
  for (const v of [0.003, 0.02, 0.02, 0.3, 12]) {
    m.histogram("lat_seconds", v, { route: "/x" }, [0.01, 0.1, 1]);
  }
  const text: string = m.toPrometheus();
  assert(text.includes("# TYPE lat_seconds histogram"), text);
  assert(text.includes('lat_seconds_bucket{le="0.01",route="/x"} 1'), text);
  assert(text.includes('lat_seconds_bucket{le="0.1",route="/x"} 3'));
  assert(text.includes('lat_seconds_bucket{le="1",route="/x"} 4'));
  assert(text.includes('lat_seconds_bucket{le="+Inf",route="/x"} 5'));
  assert(text.includes('lat_seconds_count{route="/x"} 5'));
  assert(text.includes('lat_seconds_sum{route="/x"} 12.343'));
  // Without buckets it is still a summary without quantiles.
  m.histogram("plain_ms", 4);
  assert(m.toPrometheus().includes("# TYPE plain_ms summary"));
});

Deno.test("metrics: route labels have no object ids (bounded cardinality)", async () => {
  const { routeLabel } = await import("../../src/traits/observability/observability.trait.ts");
  assertEquals(routeLabel("/classes/GameScore"), "/classes/GameScore");
  assertEquals(routeLabel("/classes/GameScore/xWMyZ4YEGZ"), "/classes/GameScore/:id");
  assertEquals(routeLabel("/users/65a1f0c2e4b0a1b2c3d4e5f6"), "/users/:id");
  assertEquals(routeLabel("/files/3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "/files/:id");
  assertEquals(routeLabel("/login"), "/login");
  assertEquals(routeLabel("/health"), "/health");
  assertEquals(routeLabel("/a/b/c/d/e/f/g/h"), "/a/b/c/d/e/…");
});

Deno.test("metrics: the HTTP middleware counts by method, route and code, and times in seconds", async () => {
  const obs = (ObservabilityTrait as any).create({ traits: {} });
  const mw = obs.observability.middleware;
  await mw(
    new Request("http://h/classes/Post/abc123XYZ"),
    () => Promise.resolve(new Response("ok")),
  );
  await mw(
    new Request("http://h/nope/zzz", { method: "POST" }),
    () => Promise.resolve(new Response("", { status: 404 })),
  );
  const text: string = obs["metric-registry"].toPrometheus();
  assert(
    text.includes('http_requests_total{code="200",method="GET",route="/classes/Post/:id"} 1'),
    text,
  );
  assert(text.includes('http_requests_total{code="404",method="POST",route="unmatched"} 1'));
  assert(text.includes("# TYPE http_request_duration_seconds histogram"));
  assert(
    text.includes(
      'http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/classes/Post/:id"} 1',
    ),
  );
  assert(!text.includes("http_request_duration_ms"));
});

Deno.test("metrics: the circuit breaker exposes its state; failures must be consecutive to open it", async () => {
  const { CircuitBreakerTrait } = await import(
    "../../src/traits/resilience/circuit.breaker.trait.ts"
  );
  const m = registry();
  const cb =
    (CircuitBreakerTrait as any).create({ traits: { "metric-registry": m } })["circuit-breaker"];
  const fail = () => Promise.reject(new Error("down"));
  const ok = () => Promise.resolve(1);
  // 2 failures, a success, 2 failures: not 3 in a row, so it stays closed.
  for (const f of [fail, fail, ok, fail, fail]) {
    await cb.execute("db", f, { threshold: 3 }).catch(() => {});
  }
  assertEquals(cb.getState("db").state, "closed");
  assert(m.toPrometheus().includes('zenith_circuit_breaker_state{circuit="db",state="CLOSED"} 1'));
  await cb.execute("db", fail, { threshold: 3 }).catch(() => {});
  assertEquals(cb.getState("db").state, "open");
  const text: string = m.toPrometheus();
  assert(text.includes('zenith_circuit_breaker_state{circuit="db",state="OPEN"} 1'), text);
  assert(text.includes('zenith_circuit_breaker_state{circuit="db",state="CLOSED"} 0'));
});

Deno.test("metrics: each accepted static master key is counted", async () => {
  const { extractContext } = await import("../../src/core/pipeline.ts");
  let used = 0;
  const step = extractContext({
    configMasterKey: "mk-secret",
    audit: false,
    onMasterKey: () => used++,
  });
  const req = (key: string, ip: string) => {
    const r = new Request("http://h/classes/X", { headers: { "Zen-Master-Key": key } });
    (r as any).__socketAddr = { hostname: ip };
    return r;
  };
  assert((await step(req("mk-secret", "127.0.0.1"), {} as any)).masterKey);
  assert(!(await step(req("wrong", "127.0.0.1"), {} as any)).masterKey);
  assert(!(await step(req("mk-secret", "203.0.113.9"), {} as any)).masterKey);
  assertEquals(used, 1);
});

Deno.test("metrics: route labels and 404s work under a mount prefix (/parse)", async () => {
  const { routeLabel } = await import("../../src/traits/observability/observability.trait.ts");
  assertEquals(routeLabel("/parse/classes/Post/abc123XYZ"), "/parse/classes/Post/:id");
  const obs = (ObservabilityTrait as any).create({ traits: {} });
  const notFound = () => Promise.resolve(new Response("", { status: 404 }));
  await obs.observability.middleware(
    new Request("http://h/parse/classes/Post/abc123XYZ"),
    notFound,
  );
  await obs.observability.middleware(new Request("http://h/wp-admin/setup.php"), notFound);
  const text: string = obs["metric-registry"].toPrometheus();
  assert(
    text.includes('http_requests_total{code="404",method="GET",route="/parse/classes/Post/:id"} 1'),
    text,
  );
  assert(text.includes('http_requests_total{code="404",method="GET",route="unmatched"} 1'));
});

Deno.test("metrics: with the router, the route label is the route template; unknown paths are unmatched", async () => {
  const { ZenithRouter } = await import("../../src/core/router.ts");
  const router = new ZenithRouter();
  const ok = () => Promise.resolve(new Response("{}"));
  router.on("GET", "/classes/:className/:objectId", ok, "public");
  router.on("POST", "/login", ok, "public");
  const routeOf = (m: string, p: string) => router.routeOf(m, p);
  assertEquals(routeOf("GET", "/classes/Post/abc"), "/classes/:className/:objectId");
  assertEquals(
    routeOf("GET", "/users/abc"),
    "/classes/:className/:objectId",
    "Parse aliases resolve too",
  );
  assertEquals(routeOf("GET", "/wp-admin/x.php"), undefined);
  const obs = (ObservabilityTrait as any).create({ traits: {} });
  const denied = () => Promise.resolve(new Response("", { status: 401 }));
  await obs.observability.middleware(new Request("http://h/wp-admin/x.php"), denied, routeOf);
  await obs.observability.middleware(new Request("http://h/classes/Post/abc"), denied, routeOf);
  const text: string = obs["metric-registry"].toPrometheus();
  assert(text.includes('http_requests_total{code="401",method="GET",route="unmatched"} 1'), text);
  assert(
    text.includes(
      'http_requests_total{code="401",method="GET",route="/classes/:className/:objectId"} 1',
    ),
  );
  assert(!text.includes("wp-admin"));
});
