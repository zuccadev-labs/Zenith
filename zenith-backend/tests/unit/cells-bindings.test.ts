/**
 * The `cells` capability: KV namespaces on a cell, Queue bindings over the job queue, Cloud Code's
 * `Zen.Cells` registry and the admin routes.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { composeZenith } from "../../src/core/compose.ts";
import { fakeDb } from "./_fake_db.ts";
import { CellsTrait } from "../../src/traits/cells/cells.trait.ts";
import { JobQueueTrait } from "../../src/traits/queue/job.queue.trait.ts";
import { createZenCells, defineCellClass } from "../../src/traits/cells/registry.ts";
import type { DurableObjectState } from "../../src/traits/cells/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(cells: Record<string, unknown> = {}, appId = "app1") {
  const db = fakeDb();
  const engine = composeZenith([
    createTraitDescriptor({
      name: "Db",
      provides: ["db"],
      consumes: [],
      state: [],
      runtimes: ["deno"],
      create: () => ({ db }),
    }),
    JobQueueTrait,
    CellsTrait,
  ]).traits as Record<string, any>;
  const dir = await Deno.makeTempDir({ prefix: "zenith-cells-b-" });
  engine.cells.configure({ appId, dir, hibernateAfterMs: 0, ...cells });
  return {
    engine,
    db,
    async close() {
      await engine.cells.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("cells KV: values, types, metadata, pages and expiry, in one cell", async () => {
  const z = await boot({ kv: ["CACHE"] });
  try {
    const kv = z.engine.cells.kv("CACHE");
    await kv.put("user:1", JSON.stringify({ a: 1 }), { metadata: { v: 2 } });
    await kv.put("user:2", new Uint8Array([1, 2, 3]));
    await kv.put("other", new Response("streamed").body!);
    assertEquals(await kv.get("user:1", "json"), { a: 1 });
    assertEquals(await kv.get("other"), "streamed");
    const buf = await kv.get("user:2", { type: "arrayBuffer" }) as ArrayBuffer;
    assertEquals([...new Uint8Array(buf)], [1, 2, 3]);
    assertEquals((await kv.getWithMetadata("user:1")).metadata, { v: 2 });
    assertEquals(await kv.get("missing"), null);
    const p1 = await kv.list({ prefix: "user:", limit: 1 });
    assertEquals(p1.keys.map((k: any) => k.name), ["user:1"]);
    assertEquals(p1.list_complete, false);
    const p2 = await kv.list({ prefix: "user:", cursor: p1.cursor });
    assertEquals(p2.keys.map((k: any) => k.name), ["user:2"]);
    assert(p2.list_complete);
    await kv.delete("other");
    assertEquals(await kv.get("other"), null);
    await kv.put("gone", "x", { expiration: Math.floor(Date.now() / 1000) - 1 });
    assertEquals(await kv.get("gone"), null);
    await kv.put("soon", "x", { expirationTtl: 1 });
    assertEquals(await kv.get("soon"), "x");
    // The namespace is a cell; its alarm sweeps the expired entries.
    const local = z.engine.cells.local();
    assertEquals(local.list("ZenithKV").map((c: any) => c.name), ["kv:CACHE"]);
    await sleep(2200);
    assertEquals(await kv.get("soon"), null);
    // Cells see it in env.
    assert(z.engine.cells.env().CACHE);
  } finally {
    await z.close();
  }
});

class Producer {
  #env: Record<string, any>;
  constructor(_ctx: DurableObjectState, env: Record<string, any>) {
    this.#env = env;
  }
  async emit(body: unknown): Promise<void> {
    await this.#env.JOBS.send(body);
  }
}

Deno.test("cells Queue: a cell sends, the consumer acks or retries through the job queue", async () => {
  const z = await boot({ queues: ["JOBS"] });
  try {
    const got: unknown[] = [];
    let failOnce = true;
    z.engine.cells.consume("JOBS", (batch: any, env: any) => {
      assertEquals(batch.queue, "JOBS");
      assert(env.JOBS);
      for (const m of batch.messages) {
        if (m.body.retry && failOnce) {
          failOnce = false;
          m.retry();
          continue;
        }
        got.push(m.body);
        m.ack();
      }
    });
    const ns = z.engine.cells.define("Producer", Producer);
    await ns.getByName("p").emit({ n: 1 });
    await z.engine.cells.queue("JOBS").sendBatch([{ body: { n: 2 } }, { body: { retry: true } }]);
    await z.engine.queue.processDue();
    assertEquals(got, [{ n: 1 }, { n: 2 }]);
    const retried = z.db.rows._Job.find((j: any) => j.data.body.retry)!;
    assertEquals(retried.status, "pending");
    assertEquals(retried.attempts, 1);
    await assertRejects(() => z.engine.cells.queue("JOBS").send({ f: () => 1 }));
  } finally {
    await z.close();
  }
});

class Greeter {
  ctx: DurableObjectState;
  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }
  async greet(who: string): Promise<string> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return `hola ${who} #${n}`;
  }
}

Deno.test("Zen.Cells: classes declared from Cloud Code reach the app's cells", async () => {
  defineCellClass("ZenTestGreeter", Greeter, { binding: "GREETER" });
  const z = await boot({}, "zen-cells-app");
  try {
    const Cells = createZenCells(() => "zen-cells-app");
    assertEquals(await (Cells.get("GREETER", "ana") as any).greet("ana"), "hola ana #1");
    assertEquals(
      await (Cells.namespace("GREETER").getByName("ana") as any).greet("ana"),
      "hola ana #2",
    );
    assert(Cells.env().GREETER);
  } finally {
    await z.close();
  }
});

Deno.test("cells admin routes: stats, listing, RPC and hibernate (master only)", async () => {
  const z = await boot();
  try {
    z.engine.cells.define("Greeter", Greeter, { binding: "G" });
    const routes = z.engine["cells-routes"] as any[];
    assert(routes.every((r) => r.access === undefined), "admin routes stay master-only");
    const route = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p);
    const rpc = await route("POST", "/zen/cells/:binding/:name/rpc/:method").handler(
      new Request("http://z/zen/cells/G/bob/rpc/greet", {
        method: "POST",
        body: JSON.stringify({ args: ["bob"] }),
      }),
    );
    assertEquals(await rpc.json(), { value: "hola bob #1" });
    const list = await route("GET", "/zen/cells/:binding").handler(
      new Request("http://z/zen/cells/G"),
    );
    assertEquals((await list.json()).cells.map((c: any) => c.name), ["bob"]);
    const hib = await route("POST", "/zen/cells/:binding/:name/hibernate").handler(
      new Request("http://z/zen/cells/G/bob/hibernate", { method: "POST" }),
    );
    assertEquals(await hib.json(), { hibernated: true });
    const stats =
      await (await route("GET", "/zen/cells").handler(new Request("http://z/zen/cells")))
        .json();
    assertEquals(stats.provider, "local");
    assertEquals(stats.hibernations, 1);
    const missing = await route("POST", "/zen/cells/:binding/:name/rpc/:method").handler(
      new Request("http://z/zen/cells/NOPE/x/rpc/greet", { method: "POST", body: "{}" }),
    );
    assertEquals(missing.status, 404);
    const bad = await route("POST", "/zen/cells/:binding/:name/rpc/:method").handler(
      new Request("http://z/zen/cells/G/x/rpc/nothing", { method: "POST", body: "{}" }),
    );
    assertEquals(bad.status, 400);
  } finally {
    await z.close();
  }
});
