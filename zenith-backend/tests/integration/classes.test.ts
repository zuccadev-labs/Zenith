/**
 * /classes open to users, against MongoDB and the real engine-auth: two users who must not see or
 * touch each other's data, the server's own collections, and query injection.
 *
 *   ZENITH_TEST_MONGO=mongodb://127.0.0.1:27999 ENGINE_AUTH_BIN=… ZUTOOL_LIB_DIR=…
 */
import { assert, assertEquals } from "@std/assert";
import { createZenithApp } from "../../src/mod.ts";
import { AUD, BIN, EngineAuth, LIB_DIR } from "./_engine_auth_lab.ts";

const MONGO = Deno.env.get("ZENITH_TEST_MONGO");
const PASSWORD = "otra frase larga para zenith";

type Call = (method: string, path: string, o?: { body?: unknown; token?: string; master?: boolean }) => Promise<{ status: number; body: any }>;

async function app(ea: EngineAuth, appId: string, master: string, extra: Record<string, unknown> = {}): Promise<Call> {
  const { handler } = await createZenithApp({
    appId, masterKey: master, serverURL: "http://localhost:1/parse", port: 1,
    databaseURI: `${MONGO}/${appId}?directConnection=true`, features: {},
    engineAuth: {
      issuer: ea.url, clientId: "zenith", audience: AUD, libDir: LIB_DIR,
      sessionKey: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    },
    ...extra,
  } as any);
  return async (method, path, o = {}) => {
    const headers: Record<string, string> = { "X-Parse-Application-Id": appId, "content-type": "application/json" };
    if (o.token) headers["X-Parse-Session-Token"] = o.token;
    if (o.master) headers["X-Parse-Master-Key"] = master;
    const req = new Request(`http://zenith.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    (req as any).__socketAddr = { hostname: o.master ? "127.0.0.1" : "198.51.100.40" };
    const r = await handler!(req);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

const q = (where: unknown, extra = "") => `?where=${encodeURIComponent(JSON.stringify(where))}${extra}`;

Deno.test({ name: "classes: schema-defined classes, CLP, ACL in the query, server collections closed", ignore: !MONGO || !BIN || !LIB_DIR, sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const ea = await EngineAuth.start();
  const { MongoClient } = await import("mongodb");
  const client = await new MongoClient(MONGO!).connect();
  const appId = `cls${Date.now()}`;
  try {
    const master = crypto.randomUUID() + crypto.randomUUID();
    const call = await app(ea, appId, master);
    // A trait's internal collection: no schema, no ACL.
    await client.db(appId).collection("Secret").insertOne({ apiKeyHash: "do-not-leak" });

    const signup = async (name: string) => {
      const r = await call("POST", "/users", { body: { username: name, email: `${name}@example.test`, password: PASSWORD } });
      assertEquals(r.status, 201, JSON.stringify(r.body));
      return { id: r.body.objectId as string, token: r.body.sessionToken as string };
    };
    const ana = await signup("ana"), bob = await signup("bob");

    // Classes exist when the master key defines them.
    assertEquals((await call("POST", "/schemas/Note", { master: true, body: { fields: { title: { type: "String" }, n: { type: "Number" } } } })).status, 200);
    assertEquals((await call("POST", "/schemas/Board", { master: true, body: { fields: {}, clp: { find: { "role:editors": true } } } })).status, 200);

    assertEquals((await call("GET", "/classes/Note")).status, 401, "anonymous");

    // Without an ACL a note is its creator's; with ACL "*" it is public.
    const priv = await call("POST", "/classes/Note", { token: ana.token, body: { title: "privada", objectId: "chosen", createdAt: "1999" } });
    assertEquals(priv.status, 201, JSON.stringify(priv.body));
    assertEquals(priv.body.ACL, { [ana.id]: { r: true, w: true } });
    assert(priv.body.objectId !== "chosen", "the server picks objectId");
    const pub = await call("POST", "/classes/Note", { token: ana.token, body: { title: "pública", ACL: { "*": { read: true } } } });
    assertEquals(pub.status, 201);
    for (let i = 0; i < 3; i++) await call("POST", "/classes/Note", { token: bob.token, body: { title: `bob ${i}` } });

    // Bob sees his notes and the public one; paging and count apply after the ACL.
    // Descending, ana's private note sorts second: if the ACL were applied after the database
    // limit, Bob would get one result instead of two.
    const bobList = await call("GET", "/classes/Note?count=1&limit=2&order=-title", { token: bob.token });
    assertEquals(bobList.status, 200, JSON.stringify(bobList.body));
    assertEquals(bobList.body.count, 4);
    assertEquals(bobList.body.results.map((r: any) => r.title), ["pública", "bob 2"]);
    const bobAll = await call("GET", "/classes/Note", { token: bob.token });
    assert(!bobAll.body.results.some((r: any) => r.title === "privada"), "ana's private note is not listed");

    // Someone else's object is "not found", for reading and for writing.
    for (const [m, body] of [["GET", undefined], ["PUT", { title: "x" }], ["DELETE", undefined]] as const) {
      const r = await call(m, `/classes/Note/${priv.body.objectId}`, { token: bob.token, body });
      assertEquals([r.status, r.body?.code], [404, 101], `${m} on ana's note`);
    }
    const pubWrite = await call("PUT", `/classes/Note/${pub.body.objectId}`, { token: bob.token, body: { title: "x" } });
    assertEquals([pubWrite.status, pubWrite.body?.code], [404, 101], "public read is not public write");

    // Parse operations, atomic in MongoDB.
    for (let i = 0; i < 2; i++) await call("PUT", `/classes/Note/${priv.body.objectId}`, { token: ana.token, body: { n: { __op: "Increment", amount: 2 } } });
    assertEquals((await call("GET", `/classes/Note/${priv.body.objectId}`, { token: ana.token })).body.n, 4);

    // The server's collections and the traits' internal data.
    for (const path of ["/classes/Secret", "/classes/_Session", "/classes/_User", `/users/${ana.id}`]) {
      const r = await call("GET", path, { token: bob.token });
      assertEquals([r.status, r.body?.code], [403, 119], path);
    }
    assertEquals((await call("POST", "/classes/Secret", { token: bob.token, body: { apiKeyHash: "x" } })).status, 403);
    assertEquals((await call("POST", "/classes/NewThing", { token: bob.token, body: { a: 1 } })).status, 403, "no client class creation");
    assertEquals((await call("GET", "/classes/Secret", { master: true })).body?.results?.[0]?.apiKeyHash, "do-not-leak", "the master key still can");

    // CLP by role.
    assertEquals((await call("GET", "/classes/Board", { token: bob.token })).status, 403);

    // Query injection.
    for (const where of [{ $where: "sleep(100) || true" }, { title: { $inQuery: { className: "Secret", where: {} } } }, { "ACL.*.r": { $exists: false } }]) {
      const r = await call("GET", `/classes/Note${q(where)}`, { token: bob.token });
      assertEquals(r.status, 400, JSON.stringify(where));
    }
    const bad = await call("POST", "/classes/Note", { token: bob.token, body: { title: { $gt: "" } } });
    assertEquals([bad.status, bad.body?.code], [400, 121]);

    // Batch: each operation with the same checks.
    const batch = await call("POST", "/batch", { token: bob.token, body: { requests: [
      { method: "POST", path: `/parse/classes/Note`, body: { title: "lote" } },
      { method: "GET", path: `/parse/classes/Note/${priv.body.objectId}` },
      { method: "GET", path: `/parse/classes/Secret` },
    ] } });
    assertEquals(batch.status, 200);
    assert(batch.body[0].success?.objectId);
    assertEquals(batch.body[1].error?.code, 101);
    assertEquals(batch.body[2].error?.code, 119);
    assertEquals((await call("POST", "/batch", { token: bob.token, body: { requests: Array(51).fill({ method: "GET", path: "/classes/Note" }) } })).status, 400);

    // Delete.
    assertEquals((await call("DELETE", `/classes/Note/${priv.body.objectId}`, { token: ana.token })).status, 200);
    assertEquals((await call("GET", `/classes/Note/${priv.body.objectId}`, { token: ana.token })).status, 404);

    // allowClientClassCreation: new classes yes, existing collections never.
    const open = await app(ea, `${appId}b`, master, { allowClientClassCreation: true });
    await client.db(`${appId}b`).collection("Secret").insertOne({ apiKeyHash: "do-not-leak" });
    const carl = await open("POST", "/users", { body: { username: "carl", email: "carl@example.test", password: PASSWORD } });
    assertEquals((await open("POST", "/classes/Fresh", { token: carl.body.sessionToken, body: { a: 1 } })).status, 201);
    assertEquals((await open("POST", "/classes/Secret", { token: carl.body.sessionToken, body: { a: 1 } })).status, 403, "an existing collection is not adopted");
    assertEquals((await open("GET", "/classes/Secret", { token: carl.body.sessionToken })).status, 403);
  } finally {
    await client.db(appId).dropDatabase().catch(() => {});
    await client.db(`${appId}b`).dropDatabase().catch(() => {});
    await client.close();
    await ea.stop();
  }
}});
