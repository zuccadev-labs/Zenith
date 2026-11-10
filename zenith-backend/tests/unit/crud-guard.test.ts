/** The rules of `crud.guard.ts`, one by one: what a client may send to /classes. */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  aclAllows, applyOps, type Caller, clientClassName, clientFields, clientOrder, clientPaging, clientWhere,
  clpAllows, defaultAcl, normalizeAcl, opsOnCreate, withReadAcl,
} from "../../src/traits/rest/crud.guard.ts";
import type { ZenithError } from "../../src/core/errors.ts";

const ana: Caller = { master: false, user: { objectId: "ana", roles: ["editors"] } };
const keyOnly: Caller = { master: false, user: null };
const master: Caller = { master: true, user: null };
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as ZenithError).code; }
  return null;
};

Deno.test("class names: Parse identifiers only", () => {
  assertEquals(clientClassName("Note_2"), "Note_2");
  assertEquals(clientClassName("_User"), "_User", "valid name; whether the caller may use it is checked elsewhere");
  for (const bad of ["", "__x", "_", "2x", "a.b", "system.users", "x-y", "$cmd", "a".repeat(65), 7]) {
    assertEquals(code(() => clientClassName(bad)), 103, String(bad));
  }
});

Deno.test("where: Parse operators pass, code and cross-collection operators do not", () => {
  const ok = { score: { $gte: 1, $lt: 9 }, tags: { $all: ["a"] }, name: { $regex: "^an", $options: "i" }, $or: [{ a: 1 }, { "b.c": { $exists: true } }] };
  assertEquals(clientWhere(ok), ok);
  assertEquals(clientWhere(undefined), {});
  for (const bad of [
    { $where: "sleep(1000)" },
    { $expr: { $gt: ["$a", 1] } },
    { owner: { $inQuery: { className: "ApiKey", where: {} } } },
    { owner: { $select: { query: { className: "ApiKey" }, key: "x" } } },
    { a: { $function: {} } },
    { a: { $eq: { $gt: 1 } } },
  ]) assertEquals(code(() => clientWhere(bad)), 102, JSON.stringify(bad));
  for (const bad of [{ ACL: { $exists: true } }, { "ACL.*.r": true }, { "_rperm": 1 }, { "a b": 1 }]) {
    assertEquals(code(() => clientWhere(bad)), 105, JSON.stringify(bad));
  }
  assertEquals(code(() => clientWhere({ a: { $regex: "x".repeat(257) } })), 102, "long regex");
  assertEquals(code(() => clientWhere({ a: { $in: Array(1001).fill(1) } })), 102, "huge $in");
  let deep: Record<string, unknown> = { a: 1 };
  for (let i = 0; i < 10; i++) deep = { $and: [deep] };
  assertEquals(code(() => clientWhere(deep)), 102, "deep nesting");
});

Deno.test("order and paging are bounded", () => {
  assertEquals(clientOrder("-score,name"), "-score,name");
  assertEquals(code(() => clientOrder("ACL")), 105);
  assertEquals(code(() => clientOrder("$natural")), 105);
  assertEquals(clientPaging(undefined, undefined), { limit: 100, skip: 0 });
  assertEquals(clientPaging("5000", "10"), { limit: 1000, skip: 10 });
  assertEquals(code(() => clientPaging("-1", "0")), 117);
  assertEquals(code(() => clientPaging("10", "1e9")), 118);
});

Deno.test("writes: server fields dropped, bad names and $ keys refused", () => {
  assertEquals(clientFields({ objectId: "x", createdAt: 1, updatedAt: 2, title: "t", n: { a: [1] } }), { title: "t", n: { a: [1] } });
  assertEquals(code(() => clientFields({ _rperm: [] })), 105);
  assertEquals(code(() => clientFields({ "a.b": 1 })), 105);
  assertEquals(code(() => clientFields({ x: { $set: 1 } })), 121);
  assertEquals(code(() => clientFields({ x: [{ "k.y": 1 }] })), 121);
  assertEquals(code(() => clientFields([1])), 107);
});

Deno.test("ACL: normalised, malformed ones refused, creator-only by default", () => {
  assertEquals(normalizeAcl({ "*": { read: true, write: false }, ana: { r: true, w: true }, "role:editors": { w: true } }), { "*": { r: true }, ana: { r: true, w: true }, "role:editors": { w: true } });
  for (const bad of [[], "x", { "*": true }, { "a.b": { r: true } }, { "role:a b": { r: true } }, { "*": { r: "yes" } }, { "*": { admin: true } }]) {
    assertEquals(code(() => normalizeAcl(bad)), 123, JSON.stringify(bad));
  }
  assertEquals(defaultAcl(ana), { ana: { r: true, w: true } });
  assertEquals(code(() => defaultAcl(keyOnly)), 123, "an API key without a user must give an ACL");
});

Deno.test("ACL checks: user, role, public, master", () => {
  assert(aclAllows({ ana: { r: true } }, "r", ana));
  assert(!aclAllows({ ana: { r: true } }, "w", ana));
  assert(aclAllows({ "role:editors": { w: true } }, "w", ana));
  assert(!aclAllows({ bob: { r: true } }, "r", ana));
  assert(aclAllows({ "*": { r: true } }, "r", keyOnly));
  assert(aclAllows(undefined, "r", ana), "no ACL is public, as in Parse");
  assert(aclAllows({}, "w", master));
  assert(!aclAllows("garbage", "r", ana));
});

Deno.test("the read ACL becomes part of the query, next to the client's own $or", () => {
  assertEquals(withReadAcl({ a: 1 }, master), { a: 1 });
  const q = withReadAcl({ a: 1 }, ana);
  assertEquals(q.a, 1);
  assertEquals(q.$or, [{ ACL: { $exists: false } }, { "ACL.*.r": true }, { "ACL.ana.r": true }, { "ACL.role:editors.r": true }]);
  const both = withReadAcl({ $or: [{ a: 1 }, { b: 2 }] }, ana);
  assertEquals(both.$or, undefined);
  assertEquals(both.$and.length, 2, "client $or and ACL $or are both required");
});

Deno.test("CLP: missing op is public, otherwise *, user, role or requiresAuthentication", () => {
  assert(clpAllows(undefined, "find", ana));
  assert(clpAllows({ find: { "*": true } }, "find", keyOnly));
  assert(!clpAllows({ find: {} }, "find", ana));
  assert(clpAllows({ find: { ana: true } }, "find", ana));
  assert(clpAllows({ find: { "role:editors": true } }, "find", ana));
  assert(!clpAllows({ find: { "role:admin": true } }, "find", ana), "a role the user does not hold");
  assert(clpAllows({ create: { requiresAuthentication: true } }, "create", ana));
  assert(!clpAllows({ create: { requiresAuthentication: true } }, "create", keyOnly));
  assert(clpAllows({ delete: {} }, "delete", master));
});

Deno.test("Parse operations: atomic ones stay operations, Add is computed", () => {
  const existing = { n: 2, tags: ["a"], gone: 1 };
  const { store, result } = applyOps(existing, {
    n: { __op: "Increment", amount: 3 },
    tags: { __op: "AddUnique", objects: ["a", "b"] },
    list: { __op: "Add", objects: [1] },
    gone: { __op: "Delete" },
    title: "x",
  });
  assertEquals(store, { n: { __op: "Increment", amount: 3 }, tags: { __op: "AddUnique", objects: ["a", "b"] }, list: [1], gone: { __op: "Delete" }, title: "x" });
  assertEquals(result, { n: 5, tags: ["a", "b"], list: [1], gone: undefined, title: "x" });
  assertEquals(code(() => applyOps({ n: "x" }, { n: { __op: "Increment", amount: 1 } })), 111);
  assertEquals(code(() => applyOps({}, { n: { __op: "Increment", amount: Infinity } })), 107);
  assertEquals(code(() => applyOps({}, { n: { __op: "Batch" } })), 107);
  assertEquals(opsOnCreate({ n: { __op: "Increment", amount: 2 }, d: { __op: "Delete" }, t: 1 }), { n: 2, t: 1 });
  assertThrows(() => applyOps({}, { l: { __op: "Add", objects: [{ $x: 1 }] } }));
});
