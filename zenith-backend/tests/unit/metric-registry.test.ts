import { assert, assertEquals, assertThrows } from "@std/assert";
import { labelKey, MetricRegistry } from "../../src/observability/metric-registry.ts";

Deno.test("MetricRegistry: register + incCounter", () => {
  const r = new MetricRegistry();
  r.register("requests_total", "counter", "Total requests");
  r.incCounter("requests_total");
  r.incCounter("requests_total");
  r.incCounter("requests_total", [], 5);
  const ts = r.toTimeSeries();
  assertEquals(ts.length, 1);
  assertEquals(ts[0].value, 7);
  assertEquals(ts[0].labels.find((l) => l.name === "__name__")?.value, "requests_total");
});

Deno.test("MetricRegistry: counter with labels", () => {
  const r = new MetricRegistry();
  r.register("requests_total", "counter", "Total requests");
  r.incCounter("requests_total", [{ name: "method", value: "GET" }]);
  r.incCounter("requests_total", [{ name: "method", value: "GET" }]);
  r.incCounter("requests_total", [{ name: "method", value: "POST" }]);
  const ts = r.toTimeSeries();
  assertEquals(ts.length, 2);
  const getSeries = ts.find((t) => t.labels.some((l) => l.value === "GET"));
  assertEquals(getSeries?.value, 2);
});

Deno.test("MetricRegistry: setGauge + incGauge", () => {
  const r = new MetricRegistry();
  r.register("active", "gauge", "Active conns");
  r.setGauge("active", 10);
  r.setGauge("active", 5);
  r.incGauge("active", 3);
  const ts = r.toTimeSeries();
  assertEquals(ts[0].value, 8);
});

Deno.test("MetricRegistry: histogram observes into buckets", () => {
  const r = new MetricRegistry({ defaultHistogramBuckets: [10, 100, 1000] });
  r.register("latency", "histogram", "Latency");
  r.observeHistogram("latency", 5);
  r.observeHistogram("latency", 50);
  r.observeHistogram("latency", 500);
  r.observeHistogram("latency", 5000);
  const ts = r.toTimeSeries();
  // 4 buckets per series (3 defined + +Inf) + sum + count = 6 lines
  assertEquals(ts.length, 6);
  // +Inf count = 4
  const inf = ts.find((t) => t.labels.some((l) => l.name === "le" && l.value === "+Inf"));
  assertEquals(inf?.value, 4);
  const sum = ts.find((t) => t.labels[0].value === "latency_sum");
  assertEquals(sum?.value, 5555);
});

Deno.test("MetricRegistry: cardinality limit fail-loud", () => {
  const r = new MetricRegistry({ maxCardinality: 3 });
  r.register("foo", "counter", "x");
  r.incCounter("foo", [{ name: "k", value: "1" }]);
  r.incCounter("foo", [{ name: "k", value: "2" }]);
  r.incCounter("foo", [{ name: "k", value: "3" }]);
  assertThrows(
    () => r.incCounter("foo", [{ name: "k", value: "4" }]),
    Error,
    "exceeded max cardinality",
  );
});

Deno.test("MetricRegistry: register twice throws", () => {
  const r = new MetricRegistry();
  r.register("x", "counter", "");
  assertThrows(() => r.register("x", "counter", ""), Error, "already registered");
});

Deno.test("MetricRegistry: type mismatch throws", () => {
  const r = new MetricRegistry();
  r.register("x", "counter", "");
  assertThrows(() => r.setGauge("x", 1), Error, "expected gauge");
});

Deno.test("MetricRegistry: invalid metric name throws", () => {
  const r = new MetricRegistry();
  assertThrows(() => r.register("invalid name", "counter", ""), Error, "Invalid metric name");
  assertThrows(
    () => r.register("123_starts_with_digit", "counter", ""),
    Error,
    "Invalid metric name",
  );
});

Deno.test("MetricRegistry: prometheus text export", () => {
  const r = new MetricRegistry();
  r.register("requests_total", "counter", "Total requests");
  r.incCounter("requests_total", [{ name: "method", value: "GET" }]);
  const text = r.toPrometheusText();
  assert(text.includes("# HELP requests_total Total requests"));
  assert(text.includes("# TYPE requests_total counter"));
  assert(text.includes('requests_total{method="GET",} 1'));
});

Deno.test("MetricRegistry: global labels applied to remote_write", () => {
  const r = new MetricRegistry();
  r.register("requests_total", "counter", "x");
  r.incCounter("requests_total");
  const ts = r.toTimeSeries([{ name: "cluster", value: "prod-1" }, {
    name: "region",
    value: "us-east-1",
  }]);
  assert(ts[0].labels.some((l) => l.name === "cluster" && l.value === "prod-1"));
  assert(ts[0].labels.some((l) => l.name === "region" && l.value === "us-east-1"));
});

Deno.test("MetricRegistry: label key uniqueness", () => {
  const k1 = labelKey([{ name: "method", value: "GET" }, { name: "path", value: "/x" }]);
  const k2 = labelKey([{ name: "method", value: "GET" }]);
  const k3 = labelKey([{ name: "method", value: "POST" }]);
  assert(k1 !== k2);
  assert(k2 !== k3);
});

Deno.test("MetricRegistry: list() returns metadata", () => {
  const r = new MetricRegistry();
  r.register("a", "counter", "A");
  r.register("b", "gauge", "B");
  const list = r.list();
  assertEquals(list.length, 2);
  assert(list.find((m) => m.name === "a"));
  assert(list.find((m) => m.name === "b"));
});

Deno.test("MetricRegistry: reset() clears all values", () => {
  const r = new MetricRegistry();
  r.register("x", "counter", "");
  r.incCounter("x");
  r.incCounter("x");
  r.reset();
  const ts = r.toTimeSeries();
  assertEquals(ts.length, 0);
});
