import { assert, assertEquals, assertThrows } from "@std/assert";
import { PrometheusRemoteWriter, serializeToJson, type LoggerLike } from "../../src/observability/prometheus-remote-write.ts";
import type { TimeSeries } from "../../src/observability/metric-registry.ts";

const silent: LoggerLike = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeTs(name: string, value: number, extra: Array<{ name: string; value: string }> = []): TimeSeries {
  return {
    labels: [{ name: "__name__", value: name }, ...extra],
    value,
  };
}

Deno.test("remote_write: requires HTTPS", () => {
  assertThrows(() => new PrometheusRemoteWriter({ endpoint: "http://prom:9090", logger: silent }), Error, "HTTPS");
});

Deno.test("remote_write: rejects invalid URL", () => {
  assertThrows(() => new PrometheusRemoteWriter({ endpoint: "not-a-url", logger: silent }), Error, "invalid endpoint");
});

Deno.test("remote_write: rejects both auth methods", () => {
  assertThrows(
    () => new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      bearerToken: "x",
      basicAuth: { username: "u", password: "p" },
      logger: silent,
    }),
    Error,
    "mutually exclusive",
  );
});

Deno.test("serializeToJson: basic format", () => {
  const json = serializeToJson(
    [makeTs("foo", 1, [{ name: "method", value: "GET" }])],
    [{ name: "cluster", value: "prod" }],
  );
  const parsed = JSON.parse(json);
  assertEquals(parsed.timeseries.length, 1);
  assertEquals(parsed.timeseries[0].labels.find((l: any) => l.name === "__name__").value, "foo");
  assertEquals(parsed.timeseries[0].samples.length, 1);
  assertEquals(parsed.globalLabels[0].value, "prod");
});

Deno.test("serializeToJson: timestamp is unix ms", () => {
  const ts = makeTs("foo", 42);
  ts.timestamp = 1700000000000;
  const json = serializeToJson([ts]);
  const parsed = JSON.parse(json);
  assertEquals(parsed.timeseries[0].samples[0].timestamp, 1700000000000);
});

Deno.test("remote_write: push respects maxBufferSize", () => {
  const w = new PrometheusRemoteWriter({
    endpoint: "https://prom:9090",
    maxBufferSize: 5,
    logger: silent,
  });
  w.start();
  for (let i = 0; i < 10; i++) {
    w.push([makeTs("foo", i)]);
  }
  // Overflow dropped oldest, so debe haber solo 5.
  assertEquals(w.getBufferSize(), 5);
  w.stop();
});

Deno.test("remote_write: push() works without start() (manual flush mode)", () => {
  const w = new PrometheusRemoteWriter({ endpoint: "https://prom:9090", logger: silent });
  // Push funciona sin start(); start() solo activa el timer de auto-flush.
  w.push([makeTs("foo", 1)]);
  assertEquals(w.getBufferSize(), 1);
});

Deno.test("remote_write: send POSTs JSON to /api/v1/push", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), init });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      bearerToken: "test-token",
      flushIntervalMs: 60_000,
      logger: silent,
    });
    w.start();
    w.push([makeTs("requests_total", 5)]);
    await w.flush();

    assertEquals(requests.length, 1);
    assertEquals(requests[0].url, "https://prom:9090/api/v1/push");
    const headers = requests[0].init.headers as Record<string, string>;
    assertEquals(headers["Content-Type"], "application/json");
    assertEquals(headers["Authorization"], "Bearer test-token");
    assertEquals(headers["X-Prometheus-Remote-Write-Version"], "0.1.0");
    const body = JSON.parse(requests[0].init.body as string);
    assertEquals(body.timeseries[0].samples[0].value, 5);
    await w.stop();
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("remote_write: basic auth header", async () => {
  let capturedAuth: string | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedAuth = (init.headers as Record<string, string>).Authorization;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      basicAuth: { username: "user", password: "pass" },
      logger: silent,
    });
    w.push([makeTs("foo", 1)]);
    await w.flush();
    assert(capturedAuth?.startsWith("Basic "));
    const decoded = atob(capturedAuth!.split(" ")[1]);
    assertEquals(decoded, "user:pass");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("remote_write: tenantId sets X-Scope-OrgID", async () => {
  let captured: Record<string, string> | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = init.headers as Record<string, string>;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      tenantId: "tenant-42",
      logger: silent,
    });
    w.push([makeTs("foo", 1)]);
    await w.flush();
    assertEquals(captured!["X-Scope-OrgID"], "tenant-42");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("remote_write: 5xx triggers retry with backoff", async () => {
  let attempts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts < 3) return new Response("server error", { status: 503 });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      maxRetries: 5,
      flushIntervalMs: 60_000,
      logger: silent,
    });
    w.push([makeTs("foo", 1)]);
    await w.flush();
    assertEquals(attempts, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("remote_write: 4xx (non-429) drops batch without retry", async () => {
  let attempts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts++;
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      maxRetries: 5,
      logger: silent,
    });
    w.push([makeTs("foo", 1)]);
    await w.flush();
    assertEquals(attempts, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("remote_write: 429 triggers retry", async () => {
  let attempts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts < 2) return new Response("", { status: 429 });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      maxRetries: 3,
      logger: silent,
    });
    w.push([makeTs("foo", 1)]);
    await w.flush();
    assertEquals(attempts, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("remote_write: max retries exceeded drops and increments failures", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      maxRetries: 2,
      logger: silent,
    });
    w.push([makeTs("foo", 1)]);
    await w.flush();
    assertEquals(w.getConsecutiveFailures(), 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("remote_write: stop() flushes remaining buffer", async () => {
  let received = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body as string);
    received += body.timeseries.length;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({ endpoint: "https://prom:9090", logger: silent });
    w.start();
    w.push([makeTs("foo", 1)]);
    await w.stop();
    assertEquals(received, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("remote_write: custom path is appended", async () => {
  let url = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    url = String(u);
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new PrometheusRemoteWriter({
      endpoint: "https://prom:9090",
      path: "/custom/push",
      logger: silent,
    });
    w.push([makeTs("foo", 1)]);
    await w.flush();
    assertEquals(url, "https://prom:9090/custom/push");
  } finally {
    globalThis.fetch = origFetch;
  }
});
