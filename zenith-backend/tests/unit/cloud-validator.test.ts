import { assertEquals, assertRejects } from "@std/assert";
import { ZenCloud } from "../../src/core/cloud.ts";
import { ZenithRouter } from "../../src/core/router.ts";
import { CloudCodeTrait } from "../../src/traits/cloud/cloudcode.trait.ts";
import {
  checkValidator,
  CloudValidationError,
  functionAccess,
} from "../../src/traits/cloud/validator.ts";

// deno-lint-ignore no-explicit-any
const cloudTrait = () => (CloudCodeTrait as any).create({ traits: {} });

Deno.test("cloud validator: who may call a function (master-only unless the validator opens it)", () => {
  assertEquals(functionAccess(undefined), "master");
  assertEquals(functionAccess({}), "master");
  assertEquals(
    functionAccess({ fields: { a: { required: true } } }),
    "master",
    "fields alone do not open it",
  );
  assertEquals(functionAccess({ requireUser: true }), "user");
  assertEquals(functionAccess({ requireAnyUserRoles: ["staff"] }), "user");
  assertEquals(functionAccess({ public: true }), "public");
  assertEquals(functionAccess({ public: true, requireMaster: true }), "master");
});

Deno.test("cloud validator: Parse semantics for users, roles, master key and fields", async () => {
  const user = { objectId: "u1", roles: ["staff"] };
  const fail = (p: Promise<unknown>, msg: string) =>
    assertRejects(() => p, CloudValidationError, msg);
  await fail(
    checkValidator({ requireUser: true }, { master: false }, {}),
    "Please login to continue.",
  );
  await checkValidator({ requireUser: true }, { master: false, user }, {});
  await checkValidator({ requireUser: true }, { master: false, apiKey: true }, {}); // a service key passes
  await fail(
    checkValidator({ requireAnyUserRoles: ["staff"] }, { master: false, apiKey: true }, {}),
    "Please login",
  );
  await fail(
    checkValidator({ requireAllUserRoles: ["staff", "admins"] }, { master: false, user }, {}),
    "all the required roles",
  );
  await fail(
    checkValidator({ requireMaster: true }, { master: false, user }, {}),
    "Master key is required",
  );
  // The master key skips the validator unless validateMasterKey.
  await checkValidator({ requireUser: true }, { master: true }, {});
  await fail(
    checkValidator({ requireUser: true, validateMasterKey: true }, { master: true }, {}),
    "Please login",
  );

  const v = {
    fields: {
      name: { required: true, type: "String" },
      size: { type: "number", default: 10, options: (n: number) => n > 0 },
      kind: { options: ["a", "b"], error: "kind must be a or b" },
      owner: { constant: true },
    },
  };
  const caller = { master: false, user };
  await fail(checkValidator(v, caller, {}), "Please specify data for name.");
  await fail(checkValidator(v, caller, { name: 1 }), "Invalid type for name. Expected: string");
  await fail(checkValidator(v, caller, { name: "x", size: -1 }), "Invalid option for size.");
  await fail(checkValidator(v, caller, { name: "x", kind: "c" }), "kind must be a or b");
  const data: Record<string, unknown> = { name: "x", owner: "mallory" };
  await checkValidator(v, caller, data, { name: "x", owner: "alice" });
  assertEquals(data, { name: "x", size: 10, owner: "alice" }, "default set, constant kept");
  const err = await assertRejects(() => checkValidator(v, caller, {}), CloudValidationError);
  assertEquals(err.code, 142);
});

/** The trait's /functions route behind the real router, so `denied()` and callerFields() run. */
function functionsRouter(cloud: ReturnType<typeof cloudTrait>) {
  const router = new ZenithRouter();
  for (const r of cloud["cloudcode-routes"]) {
    router.on(r.method, r.path, r.handler, r.access, r.scope);
  }
  const dispatch = router.dispatch();
  return async (name: string, ctx: Record<string, unknown>, body: unknown = {}) => {
    const res = await dispatch(
      new Request(`http://h/functions/${name}`, { method: "POST", body: JSON.stringify(body) }),
      { appId: "a", ...ctx } as never,
    );
    return { status: res.status, body: await res.json() };
  };
}

Deno.test("cloud functions: access per function, Parse error codes, validators on params", async () => {
  const cloud = cloudTrait();
  const api = cloud.cloud;
  api.define("internal", () => "secret");
  api.define("hello", (r: { params: { name: string } }) => `hi ${r.params.name}`, {
    requireUser: true,
    fields: { name: { required: true, type: "string" } },
  });
  api.define("status", () => "up", { public: true });
  api.define("adminsOnly", () => "ok", { requireAnyUserRoles: ["admins"] });
  api.define("fails", (_r: unknown, error: (c: number, m: string) => never) => error(141, "nope"));
  api.define("throws", () => {
    throw new Error("boom");
  }, { public: true });
  const call = functionsRouter(cloud);
  const user = { auth: { userId: "u1", roles: [] } };
  const master = { masterKey: true };

  // No validator: master-only, as before (ADR-013).
  assertEquals((await call("internal", {})).status, 401);
  assertEquals((await call("internal", user)).status, 403);
  assertEquals((await call("internal", master)).body, { result: "secret" });
  // requireUser opens it to sessions; the validator checks the params.
  assertEquals((await call("hello", {})).status, 401);
  assertEquals((await call("hello", user, { name: "ana" })).body, { result: "hi ana" });
  assertEquals((await call("hello", user, {})).body, {
    code: 142,
    error: "Validation failed. Please specify data for name.",
  });
  assertEquals((await call("status", {})).body, { result: "up" }, "public: no session needed");
  assertEquals(
    (await call("adminsOnly", user)).status,
    400,
    "the route opens, the role check refuses",
  );
  assertEquals(
    (await call("adminsOnly", { auth: { userId: "u2", roles: ["admins"] } })).body,
    { result: "ok" },
  );
  // An API key needs functions:invoke for a function open to users.
  assertEquals(
    (await call("hello", { apiKey: { scopes: ["data:read"] } }, { name: "x" })).status,
    403,
  );
  assertEquals(
    (await call("hello", { apiKey: { scopes: ["functions:invoke"] } }, { name: "x" })).body,
    { result: "hi x" },
  );
  // Unknown functions look master-only to others; the master key gets Parse's 141.
  assertEquals((await call("missing", user)).status, 403);
  assertEquals((await call("missing", master)).body, {
    code: 141,
    error: 'Invalid function: "missing"',
  });
  // response.error(141, …) and a thrown error: HTTP 400 with the Parse code (141 used to crash new Response).
  assertEquals(await call("fails", master), { status: 400, body: { code: 141, error: "nope" } });
  assertEquals(await call("throws", {}), { status: 400, body: { code: 141, error: "boom" } });
});

Deno.test("cloud triggers: Zen.Cloud triggers run (with their validators); afterFind may replace results", async () => {
  const cls = `VT_${crypto.randomUUID().slice(0, 8)}`;
  const seen: string[] = [];
  ZenCloud.beforeSave(cls, (r) => {
    seen.push(`before:${r.object.title}`);
    (r.object as Record<string, unknown>).slug = String(r.object.title).toLowerCase();
  }, { requireUser: true, fields: { title: { required: true, type: "string" } } });
  ZenCloud.afterFind(cls, (r) => r.objects.filter((o) => !o.hidden));
  ZenCloud.beforeDelete(cls, () => {
    seen.push("beforeDelete");
  }, { requireAnyUserRoles: ["admins"] });
  const cloud = cloudTrait().cloud;
  const user = { objectId: "u1", roles: [] as string[] };

  const obj: Record<string, unknown> = { title: "Hello" };
  await cloud.runBeforeSave(cls, { object: obj, user, master: false });
  assertEquals(obj.slug, "hello", "the global trigger ran and changed the object");
  await assertRejects(
    () => cloud.runBeforeSave(cls, { object: { title: "x" }, master: false }),
    CloudValidationError,
    "Please login",
  );
  await assertRejects(
    () => cloud.runBeforeSave(cls, { object: {}, user, master: false }),
    CloudValidationError,
    "Please specify data for title.",
  );
  await cloud.runBeforeSave(cls, { object: {}, master: true }); // the master key skips the validator

  const results = [{ id: 1 }, { id: 2, hidden: true }];
  await cloud.runAfterFind(cls, { results, user, master: false });
  assertEquals(results, [{ id: 1 }]);

  await assertRejects(
    () => cloud.runBeforeDelete(cls, { object: { id: 1 }, user, master: false }),
    CloudValidationError,
    "required roles",
  );
  await cloud.runBeforeDelete(cls, {
    object: { id: 1 },
    user: { objectId: "a", roles: ["admins"] },
    master: false,
  });
  assertEquals(seen, ["before:Hello", "before:undefined", "beforeDelete"]);
});

Deno.test("cloud triggers: validators on triggers registered on the trait", async () => {
  const cloud = cloudTrait().cloud;
  let ran = 0;
  cloud.beforeSave("Doc", () => {
    ran++;
  }, { requireUser: true });
  await assertRejects(
    () => cloud.runBeforeSave("Doc", { object: {}, master: false }),
    CloudValidationError,
  );
  await cloud.runBeforeSave("Doc", { object: {}, user: { objectId: "u" }, master: false });
  assertEquals(ran, 1);
});

Deno.test("cloud triggers: a thrown error reaches the client as Parse's 142; afterSave errors are only logged", async () => {
  const { ZenithError } = await import("../../src/core/errors.ts");
  const cloud = cloudTrait().cloud;
  cloud.beforeSave("E1", () => {
    throw new Error("title is required");
  });
  cloud.beforeDelete("E1", () => {
    throw "no deletes"; // Parse also accepts a string
  });
  cloud.beforeFind("E1", () => {
    throw new ZenithError(119 as never, "keep my code", 403);
  });
  cloud.afterSave("E1", () => {
    throw new Error("after");
  });
  const e1 = await assertRejects(
    () => cloud.runBeforeSave("E1", { object: {}, master: true }),
    ZenithError,
  );
  assertEquals([e1.code, e1.httpStatus, e1.message], [142, 400, "title is required"]);
  const e2 = await assertRejects(
    () => cloud.runBeforeDelete("E1", { object: {}, master: true }),
    ZenithError,
  );
  assertEquals(e2.message, "no deletes");
  const e3 = await assertRejects(
    () => cloud.runBeforeFind("E1", { query: {}, master: true }),
    ZenithError,
  );
  assertEquals([e3.code, e3.httpStatus], [119, 403]);
  await cloud.runAfterSave("E1", { object: {}, master: true }); // logged, does not throw
});

Deno.test("cloud triggers: Zen.Cloud file triggers run on storage writes and can refuse them", async () => {
  const seen: string[] = [];
  ZenCloud.beforeSaveFile((r) => {
    const f = r.object as unknown as { name?: string } | undefined;
    seen.push(`before:${(r as unknown as { file: { name: string } }).file.name}`);
    if ((r as unknown as { file: { name: string } }).file.name.endsWith(".exe")) {
      throw new Error("no executables");
    }
    return f as never;
  });
  ZenCloud.afterSaveFile(() => {
    seen.push("after");
    throw new Error("logged only");
  });
  try {
    const cloud = cloudTrait().cloud;
    await cloud.runFileTrigger("beforeWrite", { file: { name: "a.png" }, master: false });
    await cloud.runFileTrigger("afterWrite", { file: { name: "a.png" }, master: false });
    const e = await assertRejects(
      () => cloud.runFileTrigger("beforeWrite", { file: { name: "x.exe" }, master: false }),
      Error,
      "no executables",
    );
    assertEquals((e as { code?: number }).code, 142);
    assertEquals(seen, ["before:a.png", "after", "before:x.exe"]);
  } finally {
    ZenCloud.beforeSaveFile(() => {});
    ZenCloud.afterSaveFile(() => {});
  }
});
