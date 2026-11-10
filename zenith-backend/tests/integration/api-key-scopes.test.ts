/**
 * API key scopes are enforced (before 2026-11-10 any valid key had full user access: a read-only
 * `pk_` could write). On MongoDB, over HTTP, as a client would call:
 * - each /classes operation needs its scope (data:read, create, write, delete; users:* for _User);
 * - /batch checks every operation;
 * - a user route that declares no scope does not accept API keys at all.
 *
 *   ZENITH_TEST_MONGO=mongodb://127.0.0.1:27999
 */
import { assert, assertEquals } from "@std/assert";
import { createZenithApp } from "../../src/mod.ts";

const MONGO = Deno.env.get("ZENITH_TEST_MONGO");

Deno.test({ name: "api key scopes: enforced per operation, batch included, fail closed", ignore: !MONGO, sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const { MongoClient } = await import("mongodb");
  const client = await new MongoClient(MONGO!).connect();
  const appId = `scopes${Date.now()}`;
  const master = crypto.randomUUID() + crypto.randomUUID();
  try {
    const { handler } = await createZenithApp({
      appId, masterKey: master, serverURL: "http://localhost:1", port: 1,
      databaseURI: `${MONGO}/${appId}?directConnection=true`, features: {},
    } as any);
    const call = async (method: string, path: string, o: { body?: unknown; master?: boolean; key?: string } = {}) => {
      const headers: Record<string, string> = { "X-Parse-Application-Id": appId, "content-type": "application/json" };
      if (o.master) headers["X-Parse-Master-Key"] = master;
      if (o.key) headers["Authorization"] = `Bearer ${o.key}`;
      const req = new Request(`http://zenith.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      (req as any).__socketAddr = { hostname: o.master ? "127.0.0.1" : "198.51.100.61" };
      const r = await handler!(req);
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const ACL = { "*": { read: true, write: true } }; // without a session the CRUD requires an explicit ACL (ADR-014)
    const keyOf = async (prefix: string, scopes?: string[]) => {
      const r = await call("POST", "/zen/api-keys", { master: true, body: { name: `k-${prefix}`, prefix, env: "test", ...(scopes ? { scopes } : {}) } });
      assertEquals(r.status, 201, JSON.stringify(r.body));
      return r.body.key as string;
    };

    assertEquals((await call("POST", "/schemas/Todo", { master: true, body: { fields: { title: { type: "String" } } } })).status, 200);
    const sk = await keyOf("sk");                   // defaults: data read/create/write/delete
    const pk = await keyOf("pk");                   // defaults: read only
    const rk = await keyOf("rk");                   // defaults: analytics:read
    const createOnly = await keyOf("sk", ["data:create"]);

    // sk: everything on data.
    const made = await call("POST", "/classes/Todo", { key: sk, body: { title: "a", ACL } });
    assertEquals(made.status, 201, JSON.stringify(made.body));
    const id = made.body.objectId as string;
    assertEquals((await call("PUT", `/classes/Todo/${id}`, { key: sk, body: { title: "b" } })).status, 200);

    // pk: reads, never writes.
    assertEquals((await call("GET", "/classes/Todo", { key: pk })).status, 200);
    assertEquals((await call("GET", `/classes/Todo/${id}`, { key: pk })).status, 200);
    for (const [method, path, body] of [["POST", "/classes/Todo", { title: "x", ACL }], ["PUT", `/classes/Todo/${id}`, { title: "x" }], ["DELETE", `/classes/Todo/${id}`, undefined]] as const) {
      const r = await call(method, path, { key: pk, body });
      assertEquals(r.status, 403, `pk ${method} ${path}`);
      assertEquals(r.body.code, 119);
      assert(String(r.body.error).includes("data:"), r.body.error);
    }
    assertEquals((await call("POST", `/classes/Todo/${id}/Increment`, { key: pk, body: { n: 1 } })).status, 403, "increment is a write");

    // _User is governed by users:* scopes, not data:*.
    assertEquals((await call("POST", "/classes/_User", { key: createOnly, body: { username: "u", password: "p", ACL } })).status, 403);

    // rk (analytics only): no data at all.
    assertEquals((await call("GET", "/classes/Todo", { key: rk })).status, 403);

    // Granular: create but not delete.
    assertEquals((await call("POST", "/classes/Todo", { key: createOnly, body: { title: "c", ACL } })).status, 201);
    assertEquals((await call("DELETE", `/classes/Todo/${id}`, { key: createOnly })).status, 403);

    // Batch: each operation on its own.
    const batch = await call("POST", "/batch", { key: pk, body: { requests: [
      { method: "GET", path: `/classes/Todo/${id}` },
      { method: "POST", path: "/classes/Todo", body: { title: "sneaky", ACL } },
    ] } });
    assertEquals(batch.status, 200);
    assert(batch.body[0].success, JSON.stringify(batch.body[0]));
    assertEquals(batch.body[1].error?.code, 119, JSON.stringify(batch.body[1]));
    const all = (await call("GET", "/classes/Todo", { master: true })).body.results as { title: string }[];
    assert(!all.some((t) => t.title === "sneaky"), "the batch write with a read-only key did not happen");

    // Still deletable with the right scope.
    assertEquals((await call("DELETE", `/classes/Todo/${id}`, { key: sk })).status, 200);
  } finally {
    await client.db("zenith_api_keys").collection("api_keys").deleteMany({ appId });
    await client.db(appId).dropDatabase().catch(() => {});
    await client.close();
  }
}});
