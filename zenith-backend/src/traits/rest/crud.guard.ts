/**
 * @module @zenith/traits/rest/crud.guard
 *
 * What a client (anything but the master key) may send to `/classes`. Pure functions, so every rule
 * is tested on its own. Ideas follow Parse Server with `allowClientClassCreation: false`, its
 * recommended production setting:
 *
 * - Class names are Parse identifiers. Classes starting with `_` (`_User`, `_Session`…) are the
 *   server's own: master key only.
 * - `where` accepts the Parse query operators on an allowlist. Anything else (`$where`, `$expr`,
 *   `$function`, `$inQuery` on another class…) is refused: they run code on the database or read
 *   collections the ACL never sees.
 * - Writes accept Parse field names only; `objectId`, `createdAt` and `updatedAt` belong to the
 *   server.
 * - ACLs have the Parse shape: `{"*" | <userId> | "role:<name>": {r?: true, w?: true}}`.
 */
import { ZenithError, ZenithErrorCode } from "../../core/errors.ts";

export type Doc = Record<string, any>;
export type Acl = Record<string, { r?: true; w?: true }>;

/** The caller as the CRUD sees it. `null` user: an API key without a user session. */
export interface Caller {
  master: boolean;
  user: { objectId: string; roles: string[] } | null;
}

const fail = (code: ZenithErrorCode, msg: string, status = 400) => new ZenithError(code, msg, status);

/** Parse class names; a leading `_` marks the server's own classes (`_User`, `_Session`…). */
const CLASS_NAME = /^_?[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
/** A dotted path into nested objects, as in Parse queries and `order`. */
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_]{0,127}(\.[A-Za-z0-9_]{1,128}){0,7}$/;
const ROLE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const SERVER_FIELDS = new Set(["objectId", "createdAt", "updatedAt"]);

export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;
export const MAX_SKIP = 100_000;
export const MAX_BATCH = 50;
const MAX_REGEX = 256;
const MAX_IN = 1000;
const MAX_DEPTH = 6;

/** A class name a client may use: a Parse identifier that is not a server class. */
export function clientClassName(name: unknown): string {
  if (typeof name !== "string" || !CLASS_NAME.test(name)) {
    throw fail(ZenithErrorCode.INVALID_CLASS_NAME, `Invalid class name: ${JSON.stringify(name)}.`);
  }
  return name;
}

export const isServerClass = (name: string) => name.startsWith("_");

// ─── Queries ─────────────────────────────────────────────────────────────────

const FIELD_OPS = new Set(["$lt", "$lte", "$gt", "$gte", "$ne", "$eq", "$in", "$nin", "$all", "$exists", "$regex", "$options"]);
const GEO_OPS = new Set(["$nearSphere", "$maxDistanceInMiles", "$maxDistanceInKilometers", "$maxDistanceInRadians", "$within"]);
const LOGIC_OPS = new Set(["$or", "$and", "$nor"]);

function checkValue(v: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw fail(ZenithErrorCode.INVALID_QUERY, "Query nested too deeply.");
  if (Array.isArray(v)) {
    if (v.length > MAX_IN) throw fail(ZenithErrorCode.INVALID_QUERY, `At most ${MAX_IN} values per list.`);
    for (const x of v) checkValue(x, depth + 1);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith("$")) throw fail(ZenithErrorCode.INVALID_QUERY, `Operator ${k} is not allowed here.`);
      checkValue(x, depth + 1);
    }
  }
}

function checkCondition(field: string, cond: unknown, depth: number): void {
  if (!FIELD_PATH.test(field) || field === "ACL" || field.startsWith("ACL.")) {
    throw fail(ZenithErrorCode.INVALID_KEY_NAME, `Invalid query key: ${JSON.stringify(field)}.`);
  }
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) return checkValue(cond, depth);
  const keys = Object.keys(cond);
  if (!keys.some((k) => k.startsWith("$"))) return checkValue(cond, depth); // equality with an object (Pointer)
  for (const [op, v] of Object.entries(cond as Doc)) {
    if (GEO_OPS.has(op)) {
      checkValue(op === "$within" ? { box: (v as Doc)?.$box } : v, depth + 1);
      continue;
    }
    if (!FIELD_OPS.has(op)) throw fail(ZenithErrorCode.INVALID_QUERY, `Operator ${op} is not allowed.`);
    if (op === "$regex" && (typeof v !== "string" || v.length > MAX_REGEX)) {
      throw fail(ZenithErrorCode.INVALID_QUERY, `$regex must be a string of at most ${MAX_REGEX} characters.`);
    }
    if (op === "$options" && (typeof v !== "string" || !/^[imxs]{0,4}$/.test(v))) {
      throw fail(ZenithErrorCode.INVALID_QUERY, "$options accepts i, m, x and s.");
    }
    checkValue(v, depth + 1);
  }
}

/** Validates a client `where`. Returns it unchanged (a fresh object) or throws 102/105. */
export function clientWhere(where: unknown, depth = 0): Doc {
  if (where === undefined || where === null) return {};
  if (typeof where !== "object" || Array.isArray(where)) throw fail(ZenithErrorCode.INVALID_QUERY, "where must be an object.");
  if (depth > MAX_DEPTH) throw fail(ZenithErrorCode.INVALID_QUERY, "Query nested too deeply.");
  const out: Doc = {};
  for (const [k, v] of Object.entries(where as Doc)) {
    if (LOGIC_OPS.has(k)) {
      if (!Array.isArray(v) || v.length === 0 || v.length > 50) throw fail(ZenithErrorCode.INVALID_QUERY, `${k} takes 1 to 50 subqueries.`);
      out[k] = v.map((sub) => clientWhere(sub, depth + 1));
    } else if (k.startsWith("$")) {
      throw fail(ZenithErrorCode.INVALID_QUERY, `Operator ${k} is not allowed.`);
    } else {
      checkCondition(k, v, depth + 1);
      out[k] = v;
    }
  }
  return out;
}

/** `order` as Parse sends it (`"-score,name"`), validated. */
export function clientOrder(order: unknown): string | undefined {
  if (order === undefined || order === "") return undefined;
  if (typeof order !== "string") throw fail(ZenithErrorCode.INVALID_QUERY, "order must be a string.");
  for (const f of order.split(",")) {
    const name = f.replace(/^-/, "");
    if (!FIELD_PATH.test(name) || name === "ACL") throw fail(ZenithErrorCode.INVALID_KEY_NAME, `Invalid order key: ${JSON.stringify(f)}.`);
  }
  return order;
}

export function clientPaging(limit: unknown, skip: unknown): { limit: number; skip: number } {
  const l = limit === undefined || limit === "" ? DEFAULT_LIMIT : Number(limit);
  const s = skip === undefined || skip === "" ? 0 : Number(skip);
  if (!Number.isInteger(l) || l < 0) throw fail(ZenithErrorCode.INVALID_LIMIT_ERROR, "limit must be a non-negative integer.");
  if (!Number.isInteger(s) || s < 0 || s > MAX_SKIP) throw fail(ZenithErrorCode.INVALID_SKIP_ERROR, `skip must be an integer from 0 to ${MAX_SKIP}.`);
  return { limit: Math.min(l, MAX_LIMIT), skip: s };
}

/** `include` / `keys` lists: comma-separated field names. */
export function fieldList(v: unknown): string[] {
  if (v === undefined || v === "") return [];
  if (typeof v !== "string") throw fail(ZenithErrorCode.INVALID_QUERY, "Expected a comma-separated list of fields.");
  const names = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!FIELD_NAME.test(n)) throw fail(ZenithErrorCode.INVALID_KEY_NAME, `Invalid key: ${JSON.stringify(n)}.`);
  return names;
}

// ─── ACL ─────────────────────────────────────────────────────────────────────

/** A Parse ACL, normalised to `true` flags only. Throws 123 if it is malformed. */
export function normalizeAcl(acl: unknown): Acl {
  if (!acl || typeof acl !== "object" || Array.isArray(acl)) throw fail(ZenithErrorCode.INVALID_ACL, "ACL must be an object.");
  const out: Acl = {};
  for (const [who, perm] of Object.entries(acl as Doc)) {
    const okWho = who === "*" || (who.startsWith("role:") ? ROLE_NAME.test(who.slice(5)) : /^[A-Za-z0-9_-]{1,128}$/.test(who));
    if (!okWho || !perm || typeof perm !== "object" || Array.isArray(perm)) {
      throw fail(ZenithErrorCode.INVALID_ACL, `Invalid ACL entry: ${JSON.stringify(who)}.`);
    }
    const e: { r?: true; w?: true } = {};
    for (const [k, v] of Object.entries(perm as Doc)) {
      if ((k !== "read" && k !== "write" && k !== "r" && k !== "w") || typeof v !== "boolean") {
        throw fail(ZenithErrorCode.INVALID_ACL, `Invalid ACL permission for ${JSON.stringify(who)}.`);
      }
      if (v) e[k[0] as "r" | "w"] = true;
    }
    if (e.r || e.w) out[who] = e;
  }
  return out;
}

/**
 * The ACL a new object gets when the client sends none: its creator alone. Parse makes such objects
 * public; Zenith does not, so forgetting the ACL never publishes data.
 */
export function defaultAcl(caller: Caller): Acl {
  if (caller.user) return { [caller.user.objectId]: { r: true, w: true } };
  throw fail(ZenithErrorCode.INVALID_ACL, "An ACL is required when there is no user session.");
}

const principals = (caller: Caller) =>
  caller.user ? ["*", caller.user.objectId, ...caller.user.roles.filter((r) => ROLE_NAME.test(r)).map((r) => `role:${r}`)] : ["*"];

/** Does `caller` hold `perm` on an object with `acl`? No ACL means public, as in Parse. */
export function aclAllows(acl: unknown, perm: "r" | "w", caller: Caller): boolean {
  if (caller.master) return true;
  if (acl === undefined || acl === null) return true;
  if (typeof acl !== "object") return false;
  const a = acl as Doc;
  return principals(caller).some((p) => a[p]?.[perm] === true);
}

/** The read-ACL condition as a query, so the database filters before paging. */
export function aclReadQuery(caller: Caller): Doc[] {
  return [{ ACL: { $exists: false } }, ...principals(caller).map((p) => ({ [`ACL.${p}.r`]: true }))];
}

/** `where` restricted to what `caller` may read. */
export function withReadAcl(where: Doc, caller: Caller): Doc {
  if (caller.master) return where;
  const acl = aclReadQuery(caller);
  if (!where.$or) return { ...where, $or: acl };
  const { $or, ...rest } = where;
  return { ...rest, $and: [...(where.$and ?? []), { $or }, { $or: acl }] };
}

// ─── Class-level permissions ─────────────────────────────────────────────────

export type ClpOp = "find" | "count" | "get" | "create" | "update" | "delete";

/** Parse CLP semantics: a missing operation is public; otherwise `*`, the user, a role, or `requiresAuthentication`. */
export function clpAllows(clp: Doc | undefined, op: ClpOp, caller: Caller): boolean {
  if (caller.master) return true;
  const rule = clp?.[op];
  if (!rule) return true;
  if (rule["*"] === true) return true;
  if (!caller.user) return false;
  if (rule.requiresAuthentication === true) return true;
  return principals(caller).some((p) => p !== "*" && rule[p] === true);
}

// ─── Writes ──────────────────────────────────────────────────────────────────

function checkStored(v: unknown, depth: number): void {
  if (depth > 32) throw fail(ZenithErrorCode.INVALID_NESTED_KEY, "Object nested too deeply.");
  if (Array.isArray(v)) for (const x of v) checkStored(x, depth + 1);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith("$") || k.includes(".")) throw fail(ZenithErrorCode.INVALID_NESTED_KEY, `Invalid nested key: ${JSON.stringify(k)}.`);
      checkStored(x, depth + 1);
    }
  }
}

/**
 * The fields of a client write, without the server's own (`objectId`, `createdAt`, `updatedAt`).
 * `ACL` is normalised. Parse operations (`{__op: …}`) are kept for `applyOps`.
 */
export function clientFields(body: unknown): Doc {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(ZenithErrorCode.INVALID_JSON, "The body must be a JSON object.");
  const out: Doc = {};
  for (const [k, v] of Object.entries(body as Doc)) {
    if (SERVER_FIELDS.has(k)) continue;
    if (k === "ACL") {
      out.ACL = normalizeAcl(v);
      continue;
    }
    if (!FIELD_NAME.test(k)) throw fail(ZenithErrorCode.INVALID_KEY_NAME, `Invalid field name: ${JSON.stringify(k)}.`);
    checkStored(v, 0);
    out[k] = v;
  }
  return out;
}

const isOp = (v: unknown): v is { __op: string } & Doc => !!v && typeof v === "object" && typeof (v as Doc).__op === "string";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Parse field operations on an update.
 * - `store`: what goes to the database. `Increment`, `AddUnique`, `Remove` and `Delete` stay
 *   operations (the MongoDB adapter applies them atomically); `Add` becomes the new array, so two
 *   concurrent `Add`s can lose one.
 * - `result`: the values the fields end up with, for the response and the beforeSave hooks.
 */
export function applyOps(existing: Doc, data: Doc): { store: Doc; result: Doc } {
  const store: Doc = {};
  const result: Doc = {};
  for (const [k, v] of Object.entries(data)) {
    if (!isOp(v)) {
      store[k] = result[k] = v;
      continue;
    }
    const cur = existing[k];
    const objects = Array.isArray(v.objects) ? v.objects : null;
    switch (v.__op) {
      case "Increment": {
        if (typeof v.amount !== "number" || !Number.isFinite(v.amount)) throw fail(ZenithErrorCode.INVALID_JSON, "Increment needs a finite number amount.");
        if (cur !== undefined && cur !== null && typeof cur !== "number") throw fail(ZenithErrorCode.INCORRECT_TYPE, `${k} is not a number.`);
        store[k] = { __op: "Increment", amount: v.amount };
        result[k] = (cur ?? 0) + v.amount;
        break;
      }
      case "Delete":
        store[k] = { __op: "Delete" };
        result[k] = undefined;
        break;
      case "Add":
      case "AddUnique":
      case "Remove": {
        if (!objects || objects.length > MAX_IN) throw fail(ZenithErrorCode.INVALID_JSON, `${v.__op} needs an objects array of at most ${MAX_IN} items.`);
        checkStored(objects, 0);
        if (cur !== undefined && cur !== null && !Array.isArray(cur)) throw fail(ZenithErrorCode.INCORRECT_TYPE, `${k} is not an array.`);
        const arr: unknown[] = [...(cur ?? [])];
        if (v.__op === "Add") arr.push(...objects);
        else if (v.__op === "AddUnique") for (const o of objects) { if (!arr.some((x) => same(x, o))) arr.push(o); }
        else for (const o of objects) for (let i = arr.length - 1; i >= 0; i--) if (same(arr[i], o)) arr.splice(i, 1);
        store[k] = v.__op === "Add" ? arr : { __op: v.__op, objects };
        result[k] = arr;
        break;
      }
      default:
        throw fail(ZenithErrorCode.INVALID_JSON, `Unsupported operation ${JSON.stringify(v.__op)} on ${k}.`);
    }
  }
  return { store, result };
}

/** On create there is nothing to operate on: operations become their values (`Increment` → amount). */
export function opsOnCreate(data: Doc): Doc {
  const { result } = applyOps({}, data);
  return Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined));
}
