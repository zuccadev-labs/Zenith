/**
 * engine-push by its socket: the client, the `enginePush` capability and its consumers (ZenithPush,
 * ZenithNotifications), against an in-memory engine-push on a temporary Unix socket. One more test runs
 * the real daemon when zutool's build is there (`ENGINE_PUSH_BIN`, or the development path).
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { composeZenith } from "../../src/core/compose.ts";
import { fakeDb } from "./_fake_db.ts";
import {
  EnginePushClient,
  EnginePushError,
  enginePushSocketPath,
  ensureSubscription,
  targetFingerprint,
} from "../../src/traits/push/engine-push-client.ts";
import { createEnginePushApi, EnginePushTrait } from "../../src/traits/push/engine-push.trait.ts";
import { PushTrait } from "../../src/traits/push/push.trait.ts";
import { NotificationsTrait } from "../../src/traits/notifications/notifications.trait.ts";

type Sub = {
  subscriptionId: string;
  owner: string;
  provider: string;
  target: string;
  name: string;
};

/** An engine-push that answers `push/*` from memory on a temporary Unix socket. */
async function fakeEnginePush(opts: { failProvider?: string } = {}) {
  const dir = await Deno.makeTempDir({ prefix: "zenith-push-" });
  const path = `${dir}/engine-push.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const subs: Sub[] = [];
  let n = 0;
  const answer = (method: string, p: Record<string, any>): unknown => {
    switch (method) {
      case "engine/status":
        return { engine: "engine-push" };
      case "push/list":
        return subs.filter((s) => s.owner === p.owner).map((s) => ({
          subscriptionId: s.subscriptionId,
          provider: s.provider,
          name: s.name,
          target: "…",
        }));
      case "push/subscribe": {
        if (p.provider === "nope") {
          throw { code: -32000, message: "x", data: { code: "bad_provider" } };
        }
        const s = {
          subscriptionId: `s${++n}`,
          owner: p.owner,
          provider: p.provider,
          target: p.target,
          name: p.name ?? "",
        };
        subs.push(s);
        return { subscriptionId: s.subscriptionId, existing: false };
      }
      case "push/unsubscribe": {
        const i = subs.findIndex((s) => s.owner === p.owner && s.subscriptionId === p.id);
        if (i < 0) throw { code: -32004, message: "no", data: { code: "not_found" } };
        subs.splice(i, 1);
        return { ok: true };
      }
      case "push/send": {
        const mine = subs.filter((s) =>
          s.owner === p.owner && (!p.providers || p.providers.includes(s.provider))
        );
        const results = mine.map((s) =>
          s.provider === opts.failProvider
            ? {
              subscriptionId: s.subscriptionId,
              provider: s.provider,
              ok: false,
              error: "fcm HTTP 404",
            }
            : { subscriptionId: s.subscriptionId, provider: s.provider, ok: true }
        );
        return {
          delivered: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        };
      }
      case "push/purge-owner": {
        const before = subs.length;
        for (let i = subs.length - 1; i >= 0; i--) if (subs[i].owner === p.owner) subs.splice(i, 1);
        return { deleted: before - subs.length };
      }
    }
    throw { code: -32601, message: "unknown", data: { code: "unknown_operation" } };
  };
  const serve = (async () => {
    for await (const conn of listener) {
      (async () => {
        const buf = new Uint8Array(65536);
        let pending = "";
        while (true) {
          const r = await conn.read(buf).catch(() => null);
          if (r === null) break;
          pending += new TextDecoder().decode(buf.subarray(0, r));
          const nl = pending.indexOf("\n");
          if (nl < 0) continue;
          const req = JSON.parse(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          calls.push({ method: req.method, params: req.params });
          let out: unknown;
          try {
            out = { jsonrpc: "2.0", id: req.id, result: answer(req.method, req.params ?? {}) };
          } catch (e) {
            out = { jsonrpc: "2.0", id: req.id, error: e };
          }
          await conn.write(new TextEncoder().encode(JSON.stringify(out) + "\n")).catch(() => {});
        }
        try {
          conn.close();
        } catch { /* closed */ }
      })();
    }
  })();
  return {
    path,
    calls,
    subs,
    async close() {
      listener.close();
      await serve.catch(() => {});
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function boot(socket: string, opts: { enginePush?: boolean } = {}) {
  const db = fakeDb();
  const traits: unknown[] = [
    createTraitDescriptor({
      name: "Db",
      provides: ["db", "cloud"],
      consumes: [],
      state: [],
      runtimes: ["deno"],
      create: () => ({ db, cloud: {} }),
    }),
    PushTrait,
    NotificationsTrait,
  ];
  if (opts.enginePush !== false) traits.unshift(EnginePushTrait);
  const engine = composeZenith(traits).traits as Record<string, any>;
  engine.enginePush?.configure({ appId: "app1", socket, timeoutMs: 5000 });
  return { engine, db };
}

Deno.test("engine-push client: calls, error codes and the socket convention", async () => {
  const push = await fakeEnginePush();
  try {
    const c = new EnginePushClient({ socket: push.path });
    assert(await c.available());
    const { subscriptionId } = await c.subscribe("o:1", "ntfy", "https://ntfy.sh/x");
    assertEquals((await c.list("o:1")).map((s) => s.subscriptionId), [subscriptionId]);
    const e = await assertRejects(() => c.unsubscribe("o:1", "nope"), EnginePushError);
    assertEquals(e.code, "not_found");
    const u = await assertRejects(() => c.call("x/y"), EnginePushError);
    assertEquals(u.code, "unknown_operation");
    // ensure: same target, nothing new; a new target replaces the old one.
    await ensureSubscription(c, "o:2", "telegram", "42");
    await ensureSubscription(c, "o:2", "telegram", "42");
    assertEquals(push.subs.filter((s) => s.owner === "o:2").length, 1);
    await ensureSubscription(c, "o:2", "telegram", "43");
    const left = push.subs.filter((s) => s.owner === "o:2");
    assertEquals(left.map((s) => s.target), ["43"]);
    assertEquals(left[0].name, await targetFingerprint("telegram", "43"));
    await ensureSubscription(c, "o:2", "telegram", null);
    assertEquals(push.subs.filter((s) => s.owner === "o:2").length, 0);
  } finally {
    await push.close();
  }
  const gone = new EnginePushClient({ socket: "/nonexistent/engine-push.sock" });
  assertEquals(await gone.available(), false);
  assertEquals(
    (await assertRejects(() => gone.call("engine/status"), EnginePushError)).code,
    "unavailable",
  );

  const prev = Deno.env.get("ENGINE_PUSH_SOCKET");
  try {
    Deno.env.set("ENGINE_PUSH_SOCKET", "/run/x/engine-push.sock");
    assertEquals(enginePushSocketPath(), "/run/x/engine-push.sock");
    Deno.env.delete("ENGINE_PUSH_SOCKET");
    const xdg = Deno.env.get("XDG_RUNTIME_DIR");
    if (xdg) assertEquals(enginePushSocketPath(), `${xdg}/zutool/engine-push.sock`);
  } finally {
    if (prev) Deno.env.set("ENGINE_PUSH_SOCKET", prev);
  }
});

Deno.test("enginePush: owners, messages within limits, disabled", async () => {
  const api = createEnginePushApi({ appId: "my app", socket: "/nonexistent.sock" });
  assertEquals(await api.userOwner("u/1"), "zenith:my_app:u_1");
  assertEquals(await api.installationOwner("i-1"), "zenith:my_app:installation:i-1");
  const long = await api.userOwner("x".repeat(300));
  assert(long.length <= 128 && /^[A-Za-z0-9:_.@-]+$/.test(long));
  assertEquals(long, await api.userOwner("x".repeat(300)));
  const m = api.message({
    title: "t".repeat(300),
    body: "b".repeat(5000),
    kind: "a b",
    data: { title: "x", n: 1, o: {}, s: "v" },
  });
  assertEquals([m.title!.length, m.body!.length, m.kind], [200, 4000, "a-b"]);
  assertEquals(m.data, { n: "1", s: "v" });
  assertEquals(api.message({}).body, "…");
  api.configure({ enabled: false, socket: "/nonexistent.sock" });
  assertEquals(await api.available(), false);
  assertEquals(
    (await assertRejects(() => api.sendToUser("u", { body: "x" }), EnginePushError)).code,
    "unavailable",
  );
});

Deno.test("ZenithPush: /push delivers through engine-push, one subscription per installation", async () => {
  const push = await fakeEnginePush({ failProvider: "apns" });
  try {
    const { engine, db } = boot(push.path);
    const p = engine.push;
    await p.registerInstallation("i1", "fcm-token-1", "fcm", ["news"]);
    await p.registerInstallation("i2", "a".repeat(64), "apns", ["news"]);
    const r = await p.send({
      channels: ["news"],
      data: { alert: "Hola", title: "Zenith", badge: 1 },
    });
    assertEquals([r.sent, r.via, r.delivered], [2, "engine-push", 1]);
    assertEquals(r.deliveryLog.map((e: any) => [e.installationId, e.ok]), [["i1", true], [
      "i2",
      false,
    ]]);
    assertEquals(r.deliveryLog[1].error, "fcm HTTP 404");
    assertEquals(
      push.subs.map((s) => [s.owner, s.provider, s.target]).sort(),
      [["zenith:app1:installation:i1", "fcm", "fcm-token-1"], [
        "zenith:app1:installation:i2",
        "apns",
        "a".repeat(64),
      ]],
    );
    const send = push.calls.find((c) => c.method === "push/send")!;
    assertEquals(send.params.message.title, "Zenith");
    assertEquals(send.params.message.body, "Hola");
    assertEquals(send.params.message.data, { alert: "Hola", badge: "1" });
    assertEquals(db.rows["_PushDelivery"][0].via, "engine-push");
    // A second send reuses the subscriptions.
    const subscribes = push.calls.filter((c) => c.method === "push/subscribe").length;
    await p.send({ channels: ["news"], data: { alert: "otra" } });
    assertEquals(push.calls.filter((c) => c.method === "push/subscribe").length, subscribes);
  } finally {
    await push.close();
  }
});

Deno.test("ZenithPush: without engine-push the delivery is only recorded, as before", async () => {
  for (const enginePush of [true, false]) {
    const { engine, db } = boot("/nonexistent/engine-push.sock", { enginePush });
    await engine.push.registerInstallation("i1", "fcm-token-1", "fcm", ["news"]);
    const r = await engine.push.send({ channels: ["news"], data: { alert: "Hola" } });
    assertEquals([r.sent, r.via, r.delivered], [1, "none", undefined]);
    assertEquals(r.deliveryLog[0].deviceToken, "fcm-toke...");
    assertEquals(db.rows["_PushDelivery"].length, 1);
  }
});

Deno.test("ZenithNotifications: a notification also reaches the user's engine-push subscriptions", async () => {
  const push = await fakeEnginePush();
  try {
    const { engine } = boot(push.path);
    await engine.enginePush.subscribe("u1", "telegram", "42");
    const n = await engine.notifications.create("u1", {
      type: "mention",
      title: "Te mencionaron",
      body: "@ana mira esto",
    });
    assert(n);
    const r = await engine.notifications.relayed;
    assertEquals(r.delivered, 1);
    const send = push.calls.find((c) => c.method === "push/send")!;
    assertEquals(send.params.owner, "zenith:app1:u1");
    assertEquals(send.params.message.kind, "zenith-mention");
    assertEquals(send.params.message.urgency, "high");
    assertEquals(send.params.message.data.notificationId, n.objectId);
  } finally {
    await push.close();
  }
  // Without engine-push the notification is still created (in-app only).
  const { engine } = boot("/nonexistent/engine-push.sock");
  const n = await engine.notifications.create("u1", { body: "hola" });
  assert(n);
  assertEquals(await engine.notifications.relayed, null);
});

const realBin = Deno.env.get("ENGINE_PUSH_BIN") ??
  "/media/zuccadev/vol-zuccadev1/Development/Programacion/apps/zutool/target/debug/engine-push";
const haveReal = (() => {
  try {
    return Deno.statSync(realBin).isFile;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "with the real engine-push: a notification reaches a user's ntfy topic",
  ignore: !haveReal,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "zenith-push-real-" });
    const got: Array<Record<string, unknown>> = [];
    const http = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
      got.push(await req.json().catch(() => ({})));
      return new Response("{}");
    });
    const sock = `${dir}/engine-push.sock`;
    await Deno.writeTextFile(
      `${dir}/config.json`,
      JSON.stringify({ ntfy: { allowInsecure: true } }),
    );
    const child = new Deno.Command(realBin, {
      args: [
        "--socket",
        sock,
        "--state-dir",
        `${dir}/state`,
        "--config",
        `${dir}/config.json`,
        "daemon",
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const { engine } = boot(sock);
      for (let i = 0; i < 100 && !(await engine.enginePush.available()); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(await engine.enginePush.available(), "engine-push did not start");
      await engine.enginePush.subscribe(
        "u1",
        "ntfy",
        `http://127.0.0.1:${http.addr.port}/zenith-u1`,
      );
      await engine.notifications.create("u1", { title: "Hola", body: "desde Zenith" });
      const r = await engine.notifications.relayed;
      assertEquals(r.delivered, 1, JSON.stringify(r));
      assertStringIncludes(JSON.stringify(got), "desde Zenith");
      assertEquals((await engine.enginePush.purgeUser("u1")).deleted, 1);
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* exited */ }
      await child.status;
      await http.shutdown();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
