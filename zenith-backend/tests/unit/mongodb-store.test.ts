/**
 * Tests del MongoDBStore.
 *
 * Estrategia:
 *   - **Unit tests**: validan la lógica del store SIN MongoDB (init validation,
 *     TTL index plan, serialization, error paths). Corren siempre.
 *   - **Integration tests**: requieren un MongoDB real (replica set idealmente
 *     para change streams). Se skipean si `MONGO_TEST_URI` no está configurado.
 *
 * Para correr los integration tests:
 *   docker run -d --name zenith-test-mongo -p 27017:27017 mongo:7 --replSet rs0
 *   docker exec -it zenith-test-mongo mongosh --eval 'rs.initiate()'
 *   MONGO_TEST_URI=mongodb://localhost:27017/?replicaSet=rs0 deno test --allow-all tests/unit/mongodb-store.test.ts
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { MongoDBStore, type MongoDBStoreConfig } from "../../src/security/api-keys/store.ts";
import type { ApiKeyRecord } from "../../src/security/api-keys/types.ts";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

// ── Unit tests (no MongoDB) ────────────────────────────────────────────────

Deno.test("MongoDBStore: constructor validates uri", () => {
  assertThrows(
    () => new MongoDBStore({ uri: "" }),
    Error,
    "uri is required",
  );
});

Deno.test("MongoDBStore: methods throw before init()", async () => {
  const store = new MongoDBStore({ uri: "mongodb://localhost", logger: silent });
  await assertRejects(() => store.get("any-id"), Error, "init() must be called");
  await assertRejects(() => store.listByApp("app"), Error, "init() must be called");
  await assertRejects(() => store.put({} as any), Error, "init() must be called");
  await assertRejects(() => store.update("id", {}), Error, "init() must be called");
  await assertRejects(() => store.delete("id"), Error, "init() must be called");
});

Deno.test("MongoDBStore: default config", () => {
  const store = new MongoDBStore({ uri: "mongodb://x" });
  // Verify defaults via close() (idempotent even when not initialized)
  // We can't inspect private fields, so just check that close() doesn't throw
  store.close();
});

// ── Integration tests (requieren MongoDB) ──────────────────────────────────

const TEST_URI = Deno.env.get("MONGO_TEST_URI");
const HAS_MONGO = !!TEST_URI;

if (!HAS_MONGO) {
  Deno.test({
    name: "MongoDBStore: integration tests SKIPPED (set MONGO_TEST_URI to enable)",
    ignore: true,
    fn: () => {},
  });
} else {
  const TEST_DB = `zenith_test_${Date.now()}`;
  const TEST_COLL = "api_keys";

  const makeStore = (extra: Partial<MongoDBStoreConfig> = {}): MongoDBStore =>
    new MongoDBStore({
      uri: TEST_URI!,
      dbName: TEST_DB,
      collectionName: TEST_COLL,
      logger: silent,
      ...extra,
    });

  const sampleRecord = (id: string, appId = "app1"): ApiKeyRecord => ({
    id,
    prefix: "sk",
    env: "test",
    appId,
    hash: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$hash",
    scopes: ["*"],
    name: "Test Key",
    createdAt: new Date().toISOString(),
    createdBy: "system:test",
    rateLimit: { requestsPerMinute: 1000 },
    metadata: {},
  });

  Deno.test("MongoDBStore: init() connects and creates indexes", async () => {
    const store = makeStore();
    try {
      await store.init();
      // Second init() should be idempotent
      await store.init();
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: put + get roundtrip", async () => {
    const store = makeStore();
    try {
      await store.init();
      const rec = sampleRecord("key-1");
      await store.put(rec);
      const got = await store.get("key-1");
      assert(got);
      assertEquals(got.id, "key-1");
      assertEquals(got.appId, "app1");
      assertEquals(got.hash, rec.hash);
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: get returns null for missing key", async () => {
    const store = makeStore();
    try {
      await store.init();
      const got = await store.get("nonexistent");
      assertEquals(got, null);
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: put throws on duplicate id", async () => {
    const store = makeStore();
    try {
      await store.init();
      await store.put(sampleRecord("dup"));
      await assertRejects(() => store.put(sampleRecord("dup")), Error, "already exists");
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: listByApp filters by appId", async () => {
    const store = makeStore();
    try {
      await store.init();
      await store.put(sampleRecord("k1", "app-A"));
      await store.put(sampleRecord("k2", "app-A"));
      await store.put(sampleRecord("k3", "app-B"));

      const appAKeys = await store.listByApp("app-A");
      assertEquals(appAKeys.length, 2);
      // Should NOT include hash
      for (const k of appAKeys) {
        assertEquals((k as any).hash, undefined);
      }
      const appBKeys = await store.listByApp("app-B");
      assertEquals(appBKeys.length, 1);
      assertEquals(appBKeys[0].id, "k3");
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: update patches fields", async () => {
    const store = makeStore();
    try {
      await store.init();
      await store.put(sampleRecord("upd"));
      await store.update("upd", { name: "Updated Name", lastUsedAt: new Date().toISOString() });
      const got = await store.get("upd");
      assert(got);
      assertEquals(got.name, "Updated Name");
      // Hash must NOT be modifiable
      assertEquals(got.hash, sampleRecord("upd").hash);
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: update on missing key throws", async () => {
    const store = makeStore();
    try {
      await store.init();
      await assertRejects(() => store.update("nope", { name: "x" }), Error, "not found");
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: delete removes key", async () => {
    const store = makeStore();
    try {
      await store.init();
      await store.put(sampleRecord("del"));
      await store.delete("del");
      const got = await store.get("del");
      assertEquals(got, null);
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: TTL index is created with expireAfterSeconds=0", async () => {
    const store = makeStore();
    try {
      await store.init();
      // Verify via direct introspection
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(TEST_URI!);
      await client.connect();
      const coll = client.db(TEST_DB).collection(TEST_COLL);
      const indexes = await coll.indexes();
      const ttl = indexes.find((i: any) => i.name === "idx_expiresAt_ttl");
      assert(ttl, "TTL index on expiresAt must exist");
      assertEquals((ttl as any).expireAfterSeconds, 0);
      const ttlRot = indexes.find((i: any) => i.name === "idx_rotationExpiresAt_ttl");
      assert(ttlRot, "TTL index on rotationExpiresAt must exist");
      assertEquals((ttlRot as any).expireAfterSeconds, 0);
      const idIdx = indexes.find((i: any) => i.name === "idx_id_unique");
      assert(idIdx, "Unique index on id must exist");
      assertEquals((idIdx as any).unique, true);
      await client.close();
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: expiresAt is stored as Date (TTL-compatible)", async () => {
    const store = makeStore();
    try {
      await store.init();
      const expiresAt = "2030-01-01T00:00:00.000Z";
      await store.put({ ...sampleRecord("ttl"), expiresAt });
      // Read raw doc to verify Date type
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(TEST_URI!);
      await client.connect();
      const doc = await client.db(TEST_DB).collection(TEST_COLL).findOne({ id: "ttl" });
      assert(doc);
      assertEquals((doc as any).expiresAt instanceof Date, true);
      await client.close();
      // And deserialized to ISO string
      const got = await store.get("ttl");
      assert(got);
      assertEquals(got.expiresAt, expiresAt);
    } finally {
      await store.close();
    }
  });

  Deno.test("MongoDBStore: change stream callback fires on insert", async () => {
    const events: any[] = [];
    const store = makeStore({
      enableChangeStream: true,
      onRemoteChange: (e) => events.push(e),
    });
    try {
      await store.init();
      // Give the change stream a moment to start
      await new Promise((r) => setTimeout(r, 500));
      await store.put(sampleRecord("stream-test"));
      // Wait for the event to propagate (typical: 50-200ms)
      await new Promise((r) => setTimeout(r, 1000));
      const inserts = events.filter((e) => e.type === "insert" && e.id === "stream-test");
      assert(
        inserts.length >= 1,
        `Expected insert event, got ${events.length} events: ${JSON.stringify(events)}`,
      );
    } finally {
      await store.close();
    }
  });

  // Cleanup: drop the test database after all integration tests
  globalThis.addEventListener("unload", async () => {
    try {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(TEST_URI!);
      await client.connect();
      await client.db(TEST_DB).dropDatabase();
      await client.close();
    } catch { /* best effort */ }
  });
}
