import { assert, assertEquals, assertRejects } from "@std/assert";
import { Webhook } from "standardwebhooks";
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { composeZenith } from "../../src/core/compose.ts";
import { CloudCodeTrait } from "../../src/traits/cloud/cloudcode.trait.ts";
import { createCloudHooksTrait, HOOKS_CLASS } from "../../src/traits/cloud/hooks.trait.ts";
import { generateWebhookSecret } from "../../src/security/webhook-signature.ts";

function fakeDb() {
  const rows: Record<string, Record<string, any>[]> = {};
  let seq = 0;
  const match = (r: Record<string, any>, w: Record<string, unknown>) => Object.entries(w).every(([k, v]) => r[k] === v);
  const t = (c: string) => (rows[c] ??= []);
  return {
    rows,
    find: async (c: string, w: Record<string, unknown> = {}) => t(c).filter((r) => match(r, w)).map((r) => ({ ...r })),
    read: async (c: string, id: string) => t(c).find((r) => r.objectId === id) ?? null,
    create: async (c: string, d: Record<string, any>) => { const r = { ...d, objectId: `h${++seq}` }; t(c).push(r); return { ...r }; },
    update: async (c: string, w: { objectId: string }, d: Record<string, any>) => Object.assign(t(c).find((r) => r.objectId === w.objectId)!, d),
    delete: async (c: string, w: { objectId: string }) => { rows[c] = t(c).filter((r) => r.objectId !== w.objectId); },
  };
}

type Call = { headers: Record<string, string>; body: any; raw: string };

function receiver(reply: (path: string, body: any) => Response) {
  const calls: Call[] = [];
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, async (req) => {
    const raw = await req.text();
    const body = JSON.parse(raw);
    calls.push({ headers: Object.fromEntries(req.headers), body, raw });
    return reply(new URL(req.url).pathname, body);
  });
  const base = `http://127.0.0.1:${server.addr.port}`;
  return { base, calls, stop: async () => { ac.abort(); await server.finished; } };
}

const stub = (name: string, cap: string) => createTraitDescriptor({ name, provides: [cap], consumes: [], state: [], runtimes: ["deno"], create: () => ({ [cap]: {} }) });

function boot(db = fakeDb(), secret = generateWebhookSecret()) {
  const caps = composeZenith([
    createTraitDescriptor({ name: "Db", provides: ["db"], consumes: [], state: [], runtimes: ["deno"], create: () => ({ db }) }),
    stub("Acl", "acl"),
    stub("Schema", "schema"),
    CloudCodeTrait,
    createCloudHooksTrait({ policy: { allowHttp: true, allowPrivate: true }, webhookKey: "hook-key", signingSecret: secret }),
  ]).traits as any;
  return { db, secret, cloud: caps.cloud, hooks: caps.cloudHooks };
}

const sanitize = { sanitizeResources: false, sanitizeOps: false };
const ok = (success: unknown) => Response.json({ success });

Deno.test({ name: "hooks: a function hook answers cloud.run like Parse Server, signed and without credentials", ...sanitize, fn: async () => {
  const rx = receiver((_p, b) => ok(b.params.a + 1));
  const { cloud, hooks, secret } = boot();
  try {
    await hooks.createFunction({ functionName: "addOne", url: `${rx.base}/fn` });
    assertEquals(await cloud.run("addOne", { a: 41 }, { user: { objectId: "u1", sessionToken: "r:x" } }), 42);
    const [c] = rx.calls;
    assertEquals(c.headers["x-parse-webhook-key"], "hook-key");
    new Webhook(secret).verify(c.raw, c.headers); // the Standard Webhooks signature checks out
    assertEquals(c.body.functionName, "addOne");
    assertEquals(c.body.user, { objectId: "u1" }, "the session token is not forwarded");
    assertEquals(c.body.master, false);
  } finally {
    await rx.stop();
  }
} });

Deno.test({ name: "hooks: { error } and non-2xx answers fail the call with their code", ...sanitize, fn: async () => {
  const rx = receiver((p) => p === "/err" ? Response.json({ error: { code: 1337, error: "nope" } }) : p === "/500" ? new Response("x", { status: 500 }) : new Response("not json"));
  const { cloud, hooks } = boot();
  try {
    await hooks.createFunction({ functionName: "e", url: `${rx.base}/err` });
    await hooks.createFunction({ functionName: "f", url: `${rx.base}/500` });
    await hooks.createFunction({ functionName: "g", url: `${rx.base}/bad` });
    const e = await assertRejects(() => cloud.run("e", {}), Error, "nope") as any;
    assertEquals(e.code, 1337);
    await assertRejects(() => cloud.run("f", {}), Error, "HTTP 500");
    await assertRejects(() => cloud.run("g", {}), Error, "Malformed");
  } finally {
    await rx.stop();
  }
} });

Deno.test({ name: "hooks: beforeSave can change the object (not createdAt/className); afterSave failures do not undo the save", ...sanitize, fn: async () => {
  const rx = receiver((p, b) => p === "/before" ? ok({ ...b.object, score: b.object.score * 10, createdAt: "1999", className: "X" }) : new Response("down", { status: 503 }));
  const { cloud, hooks } = boot();
  try {
    await hooks.createTrigger({ className: "GameScore", triggerName: "beforeSave", url: `${rx.base}/before` });
    await hooks.createTrigger({ className: "GameScore", triggerName: "afterSave", url: `${rx.base}/after` });
    const object: Record<string, unknown> = { score: 3 };
    await cloud.runBeforeSave("GameScore", { object, master: true });
    assertEquals(object, { score: 30 });
    assertEquals(rx.calls[0].body.triggerName, "beforeSave");
    assertEquals(rx.calls[0].body.object.className, "GameScore");
    await cloud.runAfterSave("GameScore", { object: { objectId: "o1" } }); // 503: logged, not thrown
  } finally {
    await rx.stop();
  }
} });

Deno.test({ name: "hooks: PUT updates the url, { __op: Delete } removes it at once, and _Hooks reloads on boot", ...sanitize, fn: async () => {
  const rx = receiver((p) => ok(p));
  const db = fakeDb();
  const { cloud, hooks } = boot(db);
  try {
    await hooks.createFunction({ functionName: "where", url: `${rx.base}/one` });
    await hooks.putFunction("where", { url: `${rx.base}/two` });
    assertEquals(await cloud.run("where", {}), "/two");
    await hooks.putFunction("where", { __op: "Delete" });
    await assertRejects(() => cloud.run("where", {}), Error, "not found");
    await hooks.createTrigger({ className: "A", triggerName: "beforeDelete", url: `${rx.base}/t` });
    await hooks.putTrigger("A", "beforeDelete", { __op: "Delete" });
    const before = rx.calls.length;
    await cloud.runBeforeDelete("A", { object: {} });
    assertEquals(rx.calls.length, before, "a deleted trigger hook is not called");
    // A new instance on the same database loads what is in _Hooks.
    await hooks.createFunction({ functionName: "again", url: `${rx.base}/again` });
    const second = boot(db);
    await second.hooks.startBackground();
    assertEquals(await second.cloud.run("again", {}), "/again");
    assertEquals(db.rows[HOOKS_CLASS].length, 1);
  } finally {
    await rx.stop();
  }
} });

Deno.test("hooks: declarations are validated with Parse's error 143", async () => {
  const { hooks } = boot();
  await hooks.createFunction({ functionName: "x", url: "https://8.8.8.8/x" });
  for (const [what, p] of [
    ["duplicate", hooks.createFunction({ functionName: "x", url: "https://8.8.8.8/y" })],
    ["no url", hooks.createFunction({ functionName: "y" })],
    ["bad trigger", hooks.createTrigger({ className: "A", triggerName: "beforeLogin", url: "https://8.8.8.8/" })],
    ["bad class", hooks.createTrigger({ className: "a b", triggerName: "beforeSave", url: "https://8.8.8.8/" })],
    ["unknown", hooks.getFunction("nope")],
  ] as const) {
    const e = await assertRejects(() => p as Promise<unknown>, Error) as any;
    assertEquals(e.code, 143, what);
  }
  const strict = composeZenith([
    createTraitDescriptor({ name: "Db", provides: ["db"], consumes: [], state: [], runtimes: ["deno"], create: () => ({ db: fakeDb() }) }),
    stub("Acl", "acl"), stub("Schema", "schema"), CloudCodeTrait,
    createCloudHooksTrait({ policy: {} }),
  ]).traits as any;
  const e = await assertRejects(() => strict.cloudHooks.createFunction({ functionName: "m", url: "https://169.254.169.254/" }), Error) as any;
  assert(e.message.includes("non-public"));
});
