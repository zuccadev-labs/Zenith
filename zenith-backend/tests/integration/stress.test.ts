/**
 * Load and fault test of the shared outbox (core/outbox.ts) on real MongoDB: several Zenith instances work the
 * same database at once while MongoDB is paused mid-run (a network partition, as the workers see it).
 *
 *   ZENITH_STRESS=1 MONGO_TEST_URI="mongodb://127.0.0.1:28000/?replicaSet=rs0&directConnection=true" \
 *   ZENITH_STRESS_MONGO_CONTAINER=zenith-it-mongors deno test -A --unstable-kv tests/integration/stress.test.ts
 *
 * Off by default (it takes about a minute and pauses a container).
 */
import { assert, assertEquals } from "@std/assert";
import { MongoClient } from "mongodb";
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { createMongoAdapter } from "../../src/adapters/database/mongo.adapter.ts";
import { createDb } from "../../src/traits/db/db.trait.ts";
import { composeZenith } from "../../src/core/compose.ts";
import { createJobQueueTrait } from "../../src/traits/queue/job.queue.trait.ts";
import { createWebhookManagerTrait } from "../../src/traits/webhooks/webhook.manager.trait.ts";
import { MESSAGE_CLASS } from "../../src/traits/webhooks/webhook.delivery.ts";

const URI = Deno.env.get("MONGO_TEST_URI");
const CONTAINER = Deno.env.get("ZENITH_STRESS_MONGO_CONTAINER");
const ignore = Deno.env.get("ZENITH_STRESS") !== "1" || !URI;
const INSTANCES = 3;

const dbTrait = (db: unknown) =>
  createTraitDescriptor({
    name: "Db",
    provides: ["db"],
    consumes: [],
    state: [],
    runtimes: ["deno"],
    create: () => ({ db }),
  });

const docker = async (...args: string[]) => {
  const out = await new Deno.Command("docker", { args, stdout: "null", stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`docker ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
};

/** Keeps calling `step` on every instance until `done()`, surviving errors (MongoDB paused). */
async function drive(
  steps: Array<() => Promise<unknown>>,
  done: () => Promise<boolean>,
  timeoutMs: number,
) {
  const until = Date.now() + timeoutMs;
  let errors = 0;
  while (Date.now() < until) {
    await Promise.all(steps.map((s) => s().catch(() => errors++)));
    if (await done().catch(() => false)) return errors;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

Deno.test({
  name:
    "stress: 3 instances, 600 jobs, 10% failing once, MongoDB paused mid-run — every job runs exactly once",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const client = new MongoClient(URI!);
    await client.connect();
    const name = `stress_q_${Date.now()}`;
    const db = createDb(() => createMongoAdapter(client.db(name)) as never);
    try {
      const executions = new Map<number, number>();
      const failedOnce = new Set<number>();
      const queues = Array.from({ length: INSTANCES }, () => {
        const q = (composeZenith([
          dbTrait(db),
          createJobQueueTrait({ leaseMs: 60_000, random: () => 0 }),
        ]).traits as any).queue;
        q.registerWorker("work", async ({ n }: { n: number }) => {
          if (n % 10 === 0 && !failedOnce.has(n)) {
            failedOnce.add(n);
            throw new Error("transient");
          }
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          executions.set(n, (executions.get(n) ?? 0) + 1);
        });
        return q;
      });
      for (let n = 0; n < 600; n++) {
        await queues[n % INSTANCES].enqueue("work", { n }, { maxAttempts: 5 });
      }

      let pausedWith = -1; // jobs done when MongoDB was paused
      const partition = (async () => {
        if (!CONTAINER) return;
        await new Promise((r) => setTimeout(r, 300));
        await docker("pause", CONTAINER);
        pausedWith = executions.size;
        await new Promise((r) => setTimeout(r, 3_000));
        await docker("unpause", CONTAINER);
      })();
      // Retries wait 2 s (backoff): give them time, then keep driving.
      const errors = await drive(
        queues.map((q) => () => q.processDue(20)),
        async () =>
          executions.size === 600 && (await db.find("_Job", { status: "pending" })).length === 0,
        120_000,
      );
      await partition;
      assertEquals(executions.size, 600, "every job completed");
      assertEquals([...executions.values()].filter((c) => c !== 1).length, 0, "and none ran twice");
      assertEquals(failedOnce.size, 60, "the transient failures were retried");
      assertEquals((await db.find("_Job", { status: "completed" })).length, 600);
      // The driver waits out the pause instead of failing: the pause must have hit work in flight.
      if (CONTAINER) {
        assert(pausedWith > 0 && pausedWith < 600, `paused with ${pausedWith} of 600 jobs done`);
      }
      console.log(
        `queue: 600 jobs on ${INSTANCES} instances; MongoDB paused 3 s with ${pausedWith} done; ${errors} failed rounds`,
      );
    } finally {
      await docker("unpause", CONTAINER!).catch(() => {});
      await client.db(name).dropDatabase();
      await client.close();
    }
  },
});

Deno.test({
  name:
    "stress: 3 instances, 300 webhooks, receiver failing 20% — each message accepted exactly once",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const client = new MongoClient(URI!);
    await client.connect();
    const name = `stress_wh_${Date.now()}`;
    const db = createDb(() => createMongoAdapter(client.db(name)) as never);
    const accepted = new Map<string, number>();
    let refused = 0;
    const ac = new AbortController();
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      signal: ac.signal,
      onListen: () => {},
    }, async (req) => {
      const id = req.headers.get("webhook-id")!;
      await req.text();
      if (Math.random() < 0.2) {
        refused++;
        return new Response("busy", { status: 503 });
      }
      accepted.set(id, (accepted.get(id) ?? 0) + 1);
      return new Response(null, { status: 204 });
    });
    // A shared clock that the test moves forward, so retries (5 s, 5 min…) come due without waiting.
    const clock = { t: Date.now() };
    try {
      const managers = Array.from({ length: INSTANCES }, () =>
        (composeZenith([
          dbTrait(db),
          createWebhookManagerTrait({
            policy: { allowHttp: true, allowPrivate: true },
            requireVerification: false,
            now: () => clock.t,
          }),
        ]).traits as any).webhookManager);
      await managers[0].create({
        name: "s",
        url: `http://127.0.0.1:${server.addr.port}/h`,
        events: ["*"],
      });
      for (let i = 0; i < 300; i++) await managers[i % INSTANCES].publish("Order.paid", { i });
      await drive(
        managers.map((m) => async () => {
          await m.deliverDue();
          clock.t += 400_000; // past the next retry and any lease
        }),
        async () => accepted.size === 300,
        120_000,
      );
      assertEquals(accepted.size, 300, "every message accepted");
      assertEquals(
        [...accepted.values()].filter((c) => c !== 1).length,
        0,
        "and accepted only once",
      );
      assert(refused > 0, "the receiver did refuse some deliveries");
      assertEquals((await db.find(MESSAGE_CLASS, { status: "succeeded" })).length, 300);
      console.log(
        `webhooks: 300 messages on ${INSTANCES} instances, ${refused} refused attempts retried`,
      );
    } finally {
      ac.abort();
      await server.finished;
      await client.db(name).dropDatabase();
      await client.close();
    }
  },
});
