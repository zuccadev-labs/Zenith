/**
 * Tests para core/router.ts — ZenithRouter + dynamic router builder.
 *
 * Cubre:
 *   - get/post/put/delete registration
 *   - dispatch finds correct route
 *   - 404 when no match
 *   - URL aliases (/roles → /classes/_Role, /users → /classes/_User)
 *   - Method mismatch returns 404
 *   - buildDynamicRouter: auto-mounts `*_routes` from traits
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildDynamicRouter, healthHandler, ZenithRouter } from "../../src/core/router.ts";
import { assertThrows } from "@std/assert";
import type { RouteHandler } from "../../src/core/pipeline.ts";
import type { ZenithRequestContext } from "../../src/core/types.ts";

// Routing tests run as the master key; access rules have their own tests at the end.
const emptyCtx: ZenithRequestContext = { masterKey: true } as any;

// ─── Health handler ──────────────────────────────────────────────────────────

Deno.test("healthHandler - returns ok status", async () => {
  const res = await healthHandler(new Request("http://x/health"), emptyCtx);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.runtime, "deno");
  assertEquals(body.name, "Zenith");
});

// ─── Route registration ──────────────────────────────────────────────────────

Deno.test("ZenithRouter.get - registers GET route", async () => {
  const router = new ZenithRouter();
  router.get("/ping", () => new Response("pong"));
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/ping"), emptyCtx);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "pong");
});

Deno.test("ZenithRouter.post - registers POST route", async () => {
  const router = new ZenithRouter();
  router.post("/echo", async (req) => new Response(await req.text()));
  const dispatch = router.dispatch();
  const res = await dispatch(
    new Request("http://x/echo", { method: "POST", body: "hello" }),
    emptyCtx,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "hello");
});

Deno.test("ZenithRouter.put / delete - register routes", async () => {
  const router = new ZenithRouter();
  router.put("/x", () => new Response("put"));
  router.delete("/x", () => new Response("del"));
  const dispatch = router.dispatch();

  const putRes = await dispatch(new Request("http://x/x", { method: "PUT" }), emptyCtx);
  assertEquals(await putRes.text(), "put");

  const delRes = await dispatch(new Request("http://x/x", { method: "DELETE" }), emptyCtx);
  assertEquals(await delRes.text(), "del");
});

Deno.test("ZenithRouter - fluent API returns this", () => {
  const router = new ZenithRouter();
  const result = router.get("/a", () => new Response(""));
  assertEquals(result, router);
});

// ─── URL pattern params ──────────────────────────────────────────────────────

Deno.test("ZenithRouter - path params are injected into context", async () => {
  const router = new ZenithRouter();
  router.get("/items/:id", (_req, ctx) => {
    const id = (ctx as any).params?.id;
    return new Response(`item=${id}`);
  });
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/items/abc123"), emptyCtx);
  assertEquals(await res.text(), "item=abc123");
});

// ─── 404 / method mismatch ───────────────────────────────────────────────────

Deno.test("ZenithRouter - returns 404 when no route matches", async () => {
  const router = new ZenithRouter();
  router.get("/known", () => new Response("ok"));
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/unknown"), emptyCtx);
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.code, 141);
  assertStringIncludes(body.error, "Route not found");
});

Deno.test("ZenithRouter - method mismatch returns 404", async () => {
  const router = new ZenithRouter();
  router.get("/x", () => new Response("ok"));
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/x", { method: "POST" }), emptyCtx);
  assertEquals(res.status, 404);
});

// ─── URL aliases for Parse-Server parity ─────────────────────────────────────

Deno.test("ZenithRouter - /roles is aliased to /classes/_Role", async () => {
  const router = new ZenithRouter();
  router.get("/classes/_Role", () => new Response("role"));
  const dispatch = router.dispatch();
  // No :id in pattern; /roles → /classes/_Role (exact match)
  const res = await dispatch(new Request("http://x/roles"), emptyCtx);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "role");
});

Deno.test("ZenithRouter - /users is aliased to /classes/_User (except /users and /users/me)", async () => {
  const router = new ZenithRouter();
  router.get("/classes/_User", () => new Response("user"));
  const dispatch = router.dispatch();
  // /users (no trailing id) → /classes/_User exact match
  const res = await dispatch(new Request("http://x/users"), emptyCtx);
  assertEquals(await res.text(), "user");
});

Deno.test("ZenithRouter - /installations is aliased to /classes/_Installation", async () => {
  const router = new ZenithRouter();
  router.get("/classes/_Installation", () => new Response("inst"));
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/installations"), emptyCtx);
  assertEquals(await res.text(), "inst");
});

Deno.test("ZenithRouter - /users/me is NOT aliased (handled separately)", async () => {
  const router = new ZenithRouter();
  router.get("/users/me", () => new Response("me-endpoint"));
  router.get("/classes/_User", () => new Response("user-class"));
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/users/me"), emptyCtx);
  assertEquals(await res.text(), "me-endpoint");
});

// ─── buildDynamicRouter ──────────────────────────────────────────────────────

Deno.test("buildDynamicRouter - mounts /health by default", async () => {
  const router = buildDynamicRouter({});
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/health"), emptyCtx);
  assertEquals(res.status, 200);
});

Deno.test("buildDynamicRouter - mounts routes from *_routes capability", async () => {
  const routes = [{
    method: "GET" as const,
    path: "/capability1/test",
    handler: () => new Response("cap1") as any,
  }];
  const router = buildDynamicRouter({
    traits: { cap1_routes: routes },
  });
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/capability1/test"), emptyCtx);
  assertEquals(await res.text(), "cap1");
});

Deno.test("buildDynamicRouter - mounts routes from deps without traits key", async () => {
  const routes = [{
    method: "POST" as const,
    path: "/no-traits-key",
    handler: () => new Response("ok") as any,
  }];
  const router = buildDynamicRouter({ foo_routes: routes });
  const dispatch = router.dispatch();
  const res = await dispatch(
    new Request("http://x/no-traits-key", { method: "POST" }),
    emptyCtx,
  );
  assertEquals(await res.text(), "ok");
});

Deno.test("buildDynamicRouter - skips non-route entries", async () => {
  const router = buildDynamicRouter({
    traits: {
      meta_routes: "not-an-array",
      someOther: [{ unrelated: true }],
    },
  });
  const dispatch = router.dispatch();
  const res = await dispatch(new Request("http://x/health"), emptyCtx);
  assertEquals(res.status, 200);
});

// ─── Access (deny by default) ────────────────────────────────────────────────

const anon = {} as ZenithRequestContext;
const user = { auth: { userId: "u1", roles: [] } } as unknown as ZenithRequestContext;
const apiKey = (scopes: string[]) => ({ apiKey: { scopes } }) as unknown as ZenithRequestContext;

Deno.test("access - a route that does not say is master-only", async () => {
  const d = new ZenithRouter().get("/x", () => new Response("ok")).dispatch();
  const a = await d(new Request("http://x/x"), anon);
  assertEquals([a.status, (await a.json()).code], [401, 209]);
  const u = await d(new Request("http://x/x"), user);
  assertEquals([u.status, (await u.json()).code], [403, 119]);
  assertEquals((await d(new Request("http://x/x"), apiKey(["classes:read"]))).status, 403);
  assertEquals((await d(new Request("http://x/x"), apiKey(["*"]))).status, 200);
  assertEquals((await d(new Request("http://x/x"), emptyCtx)).status, 200);
});

Deno.test("access - user and public routes", async () => {
  const d = new ZenithRouter()
    .on("GET", "/u", () => new Response("u"), "user")
    .on("GET", "/p", () => new Response("p"), "public")
    .dispatch();
  assertEquals((await d(new Request("http://x/u"), anon)).status, 401);
  assertEquals((await d(new Request("http://x/u"), user)).status, 200);
  // A user route that declares no scope does not accept API keys (fail closed).
  assertEquals((await d(new Request("http://x/u"), apiKey(["data:read"]))).status, 403);
  assertEquals((await d(new Request("http://x/p"), anon)).status, 200);
});

Deno.test("access - API keys need the route's scope", async () => {
  const d = new ZenithRouter()
    .on("GET", "/read", () => new Response("r"), "user", "data:read")
    .on("POST", "/write", () => new Response("w"), "user", "data:write")
    .on("POST", "/each", () => new Response("e"), "user", "per-operation")
    .dispatch();
  assertEquals((await d(new Request("http://x/read"), apiKey(["data:read"]))).status, 200);
  assertEquals((await d(new Request("http://x/write", { method: "POST" }), apiKey(["data:read"]))).status, 403);
  assertEquals((await d(new Request("http://x/write", { method: "POST" }), apiKey(["data:*"]))).status, 200);
  assertEquals((await d(new Request("http://x/each", { method: "POST" }), apiKey([]))).status, 200, "the handler checks");
  // Sessions are not limited by key scopes.
  assertEquals((await d(new Request("http://x/write", { method: "POST" }), user)).status, 200);
});

Deno.test("access - trait routes default to master and may declare their access", async () => {
  const d = buildDynamicRouter({ traits: { t_routes: [
    { method: "GET", path: "/closed", handler: () => new Response("c") },
    { method: "GET", path: "/open", access: "public", handler: () => new Response("o") },
  ] } }).dispatch();
  assertEquals((await d(new Request("http://x/closed"), anon)).status, 401);
  assertEquals((await d(new Request("http://x/open"), anon)).status, 200);
  assertEquals((await d(new Request("http://x/health"), anon)).status, 200);
  assertThrows(() => new ZenithRouter().on("GET", "/y", () => new Response(""), "everyone" as any));
});
