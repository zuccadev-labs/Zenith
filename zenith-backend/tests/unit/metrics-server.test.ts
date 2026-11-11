import { assert, assertEquals } from "@std/assert";
import { mergeExpositions, serveMetrics } from "../../src/observability/metrics-server.ts";

Deno.test("metrics server: merges apps with an app label and one TYPE per family", () => {
  const a = '# TYPE http_requests_total counter\nhttp_requests_total{code="200"} 3\n' +
    "# TYPE up_seconds gauge\nup_seconds 5\n";
  const b = '# TYPE http_requests_total counter\nhttp_requests_total{code="500"} 1\n' +
    '# TYPE lat histogram\nlat_bucket{le="+Inf"} 2\nlat_count 2\nlat_sum 0.5\n';
  const text = mergeExpositions([{ labels: { app: "one" }, text: a }, {
    labels: { app: 't"wo' },
    text: b,
  }]);
  assertEquals(
    text.split("\n").filter((l) => l === "# TYPE http_requests_total counter").length,
    1,
  );
  assert(text.includes('http_requests_total{app="one",code="200"} 3'), text);
  assert(text.includes('http_requests_total{app="t\\"wo",code="500"} 1'));
  assert(text.includes('up_seconds{app="one"} 5'));
  assert(text.includes('lat_bucket{app="t\\"wo",le="+Inf"} 2'));
  assert(text.includes('lat_sum{app="t\\"wo"} 0.5'));
  // Samples stay under their family's TYPE line.
  const lines = text.trim().split("\n");
  assertEquals(
    lines.indexOf("# TYPE lat histogram") + 1,
    lines.indexOf('lat_bucket{app="t\\"wo",le="+Inf"} 2'),
  );
});

Deno.test("metrics server: GET /metrics only, without credentials", async () => {
  const ac = new AbortController();
  const server = serveMetrics({
    port: 0,
    hostname: "127.0.0.1",
    signal: ac.signal,
    sources: () => [{ labels: { app: "x" }, text: () => "# TYPE c counter\nc 1\n" }],
  });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const ok = await fetch(`${base}/metrics`);
    assertEquals(ok.status, 200);
    assert(ok.headers.get("content-type")!.startsWith("text/plain; version=0.0.4"));
    assertEquals(await ok.text(), '# TYPE c counter\nc{app="x"} 1\n');
    const other = await fetch(`${base}/classes/Foo`);
    assertEquals(other.status, 404);
    await other.body?.cancel();
    const post = await fetch(`${base}/metrics`, { method: "POST" });
    assertEquals(post.status, 405);
    await post.body?.cancel();
  } finally {
    ac.abort();
    await server.finished;
  }
});
