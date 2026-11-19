/**
 * The `local` cells provider (ADR-019): ids, the input gate, storage (key-value, SQL, transactions),
 * hibernation, alarms and limits, against real SQLite files in a temporary directory.
 */
import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { LocalCellsProvider } from "../../src/traits/cells/local.ts";
import {
  type AlarmInvocationInfo,
  type CellEnv,
  CellError,
  DurableObject,
  type DurableObjectState,
} from "../../src/traits/cells/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withProvider(
  fn: (p: LocalCellsProvider, dir: string) => Promise<void>,
  opts: Partial<ConstructorParameters<typeof LocalCellsProvider>[0]> = {},
) {
  const dir = await Deno.makeTempDir({ prefix: "zenith-cells-" });
  const p = new LocalCellsProvider({ dir, hibernateAfterMs: 0, ...opts });
  try {
    await fn(p, dir);
  } finally {
    await p.close();
    await Deno.remove(dir, { recursive: true });
  }
}

let constructed = 0;

/** A plain class (the portable form): counter by key-value, log by SQL. */
class Counter {
  ctx: DurableObjectState;
  constructor(ctx: DurableObjectState, _env: CellEnv) {
    this.ctx = ctx;
    constructed++;
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (n INTEGER, at INTEGER)");
  }
  async increment(by = 1): Promise<number> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + by;
    await this.ctx.storage.put("n", n);
    this.ctx.storage.sql.exec("INSERT INTO log VALUES (?, ?)", n, Date.now());
    return n;
  }
  async slowIncrement(gated: boolean): Promise<number> {
    const run = async () => {
      const n = (await this.ctx.storage.get<number>("slow")) ?? 0;
      await sleep(5); // not storage: the gate opens here unless blockConcurrencyWhile holds it
      await this.ctx.storage.put("slow", n + 1);
      return n + 1;
    };
    return gated ? await this.ctx.blockConcurrencyWhile(run) : await run();
  }
  value(key = "n"): Promise<unknown> {
    return this.ctx.storage.get(key);
  }
  logCount(): number {
    return Number(this.ctx.storage.sql.exec("SELECT count(*) AS c FROM log").one().c);
  }
  whoami(): { id: string; name?: string } {
    return { id: this.ctx.id.toString(), name: this.ctx.id.name };
  }
  fetch(req: Request): Response {
    return Response.json({ path: new URL(req.url).pathname, id: this.ctx.id.toString() });
  }
  _private(): string {
    return "no";
  }
}

Deno.test("cells ids: names are stable per namespace, strings are checked", async () => {
  await withProvider(async (p) => {
    const a = p.define("Counter", Counter);
    const b = p.define("Other", Counter);
    const x = a.idFromName("room-1");
    assertEquals(x.toString(), a.idFromName("room-1").toString());
    assertEquals(x.toString().length, 64);
    assertEquals(x.name, "room-1");
    assertNotEquals(x.toString(), b.idFromName("room-1").toString());
    assert(a.idFromString(x.toString()).equals(x));
    assertThrows(() => b.idFromString(x.toString()), CellError, "not valid for this namespace");
    assertThrows(() => a.idFromString("zz"), CellError);
    const u = a.newUniqueId();
    assertEquals(a.idFromString(u.toString()).toString(), u.toString());
    assertNotEquals(u.toString(), a.newUniqueId().toString());
    assertThrows(() => a.get(b.idFromName("room-1")), CellError);
  });
});

Deno.test("cells: fetch and RPC reach one instance; private and unknown methods are refused", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Counter", Counter, { binding: "COUNTER" });
    const stub = ns.getByName("a") as any;
    assertEquals(await stub.increment(), 1);
    assertEquals(await stub.increment(2), 3);
    const r = await stub.fetch("http://cell/hello");
    assertEquals((await r.json()).path, "/hello");
    assertEquals((await stub.whoami()).name, "a");
    await assertRejects(() => stub._private(), TypeError);
    await assertRejects(() => stub.nope(), TypeError);
    assertEquals(stub.then, undefined); // a stub is not a promise
    assertEquals(p.namespace("COUNTER"), ns);
    assert(p.env().COUNTER === ns);
  });
});

Deno.test("cells input gate: concurrent read-modify-write events serialize", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Counter", Counter);
    const stub = ns.getByName("hot") as any;
    const results = await Promise.all(Array.from({ length: 200 }, () => stub.increment()));
    assertEquals(new Set(results).size, 200);
    assertEquals(await stub.value(), 200);
    assertEquals(await stub.logCount(), 200);
    // Different cells do not wait for each other.
    const other = ns.getByName("cold") as any;
    assertEquals(await other.increment(), 1);
  });
});

Deno.test("cells input gate: awaiting I/O lets events interleave unless blockConcurrencyWhile holds the gate", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Counter", Counter);
    const open = ns.getByName("open") as any;
    await Promise.all(Array.from({ length: 10 }, () => open.slowIncrement(false)));
    // Cloudflare/celld semantics: the read-modify-write across a timer races (lost updates).
    assert((await open.value("slow")) < 10);
    const gated = ns.getByName("gated") as any;
    await Promise.all(Array.from({ length: 10 }, () => gated.slowIncrement(true)));
    assertEquals(await gated.value("slow"), 10);
  });
});

Deno.test("cells hibernation: an idle cell leaves memory and comes back with its state", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Counter", Counter);
    const id = ns.idFromName("sleepy");
    const stub = ns.get(id) as any;
    const before = constructed;
    await stub.increment(5);
    assert(p.isResident("Counter", id));
    assertEquals(p.hibernateIdle(0), 1);
    assert(!p.isResident("Counter", id));
    // A stub from the bare id string still sees the name the cell was created with.
    const again = ns.get(ns.idFromString(id.toString())) as any;
    assertEquals(await again.value(), 5);
    assertEquals(await again.logCount(), 1);
    assertEquals((await again.whoami()).name, "sleepy");
    assertEquals(constructed - before, 2);
    assertEquals(p.stats().hibernations, 1);
    assertEquals(p.list("Counter").map((c) => c.name), ["sleepy"]);
  });
});

Deno.test("cells hibernation: the idle timer hibernates by itself", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Counter", Counter);
    const id = ns.idFromName("timer");
    await (ns.get(id) as any).increment();
    assert(p.isResident("Counter", id));
    await sleep(400);
    assert(!p.isResident("Counter", id));
    assertEquals(await (ns.get(id) as any).value(), 1);
  }, { hibernateAfterMs: 100 });
});

class Clock {
  ctx: DurableObjectState;
  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }
  async arm(ms: number, failTimes = 0): Promise<number | null> {
    await this.ctx.storage.put("failTimes", failTimes);
    await this.ctx.storage.setAlarm(Date.now() + ms);
    return await this.ctx.storage.getAlarm();
  }
  async alarm(info: AlarmInvocationInfo): Promise<void> {
    const seen = ((await this.ctx.storage.get<unknown[]>("fires")) ?? []).concat([{
      retry: info.retryCount,
      isRetry: info.isRetry,
      during: await this.ctx.storage.getAlarm(),
    }]);
    await this.ctx.storage.put("fires", seen);
    const fail = (await this.ctx.storage.get<number>("failTimes")) ?? 0;
    if (fail > 0) {
      await this.ctx.storage.put("failTimes", fail - 1);
      throw new Error("not yet");
    }
  }
  fires(): Promise<unknown> {
    return this.ctx.storage.get("fires");
  }
  pending(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
  cancel(): Promise<void> {
    return this.ctx.storage.deleteAlarm();
  }
}

async function until(cond: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting");
}

Deno.test("cells alarms: fire once, wake a hibernated cell, can be cancelled", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Clock", Clock);
    const id = ns.idFromName("c1");
    const c = ns.get(id) as any;
    const at = await c.arm(100);
    assert(at > Date.now());
    assertEquals(p.stats().alarms, 1);
    p.hibernateIdle(0);
    assert(!p.isResident("Clock", id));
    await until(async () => p.isResident("Clock", id) && (await c.fires()) !== undefined);
    assertEquals(await c.fires(), [{ retry: 0, isRetry: false, during: null }]);
    assertEquals(await c.pending(), null);
    assertEquals(p.stats().alarms, 0);
    const d = ns.getByName("c2") as any;
    await d.arm(100);
    await d.cancel();
    await sleep(250);
    assertEquals(await d.fires(), undefined);
  });
});

Deno.test("cells alarms: a failing alarm is retried with backoff and retry info", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Clock", Clock);
    const c = ns.getByName("flaky") as any;
    await c.arm(10, 2);
    await until(async () => ((await c.fires()) as unknown[] | undefined)?.length === 3);
    assertEquals(((await c.fires()) as any[]).map((f) => f.retry), [0, 1, 2]);
    assertEquals(await c.pending(), null);
  }, { alarmRetryBaseMs: 20 });
});

Deno.test("cells alarms: survive a restart of the provider", async () => {
  const dir = await Deno.makeTempDir({ prefix: "zenith-cells-" });
  try {
    const p1 = new LocalCellsProvider({ dir, hibernateAfterMs: 0 });
    await (p1.define("Clock", Clock).getByName("persist") as any).arm(150);
    await p1.close();
    const p2 = new LocalCellsProvider({ dir, hibernateAfterMs: 0 });
    try {
      const ns = p2.define("Clock", Clock);
      await until(async () => (await (ns.getByName("persist") as any).fires()) !== undefined);
    } finally {
      await p2.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

class Store extends DurableObject {
  kvAll(): Record<string, unknown> {
    return Object.fromEntries(this.ctx.storage.kv.list());
  }
  async fill(): Promise<void> {
    await this.ctx.storage.put({ "a:1": 1, "a:2": new Map([["x", 2]]), "b:1": new Date(5) });
  }
  async listing(): Promise<unknown> {
    const s = this.ctx.storage;
    return {
      prefix: [...(await s.list({ prefix: "a:" })).keys()],
      reverse: [...(await s.list({ reverse: true, limit: 2 })).keys()],
      range: [...(await s.list({ start: "a:2", end: "b:2" })).keys()],
      after: [...(await s.list({ startAfter: "a:1" })).keys()],
      many: [...(await s.get(["a:1", "zz", "b:1"])).keys()],
      map: (await s.get("a:2")) instanceof Map,
      date: ((await s.get("b:1")) as Date).getTime(),
    };
  }
  async txRollback(): Promise<unknown> {
    await this.ctx.storage.put("t", "before");
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put("t", "inside");
      txn.rollback();
    });
    const a = await this.ctx.storage.get("t");
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put("t", "inside");
      throw new Error("boom");
    }).catch(() => {});
    const b = await this.ctx.storage.get("t");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("t", "outer");
      try {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.kv.put("t", "nested");
          throw new Error("nested fails");
        });
      } catch { /* the outer transaction still commits */ }
    });
    return [a, b, await this.ctx.storage.get("t")];
  }
  sql(): unknown {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER); INSERT INTO t VALUES ('x', 1);");
    const w = sql.exec("INSERT INTO t VALUES (?, ?), (?, ?)", "y", 2, "z", 3);
    const c = sql.exec("SELECT k, v FROM t ORDER BY k");
    return {
      written: w.rowsWritten,
      columns: c.columnNames,
      raw: [...c.raw()],
      size: sql.databaseSize > 0,
    };
  }
  async wipe(): Promise<unknown> {
    await this.ctx.storage.deleteAll();
    return {
      keys: (await this.ctx.storage.list()).size,
      tables: this.ctx.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't'",
      ).toArray().length,
    };
  }
  async big(bytes: number): Promise<void> {
    await this.ctx.storage.put(`big${bytes}`, "x".repeat(bytes));
  }
  async keyCount(): Promise<number> {
    return (await this.ctx.storage.list()).size;
  }
}

Deno.test("cells storage: list options, structured values, transactions and SQL", async () => {
  await withProvider(async (p) => {
    const s = p.define("Store", Store).getByName("s") as any;
    await s.fill();
    assertEquals(await s.listing(), {
      prefix: ["a:1", "a:2"],
      reverse: ["b:1", "a:2"],
      range: ["a:2", "b:1"],
      after: ["a:2", "b:1"],
      many: ["a:1", "b:1"],
      map: true,
      date: 5,
    });
    assertEquals(await s.txRollback(), ["before", "before", "outer"]);
    assertEquals(await s.sql(), {
      written: 2,
      columns: ["k", "v"],
      raw: [["x", 1], ["y", 2], ["z", 3]],
      size: true,
    });
    assertEquals(await s.wipe(), { keys: 0, tables: 0 });
  });
});

Deno.test("cells limits: storage per cell is capped and the failed write rolls back", async () => {
  await withProvider(async (p) => {
    const s = p.define("Store", Store).getByName("full") as any;
    await s.big(1000);
    const e = await assertRejects(() => s.big(300_000), CellError);
    assertEquals(e.code, "storage_limit");
    assertEquals(await s.keyCount(), 1);
    await s.big(2000); // still writable below the cap
    assertEquals(await s.keyCount(), 2);
  }, { maxStorageBytesPerCell: 128 * 1024 });
});

class Holder {
  ctx: DurableObjectState;
  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }
  hold(ms: number): Promise<string> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await sleep(ms);
      return "done";
    });
  }
  ping(): string {
    return "pong";
  }
}

Deno.test("cells limits: max resident cells hibernates the least recently used idle cell", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Holder", Holder);
    await (ns.getByName("a") as any).ping();
    await sleep(5);
    await (ns.getByName("b") as any).ping();
    await (ns.getByName("c") as any).ping();
    assertEquals(p.stats().resident, 2);
    assert(!p.isResident("Holder", ns.idFromName("a")));
    // With every resident cell busy, a new one cannot come in.
    const busy = [(ns.getByName("b") as any).hold(300), (ns.getByName("c") as any).hold(300)];
    await sleep(30);
    const e = await assertRejects(() => (ns.getByName("d") as any).ping(), CellError);
    assertEquals(e.code, "capacity");
    assertEquals(await Promise.all(busy), ["done", "done"]);
    assertEquals(await (ns.getByName("d") as any).ping(), "pong");
  }, { maxResidentCells: 2 });
});

Deno.test("cells blockConcurrencyWhile: a timeout resets the cell and later events still run", async () => {
  await withProvider(async (p) => {
    const ns = p.define("Holder", Holder);
    const h = ns.getByName("stuck") as any;
    const before = p.stats().activations;
    const stuck = h.hold(400);
    const queued = h.ping();
    const e = await assertRejects(() => stuck, CellError);
    assertEquals(e.code, "timeout");
    assertEquals(await queued, "pong");
    assertEquals(p.stats().activations - before, 2);
  }, { blockTimeoutMs: 100 });
});
