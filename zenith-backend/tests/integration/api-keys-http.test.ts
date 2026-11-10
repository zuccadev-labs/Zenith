/**
 * API keys end to end on MongoDB: created over HTTP with the master key, used as credentials,
 * bound to their app, revocable, and still valid after a restart.
 *
 *   ZENITH_TEST_MONGO=mongodb://127.0.0.1:27999
 */
import { assert, assertEquals } from "@std/assert";
import { createZenithApp } from "../../src/mod.ts";

const MONGO = Deno.env.get("ZENITH_TEST_MONGO");

async function app(appId: string, master: string) {
  const { handler } = await createZenithApp({
    appId, masterKey: master, serverURL: "http://localhost:1/parse", port: 1,
    databaseURI: `${MONGO}/${appId}?directConnection=true`, features: {},
  } as any);
  return async (method: string, path: string, o: { body?: unknown; master?: boolean; key?: string; asApp?: string } = {}) => {
    const headers: Record<string, string> = { "X-Parse-Application-Id": o.asApp ?? appId, "content-type": "application/json" };
    if (o.master) headers["X-Parse-Master-Key"] = master;
    if (o.key) headers["Authorization"] = `Bearer ${o.key}`;
    const req = new Request(`http://zenith.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    (req as any).__socketAddr = { hostname: o.master ? "127.0.0.1" : "198.51.100.60" };
    const r = await handler!(req);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

Deno.test({ name: "api keys: HTTP management, app binding, revocation, persistence", ignore: !MONGO, sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const { MongoClient } = await import("mongodb");
  const client = await new MongoClient(MONGO!).connect();
  const a = `keysA${Date.now()}`, b = `keysB${Date.now()}`;
  const master = crypto.randomUUID() + crypto.randomUUID();
  try {
    const callA = await app(a, master);
    const callB = await app(b, master);

    assertEquals((await callA("GET", "/zen/api-keys")).status, 401, "management needs the master key");
    const made = await callA("POST", "/zen/api-keys", { master: true, body: { name: "ci", prefix: "sk", env: "test", scopes: ["*"] } });
    assertEquals(made.status, 201, JSON.stringify(made.body));
    const key = made.body.key as string;
    assert(key.startsWith("sk_test_"));
    assertEquals(made.body.record.hash, undefined, "the hash never leaves the server");

    // The key is a credential for its own app, from anywhere (no localhost rule).
    assertEquals((await callA("GET", "/zen/api-keys", { key })).status, 200, "scope * acts as master on app A");
    // Not for another app, whatever Application-Id the caller sends.
    assertEquals((await callB("GET", "/zen/api-keys", { key, asApp: b })).status, 401, "a key of A on app B");

    // App B's master key cannot see or touch A's keys.
    const seenByB = (await callB("GET", "/zen/api-keys", { master: true })).body.results as { id: string; appId: string }[];
    assert(seenByB.every((k) => k.appId === b) && !seenByB.some((k) => k.id === made.body.record.id), "B lists only its own keys");
    assertEquals((await callB("POST", `/zen/api-keys/${made.body.record.id}/revoke`, { master: true, body: {} })).status, 404);

    // Persisted: a fresh instance of app A (a restart) still accepts it.
    const restarted = await app(a, master);
    assertEquals((await restarted("GET", "/zen/api-keys", { key })).status, 200, "survives a restart");

    // Rotation issues a new key; revocation stops the old one.
    const rot = await callA("POST", `/zen/api-keys/${made.body.record.id}/rotate`, { master: true, body: { graceHours: 0 } });
    assertEquals(rot.status, 201);
    assertEquals((await callA("GET", "/zen/api-keys", { key: rot.body.key })).status, 200, "the rotated key works");
    assertEquals((await callA("POST", `/zen/api-keys/${made.body.record.id}/revoke`, { master: true, body: { reason: "test" } })).status, 200);
    assertEquals((await callA("GET", "/zen/api-keys", { key })).status, 401, "revoked");

    assertEquals((await callA("POST", "/zen/api-keys", { master: true, body: { name: "x", prefix: "zz" } })).status, 400);
  } finally {
    await client.db("zenith_api_keys").collection("api_keys").deleteMany({ appId: { $in: [a, b] } });
    for (const d of [a, b]) await client.db(d).dropDatabase().catch(() => {});
    await client.close();
  }
}});
