import { assert, assertEquals, assertRejects } from "@std/assert";
import { Webhook } from "standardwebhooks";
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { composeZenith } from "../../src/core/compose.ts";
import { fakeDb } from "./_fake_db.ts";
import { isSealed } from "../../src/core/crypto.ts";
import { EventBusTrait } from "../../src/traits/events/event-bus.trait.ts";
import { createWebhookManagerTrait, matchesEvent, sanitizePayload } from "../../src/traits/webhooks/webhook.manager.trait.ts";
import { classify, DISABLE_AFTER_EXHAUSTED, ENDPOINT_CLASS, MESSAGE_CLASS, nextAttemptAt, RETRY_SCHEDULE_MS } from "../../src/traits/webhooks/webhook.delivery.ts";

type Received = { headers: Record<string, string>; body: string };

/** A receiver on 127.0.0.1 that answers with whatever `reply` returns. */
function receiver(reply: () => Response | Promise<Response> = () => new Response("ok")) {
  const received: Received[] = [];
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, async (req) => {
    received.push({ headers: Object.fromEntries(req.headers), body: await req.text() });
    return await reply();
  });
  return { url: `http://127.0.0.1:${server.addr.port}/hook`, received, stop: async () => { ac.abort(); await server.finished; } };
}

function boot(opts: { enabled?: () => boolean; secretsKey?: string; db?: ReturnType<typeof fakeDb>; verify?: boolean } = {}) {
  const db = opts.db ?? fakeDb();
  // Real time: the official library rejects signatures more than 5 minutes off its own clock.
  const start = Date.now();
  let clock = start;
  const emitted: Array<{ event: string; payload: any }> = [];
  const traits: unknown[] = [
    EventBusTrait,
    createTraitDescriptor({ name: "Db", provides: ["db"], consumes: [], state: [], runtimes: ["deno"], create: () => ({ db }) }),
    createWebhookManagerTrait({ policy: { allowHttp: true, allowPrivate: true }, now: () => clock, secretsKey: opts.secretsKey, requireVerification: opts.verify ?? false }),
  ];
  if (opts.enabled) {
    traits.push(createTraitDescriptor({ name: "RF", provides: ["runtime-features"], consumes: [], state: [], runtimes: ["deno"], create: () => ({ "runtime-features": { isEnabled: () => opts.enabled!() } }) }));
  }
  const caps = composeZenith(traits).traits as any;
  caps.events.on("*", (e: any) => { emitted.push(e); });
  return {
    db, api: caps.webhookManager, bus: caps.events, emitted, start,
    advance: (ms: number) => { clock += ms; },
    /** Lets the bus subscriber finish enqueuing (it does not block the emitter). */
    settle: () => new Promise((r) => setTimeout(r, 10)),
  };
}

const sanitize = { sanitizeResources: false, sanitizeOps: false };

Deno.test({ name: "webhooks: a bus event reaches the endpoint signed per Standard Webhooks, without credentials", ...sanitize, fn: async () => {
  const rx = receiver();
  const { api, bus, db, settle } = boot();
  try {
    const ep = await api.create({ name: "crm", url: rx.url, events: ["Contact.*"] });
    assert(ep.secret.startsWith("whsec_"));
    assertEquals(ep.secrets, undefined, "never returned");
    await bus.emit("Contact.created", { objectId: "c1", name: "Ana", sessionToken: "r:secret", nested: { password: "x", ok: 1 } });
    await bus.emit("Deal.created", { objectId: "d1" }); // not subscribed
    await settle();
    assertEquals(await api.deliverDue(), 1);
    assertEquals(rx.received.length, 1);
    const { headers, body } = rx.received[0];
    const payload = new Webhook(ep.secret).verify(body, headers) as any; // the official library
    assertEquals(payload.type, "Contact.created");
    assertEquals(payload.data, { objectId: "c1", name: "Ana", nested: { ok: 1 } });
    const [m] = db.rows[MESSAGE_CLASS];
    assertEquals([m.status, m.attempts, headers["webhook-id"]], ["succeeded", 1, m.messageId]);
    assert(!m.messageId.includes("."));
  } finally {
    await rx.stop();
  }
} });

Deno.test({ name: "webhooks: failures retry on schedule, 429 honours retry-after, 410 disables the endpoint", ...sanitize, fn: async () => {
  let status = 500;
  const rx = receiver(() => new Response("no", { status, headers: status === 429 ? { "retry-after": "600" } : {} }));
  const { api, db, advance, emitted, start } = boot();
  try {
    const ep = await api.create({ name: "x", url: rx.url, events: ["*"] });
    await api.publish("Order.paid", { id: 1 });
    await api.deliverDue();
    let [m] = db.rows[MESSAGE_CLASS];
    assertEquals([m.status, m.attempts, m.lastStatusCode], ["pending", 1, 500]);
    assertEquals(await api.deliverDue(), 0, "not due yet");
    advance(6_000);
    status = 429;
    await api.deliverDue();
    [m] = db.rows[MESSAGE_CLASS];
    assert(Date.parse(m.nextAttemptAt) - (start + 6_000) >= 600_000, "retry-after: 600 s");
    advance(700_000);
    status = 410;
    await api.deliverDue();
    [m] = db.rows[MESSAGE_CLASS];
    assertEquals(m.status, "failed");
    const stored = db.rows[ENDPOINT_CLASS].find((e) => e.objectId === ep.objectId)!;
    assertEquals(stored.status, "disabled");
    assert(emitted.some((e) => e.event === "webhook.endpoint.disabled"));
    // Resuming re-enables it.
    assertEquals((await api.setStatus(ep.objectId, "active")).status, "active");
  } finally {
    await rx.stop();
  }
} });

Deno.test({ name: "webhooks: a paused endpoint keeps its messages and delivers them on resume", ...sanitize, fn: async () => {
  const rx = receiver();
  const { api } = boot();
  try {
    const ep = await api.create({ name: "x", url: rx.url, events: ["*"] });
    await api.setStatus(ep.objectId, "paused");
    assertEquals(await api.publish("A.b", {}), 1);
    await api.deliverDue();
    assertEquals(rx.received.length, 0);
    await api.setStatus(ep.objectId, "active");
    await api.deliverDue();
    assertEquals(rx.received.length, 1);
  } finally {
    await rx.stop();
  }
} });

Deno.test({ name: "webhooks: rotation signs with the new and the previous secret during the grace period", ...sanitize, fn: async () => {
  const rx = receiver();
  const { api, advance } = boot();
  try {
    const ep = await api.create({ name: "x", url: rx.url, events: ["*"] });
    const rot = await api.rotateSecret(ep.objectId, 24);
    assert(rot.secret !== ep.secret && rot.previousValidUntil);
    await api.publish("A.b", {});
    await api.deliverDue();
    const r = rx.received.at(-1)!;
    assertEquals(r.headers["webhook-signature"].split(" ").length, 2);
    new Webhook(ep.secret).verify(r.body, r.headers);
    new Webhook(rot.secret).verify(r.body, r.headers);
    advance(25 * 3_600_000); // grace over: only the new secret signs
    await api.publish("A.b", {});
    await api.deliverDue();
    assertEquals(rx.received.at(-1)!.headers["webhook-signature"].split(" ").length, 1);
  } finally {
    await rx.stop();
  }
} });

Deno.test({ name: "webhooks: redelivery keeps the webhook-id; recovery requeues failed messages since a date", ...sanitize, fn: async () => {
  let ok = false;
  const rx = receiver(() => new Response("", { status: ok ? 200 : 410 }));
  const { api, db } = boot();
  try {
    const ep = await api.create({ name: "x", url: rx.url, events: ["*"] });
    await api.publish("A.b", { n: 1 });
    await api.deliverDue();
    const [m] = db.rows[MESSAGE_CLASS];
    assertEquals(m.status, "failed");
    await api.setStatus(ep.objectId, "active");
    ok = true;
    await api.redeliver(ep.objectId, m.messageId);
    await api.deliverDue();
    assertEquals(rx.received.at(-1)!.headers["webhook-id"], m.messageId);
    assertEquals((await api.attempts(ep.objectId, m.messageId)).results.length, 2);
    ok = false;
    await api.publish("A.b", { n: 2 });
    await api.deliverDue();
    await api.setStatus(ep.objectId, "active");
    ok = true;
    assertEquals((await api.recover(ep.objectId, "2000-01-01T00:00:00Z")).requeued, 1);
    await api.deliverDue();
    assertEquals((await api.messages(ep.objectId, "failed")).results.length, 0);
    assertEquals((await api.messages(ep.objectId)).results[0].body, undefined, "bodies are not listed");
  } finally {
    await rx.stop();
  }
} });

Deno.test({ name: "webhooks: two workers never deliver the same message twice", ...sanitize, fn: async () => {
  const rx = receiver(async () => { await new Promise((r) => setTimeout(r, 20)); return new Response("ok"); });
  const a = boot();
  const b = boot({ db: a.db }); // a second Zenith instance on the same database
  try {
    await a.api.create({ name: "x", url: rx.url, events: ["*"] });
    for (let i = 0; i < 5; i++) await a.api.publish("A.b", { i });
    await Promise.all([a.api.deliverDue(), b.api.deliverDue()]);
    assertEquals(rx.received.length, 5, "each message once");
    assertEquals(new Set(rx.received.map((r) => r.headers["webhook-id"])).size, 5);
  } finally {
    await rx.stop();
  }
} });

Deno.test("webhooks: turned off at runtime, nothing is enqueued", async () => {
  let on = false;
  const { api } = boot({ enabled: () => on });
  await api.create({ name: "x", url: "https://8.8.8.8/hook", events: ["*"] });
  assertEquals(await api.publish("A.b", {}), 0);
  on = true;
  assertEquals(await api.publish("A.b", {}), 1);
});

Deno.test("webhooks: endpoints are validated (SSRF, events, reserved headers) and secrets can be encrypted at rest", async () => {
  const strict = composeZenith([
    createTraitDescriptor({ name: "Db", provides: ["db"], consumes: [], state: [], runtimes: ["deno"], create: () => ({ db: fakeDb() }) }),
    createWebhookManagerTrait({ policy: {}, requireVerification: false }),
  ]).traits as any;
  await assertRejects(() => strict.webhookManager.create({ name: "x", url: "http://example.com/h", events: ["*"] }), Error, "https");
  await assertRejects(() => strict.webhookManager.create({ name: "x", url: "https://169.254.169.254/", events: ["*"] }), Error, "non-public");
  const { api, db } = boot({ secretsKey: "k".repeat(32) });
  await assertRejects(() => api.create({ name: "x", url: "https://8.8.8.8/", events: ["bad pattern"] }), Error, "events");
  await assertRejects(() => api.create({ name: "x", url: "https://8.8.8.8/", events: ["*"], headers: { "webhook-id": "x" } }), Error, "set by Zenith");
  await api.create({ name: "x", url: "https://8.8.8.8/", events: ["*"], headers: { Authorization: "Bearer t" } });
  assert(isSealed(db.rows[ENDPOINT_CLASS][0].secrets[0].value), "stored encrypted");
});

Deno.test("webhooks: schedule, status classification, event patterns and sanitising", () => {
  assertEquals(RETRY_SCHEDULE_MS.length, 10);
  assertEquals(nextAttemptAt(1, 0, () => 0.5), 5_000);
  assertEquals(nextAttemptAt(10, 0), null);
  assertEquals(classify(204, null, 0).kind, "success");
  assertEquals(classify(301, null, 0).kind, "retry");
  assertEquals(classify(410, null, 0).kind, "gone");
  assertEquals(classify(503, "30", 0), { kind: "retry", notBeforeMs: 30_000 });
  assert(DISABLE_AFTER_EXHAUSTED >= 1);
  assert(matchesEvent(["Deal.*"], "Deal.won") && !matchesEvent(["Deal.*"], "Dealer.x") && matchesEvent(["*"], "x"));
  assertEquals(sanitizePayload([{ a: 1, authData: {} }]), [{ a: 1 }]);
});

Deno.test({ name: "webhooks: endpoint verification (Standard Webhooks) gates deliveries until the receiver answers the challenge", ...sanitize, fn: async () => {
  const { endpointVerificationResponse } = await import("../../src/security/webhook-signature.ts");
  let secret = "";
  let answer = false;
  const rx = receiver(async () => new Response(null, { status: 204 }));
  // A receiver that answers challenges the way the spec says, once it knows its secret.
  const ac = new AbortController();
  const challenges: Record<string, string>[] = [];
  const srv = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, async (req) => {
    const c = req.headers.get("webhook-challenge");
    if (c) {
      challenges.push(Object.fromEntries(req.headers));
      return new Response(null, { status: 204, headers: answer ? { "webhook-challenge-response": await endpointVerificationResponse(secret, c) } : {} });
    }
    return fetch(rx.url, { method: "POST", headers: req.headers, body: await req.text() });
  });
  const url = `http://127.0.0.1:${srv.addr.port}/hook`;
  const { api } = boot({ verify: true });
  try {
    const ep = await api.create({ name: "x", url, events: ["*"] });
    secret = ep.secret;
    assertEquals(ep.status, "unverified");
    assert(ep._verification.includes("/verify"));
    assertEquals(await api.publish("A.b", {}), 0, "no consent yet: nothing is enqueued");
    await assertRejects(() => api.setStatus(ep.objectId, "active"), Error, "not verified");
    const failed = await api.verify(ep.objectId);
    assertEquals([failed.verified, failed.status], [false, "unverified"]);
    assert(failed.reason.includes("webhook-challenge-response"));
    assert(challenges[0]["webhook-signature"]?.startsWith("v1,"), "the challenge request is signed like a webhook");
    assertEquals(atob(challenges[0]["webhook-challenge"]).length, 32);
    answer = true;
    assertEquals((await api.verify(ep.objectId)).status, "active");
    assert(challenges[0]["webhook-challenge"] !== challenges[1]["webhook-challenge"], "a new challenge each time");
    assertEquals(await api.publish("A.b", { n: 1 }), 1);
    await api.deliverDue();
    assertEquals(rx.received.length, 1, "delivered once verified");
    const moved = await api.update(ep.objectId, { url: `${url}?v=2` });
    assertEquals(moved.status, "unverified", "a new URL must pass the check again");
  } finally {
    ac.abort();
    await srv.finished;
    await rx.stop();
  }
} });

