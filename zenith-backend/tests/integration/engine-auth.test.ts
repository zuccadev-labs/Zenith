/**
 * Parse users and sessions on top of the real engine-auth: its binary, its FFI library
 * (`libzutool_auth`) and plain HTTP, like production. Two facades share one database to stand for
 * two Zenith instances behind a balancer.
 *
 *   ENGINE_AUTH_BIN=…/target/debug/engine-auth ZUTOOL_LIB_DIR=…/target/debug \
 *     deno test -A --no-check tests/integration/engine-auth.test.ts
 *
 * Without both variables the tests are skipped. With `ZENITH_TEST_MONGO=mongodb://host:port` they run
 * on MongoDB through Zenith's own adapter (a fresh database per test) instead of in memory.
 */
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { composeTraitDescriptors, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { UserManagementTrait } from "../../src/traits/auth/user.trait.ts";
import { type AuthCrud, EngineAuthFacade } from "../../src/traits/auth/engine-auth.ts";
import { buildDynamicRouter } from "../../src/core/router.ts";
import {
  createRequestHandler,
  extractContext,
  resolveAuthentication,
} from "../../src/core/pipeline.ts";
import {
  createMongoAdapter,
  DatabaseMongoTrait,
} from "../../src/adapters/database/mongo.adapter.ts";
import { MongoClient } from "mongodb";
import { ZenCloud } from "../../src/core/cloud.ts";

import { AUD, BIN, EngineAuth, LIB_DIR, PASSWORD } from "./_engine_auth_lab.ts";

const MONGO = Deno.env.get("ZENITH_TEST_MONGO");
const ignore = !BIN || !LIB_DIR;
const SESSION_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

// ─── A database with the semantics the facade relies on ─────────────────────

function memoryDb() {
  const cols = new Map<string, Map<string, Record<string, any>>>();
  const col = (c: string) => cols.get(c) ?? cols.set(c, new Map()).get(c)!;
  const matches = (doc: Record<string, any>, where: Record<string, any> = {}) =>
    Object.entries(where).every(([k, v]) => {
      const have = k === "objectId" ? doc.objectId : doc[k];
      if (v && typeof v === "object" && "$lt" in v) return typeof have === "number" && have < v.$lt;
      return have === v;
    });
  let n = 0;
  const db: AuthCrud & { cols: typeof cols; calls: { updateIf: number } } = {
    cols,
    calls: { updateIf: 0 },
    find: async (c, q) =>
      [...col(c).values()].filter((d) => matches(d, q.where)).map((d) => structuredClone(d)),
    findOne: async (c, q) => {
      const d = [...col(c).values()].find((d) => matches(d, q.where));
      return d ? structuredClone(d) : null;
    },
    insert: async (c, data) => {
      const id = (data.objectId as string) ?? `o${++n}`;
      if (col(c).has(id)) throw new Error("E11000 duplicate key");
      col(c).set(id, { ...structuredClone(data), objectId: id });
      return { ...data, objectId: id };
    },
    update: async (c, id, data) => {
      const d = col(c).get(id);
      if (d) Object.assign(d, structuredClone(data));
      return d;
    },
    // Atomic like Mongo's updateOne with a filter: check and write in one synchronous step.
    updateIf: async (c, id, cond, data) => {
      db.calls.updateIf++;
      const d = col(c).get(id);
      if (!d || !matches(d, cond)) return null;
      Object.assign(d, structuredClone(data));
      return d;
    },
    delete: async (c, id) => void col(c).delete(id),
  };
  return db;
}

/** What the tests need besides the CRUD itself: look inside `_User`/`_Session`, age tokens. */
interface TestDb {
  crud: AuthCrud;
  user(id: string): Promise<Record<string, any> | null>;
  sessions(): Promise<Record<string, any>[]>;
  expireAccess(): Promise<void>;
  close(): Promise<void>;
}

let dbn = 0;
const opened: TestDb[] = [];
const closeAll = async () => {
  for (const d of opened.splice(0)) await d.close();
};
async function testDb(): Promise<TestDb> {
  const d = await openTestDb();
  opened.push(d);
  return d;
}
async function openTestDb(): Promise<TestDb> {
  if (!MONGO) {
    const m = memoryDb();
    return {
      crud: m,
      user: async (id) => m.cols.get("_User")?.get(id) ?? null,
      sessions: async () => [...(m.cols.get("_Session")?.values() ?? [])],
      expireAccess: async () => {
        for (const s of m.cols.get("_Session")?.values() ?? []) s.accessExp = 0;
      },
      close: async () => {},
    };
  }
  // Zenith's real adapter, reached the way the facade reaches it: the trait's `database-crud`.
  const client = await new MongoClient(MONGO).connect();
  const db = client.db(`zenith_ea_${Deno.pid}_${++dbn}`);
  const traits = composeTraitDescriptors([DatabaseMongoTrait] as any).traits as Record<string, any>;
  traits.injectMongoPlugin(createMongoAdapter(db));
  const crud = traits["database-crud"] as AuthCrud;
  const strip = ({ _id, ...d }: Record<string, any>) => ({ objectId: String(_id), ...d });
  return {
    crud,
    user: async (id) => {
      const d = await db.collection("_User").findOne({ _id: id as any });
      return d ? strip(d) : null;
    },
    sessions: async () => (await db.collection("_Session").find().toArray()).map(strip),
    expireAccess: async () =>
      void (await db.collection("_Session").updateMany({}, { $set: { accessExp: 0 } })),
    close: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}

// ─── A Zenith instance: composed trait + the real pipeline ───────────────────

function zenith(ea: EngineAuth, db: AuthCrud, configure = true) {
  const MemDb = createTraitDescriptor({
    name: "MemDb",
    provides: ["database-crud"],
    consumes: [],
    state: [],
    runtimes: ["deno"],
    summary: "test db",
    create: () => ({ "database-crud": db }),
  });
  const composed = composeTraitDescriptors([MemDb, UserManagementTrait] as any).traits as Record<
    string,
    any
  >;
  if (configure) {
    composed["user-manager"].configure({
      issuer: ea.url,
      clientId: "zenith",
      audience: AUD,
      sessionKey: SESSION_KEY,
      libDir: LIB_DIR,
    });
  }
  const whoami = [{
    access: "public",
    method: "GET",
    path: "/whoami",
    handler: async (_r: Request, ctx: any) => Response.json(ctx.auth ?? null),
  }];
  const router = buildDynamicRouter({ ...composed, "probe-routes": whoami });
  const handle = createRequestHandler([
    extractContext({ configMasterKey: "m" }),
    resolveAuthentication(composed.authentication),
  ], router.dispatch());
  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown; token?: string; bearer?: string; ip?: string } = {},
  ) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers["x-parse-session-token"] = opts.token;
    if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
    const req = new Request(`http://zenith.test${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    (req as any).__socketAddr = { hostname: opts.ip ?? "198.51.100.20" };
    const r = await handle(req);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, composed };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test({
  name: "engine-auth facade: sign up, log in, /users/me and ctx.auth like Parse",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ea = await EngineAuth.start();
    try {
      const t = await testDb();
      const db = t.crud;
      const z = zenith(ea, db);

      const su = await z.call("POST", "/users", {
        body: {
          username: "leo",
          email: "Leo@Example.test",
          password: PASSWORD,
          emailVerified: true,
          color: "verde",
        },
      });
      assertEquals(su.status, 201, JSON.stringify(su.body));
      assertMatch(su.body.sessionToken, /^r:[0-9a-f]{64}$/);
      const profile = (await t.user(su.body.objectId))!;
      assertEquals([profile.username, profile.email, profile.emailVerified, profile.color], [
        "leo",
        "leo@example.test",
        false,
        "verde",
      ], "a client cannot mark itself verified");

      const session = (await t.sessions())[0];
      assert(!JSON.stringify(session).includes("zrt_"), "the refresh token is stored sealed");
      assertNotEquals(
        session.tokenHash,
        su.body.sessionToken,
        "only the hash of the session token is stored",
      );

      const li = await z.call("POST", "/login", { body: { username: "LEO", password: PASSWORD } });
      assertEquals(li.status, 200, JSON.stringify(li.body));
      assertEquals([li.body.objectId, li.body.username], [su.body.objectId, "leo"]);
      assertEquals(
        (await z.call("POST", "/login", {
          body: { email: "leo@example.test", password: PASSWORD },
        })).status,
        200,
      );

      const bad = await z.call("POST", "/login", {
        body: { username: "leo", password: "no es esta" },
      });
      assertEquals([bad.status, bad.body.code], [404, 101]);
      assertEquals(
        (await z.call("GET", "/login?username=leo&password=x")).status,
        405,
        "no credentials in URLs",
      );

      const me = await z.call("GET", "/users/me", { token: li.body.sessionToken });
      assertEquals([me.status, me.body.objectId, me.body.sessionToken], [
        200,
        su.body.objectId,
        li.body.sessionToken,
      ]);
      // Parse's GET /sessions/me: the session in Parse's shape, never its sealed refresh token.
      const sess = await z.call("GET", "/sessions/me", { token: li.body.sessionToken });
      assertEquals(sess.status, 200, JSON.stringify(sess.body));
      assertEquals([sess.body.sessionToken, sess.body.user.objectId, sess.body.expiresAt.__type], [
        li.body.sessionToken,
        su.body.objectId,
        "Date",
      ]);
      for (const k of ["refresh", "tokenHash", "leaseUntil", "sub"]) {
        assertEquals(sess.body[k], undefined, k);
      }
      assertEquals(
        (await z.call("GET", "/sessions/me", { token: "r:" + "0".repeat(64) })).body.code,
        209,
      );
      const who = await z.call("GET", "/whoami", { token: li.body.sessionToken });
      assertEquals([who.body.userId, who.body.via], [su.body.objectId, "session"]);
      assertEquals(
        (await z.call("GET", "/whoami", { token: "r:" + "0".repeat(64) })).body,
        null,
        "unknown handle: anonymous",
      );
      assertEquals(
        (await z.call("GET", "/users/me", { token: "r:" + "0".repeat(64) })).body.code,
        209,
      );

      const dup = await z.call("POST", "/users", {
        body: { username: "otro", email: "leo@example.test", password: PASSWORD },
      });
      assertEquals([dup.status, dup.body.code], [400, 202]);
      const weak = await z.call("POST", "/users", {
        body: { username: "ana", email: "ana@example.test", password: "corta" },
      });
      assertEquals([weak.status, weak.body.code], [400, 142]);
      assertEquals(
        (await z.call("POST", "/users", { body: { username: "ana", password: PASSWORD } })).body
          .code,
        204,
      );
    } finally {
      await ea.stop();
      await closeAll();
    }
  },
});

Deno.test({
  name: "engine-auth facade: Zen.Cloud login and logout triggers run, and beforeLogin can refuse",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ea = await EngineAuth.start();
    const seen: string[] = [];
    try {
      ZenCloud.beforeLogin((r) => {
        seen.push(`beforeLogin:${r.object.username}`);
        if (r.object.username === "blocked") throw new Error("This account is suspended.");
      });
      ZenCloud.afterLogin((r) => void seen.push(`afterLogin:${r.object.username}`));
      ZenCloud.beforeLogout((r) =>
        void seen.push(`beforeLogout:${r.user?.objectId ? "user" : "?"}`)
      );
      ZenCloud.afterLogout(() => {
        seen.push("afterLogout");
        throw new Error("a failing afterLogout does not undo the logout");
      });
      const t = await testDb();
      const z = zenith(ea, t.crud);
      for (const username of ["okay", "blocked"]) {
        const su = await z.call("POST", "/users", {
          body: { username, email: `${username}@example.test`, password: PASSWORD },
        });
        assertEquals(su.status, 201, JSON.stringify(su.body));
      }
      const before = (await t.sessions()).length;

      const refused = await z.call("POST", "/login", {
        body: { username: "blocked", password: PASSWORD },
      });
      assertEquals([refused.status, refused.body], [400, {
        code: 142,
        error: "This account is suspended.",
      }]);
      assertEquals((await t.sessions()).length, before, "no Zenith session for a refused login");

      const li = await z.call("POST", "/login", { body: { username: "okay", password: PASSWORD } });
      assertEquals(li.status, 200, JSON.stringify(li.body));
      const out = await z.call("POST", "/logout", { token: li.body.sessionToken });
      assertEquals(out.status, 200);
      const after = await z.call("GET", "/users/me", { token: li.body.sessionToken });
      assertNotEquals(after.status, 200, "the session ended despite the failing afterLogout");
      assertEquals(seen, [
        "beforeLogin:blocked",
        "beforeLogin:okay",
        "afterLogin:okay",
        "beforeLogout:user",
        "afterLogout",
      ]);
    } finally {
      // The registry is process-wide: leave no hooks behind for the other tests.
      for (const hook of ["beforeLogin", "afterLogin", "beforeLogout", "afterLogout"] as const) {
        ZenCloud[hook](() => {});
      }
      await closeAll();
      await ea.stop();
    }
  },
});

Deno.test({
  name:
    "engine-auth facade: access tokens from other services are verified by FFI, audience enforced",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ea = await EngineAuth.start();
    try {
      await ea.cli(["user", "add", "ana@example.test"], `${PASSWORD}\n`);
      const t = await testDb();
      const z = zenith(ea, t.crud);
      const login = async (audience: string) =>
        (await (await fetch(`${ea.url}/api/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: "zenith",
            login: "ana@example.test",
            password: PASSWORD,
            audience: [audience],
          }),
        })).json()).access_token as string;

      const who = await z.call("GET", "/whoami", { bearer: await login(AUD) });
      assertEquals([who.body.via, who.body.clientId], ["bearer", "zenith"]);
      assertMatch(who.body.userId, /^[0-9a-f-]{36}$/);
      assertEquals(
        (await z.call("GET", "/whoami", { bearer: await login("https://otro.example.test") })).body,
        null,
        "a token for another service is not accepted",
      );

      // A key rotated in engine-auth: the new token is accepted after one JWKS refetch.
      const rot = await ea.cli(["keys", "rotate", "EdDSA"]);
      assert(rot.ok, JSON.stringify(rot.out));
      await new Promise((r) => setTimeout(r, 31_000)); // the facade refetches at most every 30 s; engine-auth reloads keys every 30 s
      const after = await z.call("GET", "/whoami", { bearer: await login(AUD) });
      assertEquals(after.body?.via, "bearer", "rotation is picked up");
    } finally {
      await ea.stop();
      await closeAll();
    }
  },
});

Deno.test({
  name:
    "engine-auth facade: two instances refresh one session once (lease), logout and disable end it",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ea = await EngineAuth.start();
    try {
      await ea.cli(["user", "add", "ana@example.test", "--username", "ana"], `${PASSWORD}\n`);
      const tdb = await testDb();
      const db = tdb.crud;
      const a = zenith(ea, db), b = zenith(ea, db);
      const t =
        (await a.call("POST", "/login", { body: { username: "ana", password: PASSWORD } })).body
          .sessionToken;

      // Expired access token, the same session on both instances at the same moment, several times.
      for (let round = 0; round < 3; round++) {
        await tdb.expireAccess();
        const r = await Promise.all([
          a.call("GET", "/whoami", { token: t }),
          b.call("GET", "/whoami", { token: t }),
          a.call("GET", "/whoami", { token: t }),
          b.call("GET", "/whoami", { token: t }),
        ]);
        for (const x of r) {
          assertEquals(x.body?.via, "session", `round ${round}: every request is authenticated`);
        }
      }
      assertEquals(
        (await tdb.sessions()).length,
        1,
        "the session survived: engine-auth never saw a reused refresh token",
      );

      // Logout on A ends it everywhere, including engine-auth.
      await a.call("POST", "/logout", { token: t });
      assertEquals(
        (await a.call("GET", "/whoami", { token: t })).body,
        null,
        "at once on the instance that logged out",
      );
      await new Promise((r) => setTimeout(r, 5_100));
      assertEquals(
        (await b.call("GET", "/whoami", { token: t })).body,
        null,
        "within the 5 s cache on the others",
      );
      assertEquals((await tdb.sessions()).length, 0);

      // An account disabled in engine-auth stops at the next refresh, and its session is removed.
      const t2 =
        (await a.call("POST", "/login", { body: { username: "ana", password: PASSWORD } })).body
          .sessionToken;
      assertEquals((await a.call("GET", "/whoami", { token: t2 })).body?.via, "session");
      assert((await ea.cli(["user", "disable", "ana@example.test"])).ok);
      await tdb.expireAccess();
      await new Promise((r) => setTimeout(r, 5_100));
      assertEquals((await b.call("GET", "/whoami", { token: t2 })).body, null);
      assertEquals((await tdb.sessions()).length, 0);
    } finally {
      await ea.stop();
      await closeAll();
    }
  },
});

Deno.test({
  name:
    "engine-auth facade: engine-auth down denies without deleting; failures limit the user, not Zenith",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ea = await EngineAuth.start();
    try {
      await ea.cli(["user", "add", "ana@example.test"], `${PASSWORD}\n`);
      await ea.cli(["user", "add", "eva@example.test"], `${PASSWORD}\n`);
      const tdb = await testDb();
      const db = tdb.crud;
      const z = zenith(ea, db);
      // Ten failures from one address; another user of the same Zenith is not locked out.
      for (let i = 0; i < 10; i++) {
        await z.call("POST", "/login", {
          body: { email: `x${i}@example.test`, password: "mal" },
          ip: "203.0.113.9",
        });
      }
      assertEquals(
        (await z.call("POST", "/login", {
          body: { email: "eva@example.test", password: PASSWORD },
          ip: "203.0.113.9",
        })).status,
        429,
      );
      const t = (await z.call("POST", "/login", {
        body: { email: "ana@example.test", password: PASSWORD },
        ip: "198.51.100.7",
      })).body.sessionToken;
      assertMatch(t, /^r:/);

      // Unreachable engine-auth: the refresh fails closed but the session is kept for later.
      const down = new EngineAuthFacade(
        {
          issuer: ea.url,
          url: "http://127.0.0.1:9",
          clientId: "zenith",
          audience: AUD,
          sessionKey: SESSION_KEY,
          libDir: LIB_DIR,
        },
        db,
        { log: () => {} },
      );
      await tdb.expireAccess();
      assertEquals(await down.verifySession(t), null);
      const left = await tdb.sessions();
      assertEquals(left.length, 1);
      assertEquals(left[0].leaseUntil, 0, "the lease is released");
      assertEquals(
        (await z.call("GET", "/whoami", { token: t })).body?.via,
        "session",
        "back to normal once engine-auth answers",
      );
    } finally {
      await ea.stop();
      await closeAll();
    }
  },
});

Deno.test({
  name:
    "engine-auth facade: not configured means 503 and anonymous, bad configuration refuses to start",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ea = await EngineAuth.start();
    try {
      const db = (await testDb()).crud;
      const z = zenith(ea, db, false);
      assertEquals(
        (await z.call("POST", "/login", { body: { username: "a", password: "b" } })).status,
        503,
      );
      const base = {
        issuer: ea.url,
        clientId: "zenith",
        audience: AUD,
        sessionKey: SESSION_KEY,
        libDir: LIB_DIR,
      };
      const refuses = (cfg: any, crud: any = db) => {
        try {
          new EngineAuthFacade(cfg, crud);
          return false;
        } catch {
          return true;
        }
      };
      assert(refuses({ ...base, sessionKey: "corta" }), "short key");
      assert(refuses({ ...base, audience: "" }), "no audience");
      assert(
        refuses(base, { ...db, updateIf: undefined }),
        "no conditional updates: no safe refresh",
      );
      assert(!refuses(base));
    } finally {
      await ea.stop();
      await closeAll();
    }
  },
});
