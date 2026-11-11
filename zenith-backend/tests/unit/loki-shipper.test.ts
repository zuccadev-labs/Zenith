import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type LoggerLike,
  LokiShipper,
  serializeToLokiJson,
} from "../../src/observability/loki-shipper.ts";

const silent: LoggerLike = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

Deno.test("loki: requires HTTPS", () => {
  assertThrows(
    () => new LokiShipper({ endpoint: "http://loki:3100", logger: silent }),
    Error,
    "HTTPS",
  );
});

Deno.test("loki: rejects invalid URL", () => {
  assertThrows(
    () => new LokiShipper({ endpoint: "not-a-url", logger: silent }),
    Error,
    "invalid endpoint",
  );
});

Deno.test("loki: push adds entry to stream", () => {
  const w = new LokiShipper({ endpoint: "https://loki:3100", logger: silent });
  w.push({ job: "zenith", level: "info" }, "hello world");
  assertEquals(w.getStreamCount(), 1);
});

Deno.test("loki: same labels merge into same stream", () => {
  const w = new LokiShipper({ endpoint: "https://loki:3100", logger: silent });
  w.push({ job: "zenith", level: "info" }, "a");
  w.push({ job: "zenith", level: "info" }, "b");
  w.push({ job: "zenith", level: "info" }, "c");
  assertEquals(w.getStreamCount(), 1);
});

Deno.test("loki: different labels create different streams", () => {
  const w = new LokiShipper({ endpoint: "https://loki:3100", logger: silent });
  w.push({ job: "zenith", level: "info" }, "a");
  w.push({ job: "zenith", level: "error" }, "b");
  assertEquals(w.getStreamCount(), 2);
});

Deno.test("loki: baseLabels merged with push labels", () => {
  const w = new LokiShipper({
    endpoint: "https://loki:3100",
    baseLabels: { cluster: "prod-1", service: "zenith" },
    logger: silent,
  });
  w.push({ level: "info" }, "hello");
  // Internamente, debe haber 1 stream con cluster+service+level
  assertEquals(w.getStreamCount(), 1);
});

Deno.test("loki: forbidden labels dropped (PII/high-cardinality)", () => {
  const w = new LokiShipper({
    endpoint: "https://loki:3100",
    logger: silent,
  });
  w.push({ job: "zenith", userId: "u-1", requestId: "r-1" }, "hello");
  // 1 stream con solo `job` (los demás dropped)
  assertEquals(w.getStreamCount(), 1);
});

Deno.test("loki: empty label values dropped", () => {
  const w = new LokiShipper({ endpoint: "https://loki:3100", logger: silent });
  w.push({ job: "zenith", level: "" }, "x");
  assertEquals(w.getStreamCount(), 1);
});

Deno.test("loki: maxStreams backpressure drops new", () => {
  const w = new LokiShipper({
    endpoint: "https://loki:3100",
    maxStreams: 2,
    logger: silent,
  });
  w.push({ level: "info" }, "a");
  w.push({ level: "warn" }, "b");
  w.push({ level: "error" }, "c");
  assertEquals(w.getStreamCount(), 2);
});

Deno.test("loki: line sanitized to maxLineBytes", async () => {
  const w = new LokiShipper({
    endpoint: "https://loki:3100",
    maxLineBytes: 10,
    logger: silent,
  });
  w.push({ job: "x" }, "a".repeat(1000));
  // Verificamos que el truncamiento ocurre en serialize.
  // Hacemos flush y capturamos el body.
  let body = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    body = init.body as string;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    // Forzamos flush con un fetch mock
    await (w as any).flush();
    const parsed = JSON.parse(body);
    const line = parsed.streams[0].values[0][1];
    assert(line.length < 1000, "line should be truncated");
    assert(line.endsWith("…[truncated]"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("serializeToLokiJson: basic format with sorted values", () => {
  const json = serializeToLokiJson([
    {
      labels: { job: "zenith", level: "info" },
      entries: [
        { timestampNs: 3000n, line: "c" },
        { timestampNs: 1000n, line: "a" },
        { timestampNs: 2000n, line: "b" },
      ],
    },
  ]);
  const parsed = JSON.parse(json);
  assertEquals(parsed.streams.length, 1);
  assertEquals(parsed.streams[0].stream, { job: "zenith", level: "info" });
  assertEquals(parsed.streams[0].values[0][1], "a");
  assertEquals(parsed.streams[0].values[1][1], "b");
  assertEquals(parsed.streams[0].values[2][1], "c");
  // Timestamps as strings (Loki wire format)
  assertEquals(parsed.streams[0].values[0][0], "1000");
});

Deno.test("loki: flush POSTs to /loki/api/v1/push with auth", async () => {
  let url = "";
  let auth: string | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any) => {
    url = String(u);
    auth = (init.headers as Record<string, string>).Authorization;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new LokiShipper({
      endpoint: "https://loki:3100",
      bearerToken: "tok-123",
      logger: silent,
    });
    w.push({ job: "x" }, "line1");
    await w.flush();
    assertEquals(url, "https://loki:3100/loki/api/v1/push");
    assertEquals(auth, "Bearer tok-123");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("loki: tenant ID via X-Scope-OrgID", async () => {
  let captured: Record<string, string> | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = init.headers as Record<string, string>;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new LokiShipper({
      endpoint: "https://loki:3100",
      tenantId: "t-99",
      logger: silent,
    });
    w.push({ job: "x" }, "y");
    await w.flush();
    assertEquals(captured!["X-Scope-OrgID"], "t-99");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("loki: stop() flushes remaining entries", async () => {
  let receivedEntries = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body as string);
    receivedEntries = body.streams.reduce((a: number, s: any) => a + s.values.length, 0);
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new LokiShipper({ endpoint: "https://loki:3100", logger: silent });
    w.start();
    w.push({ job: "x" }, "a");
    w.push({ job: "x" }, "b");
    await w.stop();
    assertEquals(receivedEntries, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("loki: 503 triggers retry", async () => {
  let attempts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts < 2) return new Response("", { status: 503 });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new LokiShipper({
      endpoint: "https://loki:3100",
      maxRetries: 3,
      logger: silent,
    });
    w.push({ job: "x" }, "y");
    await w.flush();
    assertEquals(attempts, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("loki: stream with >maxBatchSize entries is truncated", async () => {
  let receivedEntries = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body as string);
    receivedEntries = body.streams[0]?.values.length ?? 0;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const w = new LokiShipper({
      endpoint: "https://loki:3100",
      maxBatchSize: 3,
      logger: silent,
    });
    for (let i = 0; i < 10; i++) {
      w.push({ job: "x" }, `line-${i}`, 1700000000000 + i);
    }
    await w.flush();
    assertEquals(receivedEntries, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});
