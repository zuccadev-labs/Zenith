import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { composeZenith } from "../../src/core/compose.ts";
import { backoffMs, createJobQueueTrait, JOB_CLASS } from "../../src/traits/queue/job.queue.trait.ts";
import { fakeDb } from "./_fake_db.ts";

/** One Zenith instance's queue on `db`, with its own clock. */
function instance(db = fakeDb(), clock = { t: Date.parse("2026-11-11T10:00:00Z") }, leaseMs = 60_000) {
  const caps = composeZenith([
    createTraitDescriptor({ name: "Db", provides: ["db"], consumes: [], state: [], runtimes: ["deno"], create: () => ({ db }) }),
    createJobQueueTrait({ now: () => clock.t, leaseMs, random: () => 0.5 }),
  ]).traits as any;
  return { db, clock, q: caps.queue };
}

Deno.test("queue: jobs live in _Job, so a restart loses nothing", async () => {
  const a = instance();
  await a.q.enqueue("email.send", { to: "ana@example.com" });
  assertEquals(a.db.rows[JOB_CLASS].length, 1);
  // "Restart": a new instance on the same database processes what the old one enqueued.
  const b = instance(a.db, a.clock);
  const done: unknown[] = [];
  b.q.registerWorker("email.send", (d: unknown) => { done.push(d); return "sent"; });
  const [job] = await b.q.processDue();
  assertEquals(done, [{ to: "ana@example.com" }]);
  assertEquals([job.status, job.attempts, job.result], ["completed", 1, "sent"]);
});

Deno.test("queue: an instance that dies mid-job does not lose it; another takes it when the lease expires", async () => {
  const a = instance();
  a.q.registerWorker("report", () => new Promise(() => {})); // never finishes: the process "dies"
  await a.q.enqueue("report", {});
  void a.q.processDue();
  await new Promise((r) => setTimeout(r, 10));
  assertEquals((await a.q.list("running")).length, 1);
  const b = instance(a.db, a.clock);
  let ran = 0;
  b.q.registerWorker("report", () => { ran++; });
  assertEquals((await b.q.processDue()).length, 0, "leased: not taken");
  a.clock.t += 61_000; // the lease of the dead instance expires
  assertEquals((await b.q.processDue()).length, 1);
  assertEquals(ran, 1);
});

Deno.test("queue: two instances never run the same job twice", async () => {
  const a = instance();
  const b = instance(a.db, a.clock);
  const seen: number[] = [];
  const slow = async (d: { n: number }) => { await new Promise((r) => setTimeout(r, 5)); seen.push(d.n); };
  a.q.registerWorker("t", slow);
  b.q.registerWorker("t", slow);
  for (let n = 0; n < 12; n++) await a.q.enqueue("t", { n });
  await Promise.all([a.q.processDue(12), b.q.processDue(12)]);
  assertEquals(seen.length, 12);
  assertEquals(new Set(seen).size, 12);
});

Deno.test("queue: retries with exponential backoff, then dead-letter; retry() requeues", async () => {
  const { q, clock } = instance();
  let fail = true;
  q.registerWorker("flaky", () => { if (fail) throw new Error("boom"); return "ok"; });
  const job = await q.enqueue("flaky", {}, { maxAttempts: 3 });
  let j = (await q.processDue())[0];
  assertEquals([j.status, j.attempts, j.lastError], ["pending", 1, "boom"]);
  assertEquals(Date.parse(j.nextAttemptAt) - clock.t, backoffMs(1, () => 0.5));
  assertEquals((await q.processDue()).length, 0, "waiting for the backoff");
  clock.t += 2_000;
  j = (await q.processDue())[0];
  assertEquals(j.attempts, 2);
  clock.t += 4_000;
  j = (await q.processDue())[0];
  assertEquals([j.status, j.attempts], ["failed", 3]);
  assertEquals((await q.list("failed")).length, 1);
  fail = false;
  await q.retry(job.jobId);
  j = (await q.processDue())[0];
  assertEquals([j.status, j.result], ["completed", "ok"]);
  await assertRejects(() => q.retry(job.jobId), Error, "only failed");
});

Deno.test("queue: priority, delay, idempotency key and types without a worker", async () => {
  const { q, clock } = instance();
  const order: string[] = [];
  q.registerWorker("w", (d: { id: string }) => { order.push(d.id); });
  await q.enqueue("w", { id: "low" }, { priority: 0 });
  await q.enqueue("w", { id: "high" }, { priority: 10 });
  await q.enqueue("w", { id: "later" }, { priority: 99, delayMs: 60_000 });
  await q.enqueue("other", { id: "no worker here" });
  const first = await q.enqueue("w", { id: "once" }, { idempotencyKey: "k1" });
  const again = await q.enqueue("w", { id: "twice" }, { idempotencyKey: "k1" });
  assertEquals(again.jobId, first.jobId, "same idempotency key, same job");
  await q.processDue(10);
  assertEquals(order, ["high", "low", "once"]);
  assertEquals((await q.list("pending")).map((j: any) => j.type).sort(), ["other", "w"], "the delayed one and the one without a worker wait");
  clock.t += 60_000;
  await q.processDue(10);
  assertEquals(order.at(-1), "later");
  await assertRejects(() => q.enqueue("", {}), Error, "type");
  await assertRejects(() => q.enqueue("w", {}, { maxAttempts: 0 }), Error, "maxAttempts");
});

Deno.test("queue: backoff doubles up to one hour", () => {
  const mid = () => 0.5;
  assertEquals([1, 2, 3].map((a) => backoffMs(a, mid)), [2_000, 4_000, 8_000]);
  assertEquals(backoffMs(30, mid), 3_600_000);
  assert(backoffMs(1, () => 0) >= 1_800 && backoffMs(1, () => 1) <= 2_200);
});
