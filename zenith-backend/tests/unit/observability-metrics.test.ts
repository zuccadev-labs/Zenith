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
  assertEquals(text.split("\n").filter((l: string) => l === "# TYPE zenith_jobs_total counter").length, 1);
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
    createTraitDescriptor({ name: "Db", provides: ["db"], consumes: [], state: [], runtimes: ["deno"], create: () => ({ db }) }),
    ObservabilityTrait,
    createJobQueueTrait({ random: () => 0.5 }),
  ]).traits as any;
  caps.queue.registerWorker("ok", () => "done");
  caps.queue.registerWorker("bad", () => { throw new Error("no"); });
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
