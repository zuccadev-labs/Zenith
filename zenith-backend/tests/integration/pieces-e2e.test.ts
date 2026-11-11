/**
 * The pieces of 2026-11-11 working end to end in the real engine: createZenithApp on MongoDB with
 * engine-auth, HTTP requests through its handler, and checks straight in MongoDB.
 *
 * - Feature toggles at runtime (/zen/features), persisted in _ZenithFeature.
 * - Webhooks: a CRUD write reaches a real receiver, signed (verified with the official library),
 *   delivered by the background worker that createZenithApp starts.
 * - Cloud Code Hooks: a beforeSave hook changes the object on create AND on update (Parse Server).
 * - Durable queue: a job enqueued by one instance is processed by another one started later.
 *
 *   ZENITH_TEST_MONGO=mongodb://127.0.0.1:27999 ENGINE_AUTH_BIN=… ZUTOOL_LIB_DIR=…
 */
import { assert, assertEquals } from "@std/assert";
import { Webhook } from "standardwebhooks";
import { MongoClient, ObjectId } from "mongodb";
import { createZenithApp } from "../../src/mod.ts";
import { endpointVerificationResponse } from "../../src/security/webhook-signature.ts";
import { AUD, BIN, EngineAuth, LIB_DIR } from "./_engine_auth_lab.ts";

const MONGO = Deno.env.get("ZENITH_TEST_MONGO");
const ignore = !MONGO || !BIN || !LIB_DIR;

async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  what: string,
  ms = 15_000,
): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A receiver on 127.0.0.1: /webhook records deliveries, /before multiplies `score` by 10 (a Parse hook). */
function receiver() {
  const secret = { value: "" }; // the endpoint secret, once Zenith has given it
  const deliveries: Array<{ headers: Record<string, string>; body: string }> = [];
  const hookCalls: any[] = [];
  const ac = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen: () => {},
  }, async (req) => {
    const path = new URL(req.url).pathname;
    const body = await req.text();
    const challenge = req.headers.get("webhook-challenge");
    if (path === "/webhook" && challenge) {
      // Endpoint verification: answer with the key derived from the secret, never process the body.
      return new Response(null, {
        status: 204,
        headers: {
          "webhook-challenge-response": await endpointVerificationResponse(secret.value, challenge),
        },
      });
    }
    if (path === "/webhook") {
      deliveries.push({ headers: Object.fromEntries(req.headers), body });
      return new Response(null, { status: 204 });
    }
    const call = JSON.parse(body);
    hookCalls.push(call);
    return Response.json({ success: { ...call.object, score: (call.object.score ?? 0) * 10 } });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    secret,
    deliveries,
    hookCalls,
    stop: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

Deno.test({
  name: "e2e: feature toggles, webhooks, Parse hooks and the durable queue in the real engine",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    Deno.env.set("ZENITH_WEBHOOKS_ALLOW_PRIVATE", "1"); // the receiver is on localhost
    Deno.env.set("WEBHOOK_SECRETS_KEY", crypto.randomUUID()); // as in production: secrets encrypted at rest
    const ea = await EngineAuth.start();
    const rx = receiver();
    const mongo = new MongoClient(`${MONGO}/?directConnection=true`);
    const appId = `e2e${Date.now()}`;
    const master = crypto.randomUUID() + crypto.randomUUID();
    const config = {
      appId,
      masterKey: master,
      serverURL: "http://localhost:1/parse",
      port: 1,
      databaseURI: `${MONGO}/?directConnection=true`,
      features: {},
      engineAuth: {
        issuer: ea.url,
        clientId: "zenith",
        audience: AUD,
        libDir: LIB_DIR,
        sessionKey: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
      },
    } as any;
    try {
      const app = await createZenithApp(config);
      const call = async (handler: any, method: string, path: string, body?: unknown) => {
        const req = new Request(`http://zenith.test${path}`, {
          method,
          headers: {
            "X-Parse-Application-Id": appId,
            "X-Parse-Master-Key": master,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        (req as any).__socketAddr = { hostname: "127.0.0.1" };
        const r = await handler(req);
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      const api = (method: string, path: string, body?: unknown) =>
        call(app.handler, method, path, body);
      const db = mongo.db(appId);

      // ── 1. Runtime feature toggles ────────────────────────────────────────────
      const features = await api("GET", "/zen/features");
      assertEquals(features.status, 200);
      assert(features.body.results.some((f: any) => f.id === "webhooks" && f.enabled));
      assertEquals((await api("GET", "/zen/blog/posts")).status, 200);
      assertEquals((await api("PUT", "/zen/features/blogForum", { enabled: false })).status, 200);
      assertEquals(
        (await api("GET", "/zen/blog/posts")).status,
        404,
        "turned off: its routes do not exist",
      );
      assertEquals(
        (await db.collection("_ZenithFeature").findOne({ featureId: "blogForum" }))?.enabled,
        false,
        "persisted in MongoDB",
      );
      assertEquals(
        (await api("PUT", "/zen/features/acl", { enabled: false })).status,
        403,
        "the core cannot be turned off",
      );
      assertEquals((await api("PUT", "/zen/features/blogForum", { enabled: true })).status, 200);
      assertEquals((await api("GET", "/zen/blog/posts")).status, 200, "back on without restarting");

      // ── 2. A class, a webhook endpoint and a beforeSave hook ──────────────────
      assertEquals(
        (await api("POST", "/schemas/GameScore", {
          fields: { player: { type: "String" }, score: { type: "Number" } },
        })).status,
        200,
      );
      const ep = await api("POST", "/zen/webhooks", {
        name: "e2e",
        url: `${rx.base}/webhook`,
        events: ["GameScore.*"],
      });
      assertEquals(ep.status, 201, JSON.stringify(ep.body));
      assertEquals(ep.body.status, "unverified", "a new endpoint waits for verification");
      rx.secret.value = ep.body.secret;
      const verified = await api("POST", `/zen/webhooks/${ep.body.objectId}/verify`);
      assertEquals([verified.status, verified.body.verified, verified.body.status], [
        200,
        true,
        "active",
      ], JSON.stringify(verified.body));
      const hook = await api("POST", "/hooks/triggers", {
        className: "GameScore",
        triggerName: "beforeSave",
        url: `${rx.base}/before`,
      });
      assertEquals(hook.status, 201, JSON.stringify(hook.body));

      // ── 3. beforeSave changes the object on create and on update, saved in MongoDB ──
      const created = await api("POST", "/classes/GameScore", { player: "ana", score: 2 });
      assertEquals(created.status, 201, JSON.stringify(created.body));
      const id = created.body.objectId;
      // The MongoDB adapter stores objectId as the document's ObjectId _id.
      assertEquals(
        (await db.collection("GameScore").findOne({ _id: new ObjectId(id) }))?.score,
        20,
        "create: the hook's value is stored",
      );
      const updated = await api("PUT", `/classes/GameScore/${id}`, { score: 7 });
      assertEquals(updated.status, 200, JSON.stringify(updated.body));
      assertEquals(
        (await api("GET", `/classes/GameScore/${id}`)).body.score,
        70,
        "update: the hook's value is stored too",
      );
      assertEquals(
        (await db.collection("GameScore").findOne({ _id: new ObjectId(id) }))?.score,
        70,
      );
      assertEquals(rx.hookCalls.map((c) => c.triggerName), ["beforeSave", "beforeSave"]);
      assert(!JSON.stringify(rx.hookCalls).includes(master), "the master key is never forwarded");

      // ── 4. The CRUD events reached the receiver, signed, through the background worker ──
      const got = await waitFor(
        async () => rx.deliveries.length >= 2 && rx.deliveries,
        "two webhook deliveries",
      );
      const types = got.map((d) =>
        (new Webhook(ep.body.secret).verify(d.body, d.headers) as any).type
      ).sort();
      assertEquals(types, ["GameScore.created", "GameScore.updated"]);
      const messages = await db.collection("ZenithWebhookMessage").find({
        endpointId: ep.body.objectId,
      }).toArray();
      assertEquals(messages.map((m) => m.status).sort(), ["succeeded", "succeeded"]);
      const storedSecret =
        (await db.collection("ZenithWebhook").findOne({ _id: new ObjectId(ep.body.objectId) }))
          ?.secrets?.[0]?.value;
      assert(
        String(storedSecret).startsWith("enc:v1:") &&
          !String(storedSecret).includes(ep.body.secret),
        "stored encrypted in MongoDB",
      );
      const again = await api("GET", `/zen/webhooks/${ep.body.objectId}`);
      assertEquals([again.body.secret, again.body.secrets, again.body.secretCount], [
        undefined,
        undefined,
        1,
      ], "never returned again");

      // ── 5. Files: uploaded, then downloaded anonymously through a signed URL ──
      const filesDir = await Deno.makeTempDir();
      Deno.env.set("ZENITH_FILES_DIR", filesDir);
      const content = new TextEncoder().encode("informe trimestral");
      const up = await app.handler!(
        Object.assign(
          new Request("http://zenith.test/files/informe.txt", {
            method: "POST",
            body: content,
            headers: {
              "X-Parse-Application-Id": appId,
              "X-Parse-Master-Key": master,
              "content-type": "text/plain",
            },
          }),
          { __socketAddr: { hostname: "127.0.0.1" } },
        ),
      );
      assertEquals(up.status, 201, await up.clone().text());
      const signed = await api("GET", "/zen/files/informe.txt/url?expiresIn=600");
      assertEquals(signed.status, 200, JSON.stringify(signed.body));
      const anon = async (path: string) => {
        const req = new Request(`http://zenith.test${path}`, {
          headers: { "X-Parse-Application-Id": appId },
        });
        (req as any).__socketAddr = { hostname: "203.0.113.70" }; // anyone, from anywhere, no key
        return await app.handler!(req);
      };
      const dl = await anon(signed.body.url);
      assertEquals(dl.status, 200);
      assertEquals(new Uint8Array(await dl.arrayBuffer()), content, "the bytes stored on upload");
      assertEquals(dl.headers.get("x-content-type-options"), "nosniff");
      const tampered = signed.body.url.replace(
        /sig=([0-9a-f])/,
        (_: string, c: string) => `sig=${c === "0" ? "1" : "0"}`,
      );
      assertEquals((await anon(tampered)).status, 403, "a tampered signature is refused");
      assertEquals(
        (await anon(signed.body.url.replace(/expires=\d+/, `expires=${Date.now() - 1000}`))).status,
        403,
        "expired",
      );
      assertEquals(
        (await anon("/files/informe.txt")).status,
        401,
        "without a signature the file is master-only",
      );
      assertEquals(
        (await api("GET", "/zen/files/informe.txt/url?expiresIn=99999999")).status,
        400,
        "at most 7 days",
      );
      Deno.env.delete("ZENITH_FILES_DIR");
      await Deno.remove(filesDir, { recursive: true });

      // ── 6. Durable queue: enqueued by this instance, processed by one started later ──
      const job = await api("POST", "/queue/enqueue", { type: "e2e.job", data: { n: 1 } });
      assertEquals(job.status, 201, JSON.stringify(job.body));
      assertEquals(
        (await db.collection("_Job").findOne({ jobId: job.body.jobId }))?.status,
        "pending",
        "no worker here: it waits",
      );
      const second = await createZenithApp(config); // "restart": a new instance on the same database
      const done: unknown[] = [];
      (second.engine as any).queue.registerWorker("e2e.job", (d: unknown) => {
        done.push(d);
        return "ok";
      });
      await waitFor(
        async () => (await db.collection("_Job").findOne({
          jobId: job.body.jobId,
          status: "completed",
        })),
        "the job to complete",
      );
      assertEquals(done, [{ n: 1 }], "processed exactly once");
      assertEquals(
        (await call(second.handler, "GET", "/queue/jobs?status=completed")).body.jobs.length,
        1,
      );
    } finally {
      Deno.env.delete("ZENITH_WEBHOOKS_ALLOW_PRIVATE");
      Deno.env.delete("WEBHOOK_SECRETS_KEY");
      await mongo.close();
      await rx.stop();
      await ea.stop();
    }
  },
});
