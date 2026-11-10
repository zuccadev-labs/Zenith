/**
 * Parse Server-compatible REST CRUD: /classes/:className, /classes/:className/:objectId and /batch.
 *
 * Open to users (`access: "user"`), with the checks of Parse Server in production
 * (`allowClientClassCreation: false`):
 * 1. **Class.** Only classes defined in the schema (`POST /schemas/:className` with the master key).
 *    Classes starting with `_` and the traits' internal collections are master key only.
 * 2. **Class-level permissions** (CLP) of that schema, per operation.
 * 3. **ACL** of each object. Reads filter by ACL in the database query, so paging is right; an
 *    object the caller cannot read or write answers 101 "not found", like Parse, so its existence
 *    does not leak.
 * 4. **Input** validated by `crud.guard.ts`: query operators on an allowlist, Parse field names,
 *    well-formed ACLs, bounded limit/skip/batch.
 *
 * Without an ACL, a new object belongs to its creator only (Parse would make it public).
 *
 * @barrits-trait
 * @barrits-summary ZenithRestCrud
 * @barrits-provides crud-routes, crud
 * @barrits-consumes cloud, db, schema
 * @barrits-tags uses:events, uses:federation
 * @barrits-state registeredCollections
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithError, ZenithErrorCode, ZenithErrors } from "../../core/errors.ts";
import { type DataOperation, dataScope, missingKeyScope } from "../../security/api-keys/scopes.ts";
import {
  aclAllows, applyOps, type Caller, clientClassName, clientFields, clientOrder, clientPaging, clientWhere,
  type ClpOp, clpAllows, defaultAcl, type Doc, fieldList, isServerClass, MAX_BATCH, opsOnCreate, withReadAcl,
} from "./crud.guard.ts";

/** The caller of a CRUD operation. Internal callers pass `{ master: true }`. */
export function callerOf(ctx: any): Caller {
  const master = ctx?.master === true || ctx?.masterKey === true;
  const u = ctx?.user;
  return { master, user: u?.objectId ? { objectId: String(u.objectId), roles: (u.roles ?? []).map(String) } : null };
}

const forbidden = (msg: string) => new ZenithError(ZenithErrorCode.OPERATION_FORBIDDEN, msg, 403);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const RestCrudTrait = createTraitDescriptor({
  name: "ZenithRestCrud",
  provides: ["crud-routes", "crud"],
  consumes: ["cloud", "db", "schema"],
  tags: ["uses:events", "uses:federation"],
  state: ["registeredCollections"],
  runtimes: ["deno"],
  summary: "Parse Server-compatible REST CRUD on /classes and /batch: schema-defined classes only, CLP, ACL filtering in the query, validated input.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const schema = deps.traits["schema"];
    const cloud = deps.traits["cloud"];
    let allowClientClassCreation = false;

    const hooks = (caller: Caller) => ({ user: caller.user ?? undefined, master: caller.master });

    /** Checks that `caller` may run `op` on `className`; returns its schema (or null for the master key). */
    const classFor = async (className: string, op: ClpOp, caller: Caller, creating = false) => {
      clientClassName(className);
      if (caller.master) return null;
      if (isServerClass(className)) throw forbidden(`Class ${className} is reserved for the master key.`);
      let def = await schema.resolve(className);
      if (!def && creating && allowClientClassCreation) {
        // Never adopt a collection that already exists: it may be a trait's internal data.
        const existing: string[] = await db.listClasses().catch(() => [className]);
        if (!existing.includes(className)) def = await schema.defineClass(className, {});
      }
      if (!def) throw forbidden(`This user is not allowed to access non-existent class: ${className}`);
      if (!clpAllows(def.clp, op, caller)) throw forbidden(`Permission denied for action ${op} on class ${className}.`);
      return def;
    };

    /** Expands `include`d pointers the caller may read; the others stay pointers. */
    const expand = async (obj: Doc, includes: string[], caller: Caller) => {
      for (const inc of includes) {
        const p = obj[inc];
        if (!p || typeof p !== "object" || typeof p.className !== "string" || typeof p.objectId !== "string") continue;
        try {
          await classFor(p.className, "get", caller);
          const target = await db.read(p.className, p.objectId);
          if (target && aclAllows(target.ACL, "r", caller)) obj[inc] = { ...target, __type: "Object", className: p.className };
        } catch (_e) { /* not readable: leave the pointer */ }
      }
      return obj;
    };

    const project = (obj: Doc, keys: string[]) =>
      keys.length ? Object.fromEntries(Object.entries(obj).filter(([k]) => ["objectId", "createdAt", "updatedAt", ...keys].includes(k))) : obj;

    const validate = (className: string, data: Doc) => {
      const r = schema.validate?.(className, data);
      if (r && !r.valid) throw ZenithErrors.validationFailed(r.errors.join("; "));
    };

    /** Reads `objectId` if the caller may: otherwise 101, whether it exists or not. */
    const readFor = async (className: string, objectId: string, perm: "r" | "w", caller: Caller) => {
      const obj = typeof objectId === "string" && objectId ? await db.read(className, objectId) : null;
      if (!obj || !aclAllows(obj.ACL, perm, caller)) throw ZenithErrors.notFound(className, objectId);
      return obj;
    };

    /** API keys only do what their scopes cover; batch operations go through here too. */
    const keyMayDo = (ctx: any, op: DataOperation, className: string) => {
      const why = missingKeyScope(ctx ?? {}, dataScope(op, className));
      if (why) throw new ZenithError(ZenithErrorCode.OPERATION_FORBIDDEN, why, 403);
    };

    const traitApi: any = {
      /** `allowClientClassCreation` (default false): users may create classes that do not exist yet. */
      configure: (cfg: { allowClientClassCreation?: boolean } = {}) => {
        allowClientClassCreation = cfg.allowClientClassCreation === true;
      },

      listClass: async (className: string, query: Record<string, any>, ctx: any) => {
        keyMayDo(ctx, "read", className);
        const caller = callerOf(ctx);
        const wantCount = query.count === "1" || query.count === 1 || query.count === true;
        await classFor(className, "find", caller);
        if (wantCount) await classFor(className, "count", caller);
        const where = caller.master ? (query.where ?? {}) : clientWhere(query.where);
        const order = clientOrder(query.order);
        const { limit, skip } = clientPaging(query.limit, query.skip);
        const includes = fieldList(query.include);
        const keys = fieldList(query.keys ?? query.fields);
        await cloud.runBeforeFind(className, { query: { where, order, limit, skip }, ...hooks(caller) });

        const filter = withReadAcl(where, caller);
        let results: Doc[] = limit === 0 ? [] : await db.find(className, filter, { limit, skip, order });
        results = results.filter((r) => aclAllows(r.ACL, "r", caller)); // defence in depth
        for (const r of results) await expand(r, includes, caller);
        results = results.map((r) => project(r, keys));

        const response: Doc = { results };
        if (wantCount) response.count = (await db.find(className, filter)).filter((r: Doc) => aclAllows(r.ACL, "r", caller)).length;
        await cloud.runAfterFind(className, { results, ...hooks(caller) });
        return response;
      },

      getObject: async (className: string, objectId: string, query: Record<string, any>, ctx: any) => {
        keyMayDo(ctx, "read", className);
        const caller = callerOf(ctx);
        await classFor(className, "get", caller);
        await cloud.runBeforeFind(className, { objectId, query, ...hooks(caller) });
        const obj = await readFor(className, objectId, "r", caller);
        await expand(obj, fieldList(query.include), caller);
        await cloud.runAfterFind(className, { object: obj, ...hooks(caller) });
        return project(obj, fieldList(query.keys ?? query.fields));
      },

      createObject: async (className: string, body: Record<string, any>, ctx: any) => {
        keyMayDo(ctx, "create", className);
        const caller = callerOf(ctx);
        await classFor(className, "create", caller, true);
        const data = opsOnCreate(clientFields(body));
        if (!data.ACL && !caller.master) data.ACL = defaultAcl(caller);
        validate(className, data);
        await cloud.runBeforeSave(className, { object: data, ...hooks(caller) });
        const created = await db.create(className, data);
        await cloud.runAfterSave(className, { object: created, ...hooks(caller) });
        deps.traits["events"]?.emit?.(`${className}.created`, created);
        deps.traits["federation"]?.replicate?.(className, "create", created);
        return created;
      },

      updateObject: async (className: string, objectId: string, body: Record<string, any>, ctx: any) => {
        keyMayDo(ctx, "write", className);
        const caller = callerOf(ctx);
        await classFor(className, "update", caller);
        const existing = await readFor(className, objectId, "w", caller);
        const { store, result } = applyOps(existing, clientFields(body));
        const merged = { ...existing, ...result };
        validate(className, merged);
        await cloud.runBeforeSave(className, { object: merged, original: existing, ...hooks(caller) });
        const updated = await db.update(className, objectId, store);
        await cloud.runAfterSave(className, { object: updated, original: existing, ...hooks(caller) });
        deps.traits["events"]?.emit?.(`${className}.updated`, updated);
        deps.traits["federation"]?.replicate?.(className, "update", updated);
        return updated;
      },

      deleteObject: async (className: string, objectId: string, ctx: any) => {
        keyMayDo(ctx, "delete", className);
        const caller = callerOf(ctx);
        await classFor(className, "delete", caller);
        const existing = await readFor(className, objectId, "w", caller);
        await cloud.runBeforeDelete(className, { object: existing, ...hooks(caller) });
        await db.delete(className, objectId);
        await cloud.runAfterDelete(className, { object: existing, ...hooks(caller) });
        deps.traits["events"]?.emit?.(`${className}.deleted`, existing);
        deps.traits["federation"]?.replicate?.(className, "delete", existing);
        return {};
      },

      increment: async (className: string, objectId: string, field: string, amount: number, ctx: any) => {
        const updated = await traitApi.updateObject(className, objectId, { [field]: { __op: "Increment", amount } }, ctx);
        return { [field]: updated?.[field] };
      },

      /**
       * Parse batch: up to 50 requests, run one by one (not a transaction). Paths may carry the
       * mount prefix (`/parse/classes/…`), as the Parse SDKs send them.
       */
      batch: async (requests: unknown, ctx: any) => {
        if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_BATCH) {
          throw ZenithErrors.invalidQuery(`requests must be an array of 1 to ${MAX_BATCH} operations.`);
        }
        const results: Doc[] = [];
        for (const r of requests as Doc[]) {
          try {
            const parts = String(r?.path ?? "").split("?")[0].split("/").filter(Boolean);
            const at = parts.indexOf("classes");
            const [className, objectId, extra] = at >= 0 ? parts.slice(at + 1) : [];
            if (!className || extra !== undefined) throw ZenithErrors.invalidQuery(`Unsupported batch path: ${r?.path}`);
            const body = r.body ?? {};
            let out: unknown;
            if (r.method === "POST" && !objectId) out = await traitApi.createObject(className, body, ctx);
            else if (r.method === "GET") out = objectId ? await traitApi.getObject(className, objectId, body, ctx) : await traitApi.listClass(className, body, ctx);
            else if (r.method === "PUT" && objectId) out = await traitApi.updateObject(className, objectId, body, ctx);
            else if (r.method === "DELETE" && objectId) out = await traitApi.deleteObject(className, objectId, ctx);
            else throw ZenithErrors.invalidQuery(`Unsupported batch operation: ${r?.method} ${r?.path}`);
            results.push({ success: out });
          } catch (e) {
            if (!(e instanceof ZenithError)) console.error("[ZenithRestCrud] batch operation failed:", e);
            results.push({ error: e instanceof ZenithError ? e.toJSON() : { code: ZenithErrorCode.INTERNAL_SERVER_ERROR, error: "Internal server error." } });
          }
        }
        return results;
      },
    };

    const queryOf = (req: Request) => {
      const q: Record<string, any> = {};
      new URL(req.url).searchParams.forEach((v, k) => {
        if (k !== "where") return void (q[k] = v);
        try { q.where = JSON.parse(v); } catch (_e) { throw ZenithErrors.invalidQuery("where is not valid JSON."); }
      });
      return q;
    };
    const bodyOf = async (req: Request) => {
      try { return await req.json(); } catch (_e) { throw new ZenithError(ZenithErrorCode.INVALID_JSON, "Invalid JSON body.", 400); }
    };
    // ctx.params comes from the matched (and alias-rewritten) path, not from req.url.
    const p = (ctx: any) => ctx.params as { className: string; objectId: string };
    const classParam = { name: "className", in: "path", required: true, schema: { type: "string" } };
    const idParam = { name: "objectId", in: "path", required: true, schema: { type: "string" } };
    const objectBody = { content: { "application/json": { schema: { type: "object", additionalProperties: true } } } };

    const crud_routes = [
      {
        method: "GET" as const, path: "/classes/:className", access: "user", scope: "per-operation" as const,
        _openapi: {
          summary: "List objects in a class",
          parameters: [classParam, ...["where", "limit", "skip", "order", "include", "keys", "count"].map((name) => ({ name, in: "query", schema: { type: "string" } }))],
        },
        handler: async (req: Request, ctx: any) => json(await traitApi.listClass(p(ctx).className, queryOf(req), ctx)),
      },
      {
        method: "GET" as const, path: "/classes/:className/:objectId", access: "user", scope: "per-operation" as const,
        _openapi: { summary: "Get a single object", parameters: [classParam, idParam, { name: "include", in: "query", schema: { type: "string" } }] },
        handler: async (req: Request, ctx: any) => json(await traitApi.getObject(p(ctx).className, p(ctx).objectId, queryOf(req), ctx)),
      },
      {
        method: "POST" as const, path: "/classes/:className", access: "user", scope: "per-operation" as const,
        _openapi: { summary: "Create a new object", parameters: [classParam], requestBody: objectBody },
        handler: async (req: Request, ctx: any) => {
          const { className } = p(ctx);
          const created = await traitApi.createObject(className, await bodyOf(req), ctx);
          return json(created, 201, { location: `/classes/${className}/${created.objectId}` });
        },
      },
      {
        method: "PUT" as const, path: "/classes/:className/:objectId", access: "user", scope: "per-operation" as const,
        _openapi: { summary: "Update an object", parameters: [classParam, idParam], requestBody: objectBody },
        handler: async (req: Request, ctx: any) => json(await traitApi.updateObject(p(ctx).className, p(ctx).objectId, await bodyOf(req), ctx)),
      },
      {
        method: "DELETE" as const, path: "/classes/:className/:objectId", access: "user", scope: "per-operation" as const,
        _openapi: { summary: "Delete an object", parameters: [classParam, idParam] },
        handler: async (_req: Request, ctx: any) => json(await traitApi.deleteObject(p(ctx).className, p(ctx).objectId, ctx)),
      },
      {
        method: "POST" as const, path: "/classes/:className/:objectId/Increment", access: "user", scope: "per-operation" as const,
        _openapi: { summary: "Atomic increment on a numeric field", parameters: [classParam, idParam], requestBody: objectBody },
        handler: async (req: Request, ctx: any) => {
          const entries = Object.entries(await bodyOf(req) ?? {});
          if (entries.length !== 1) throw ZenithErrors.invalidQuery("Send exactly one field: {\"field\": amount}.");
          const [field, amount] = entries[0];
          return json(await traitApi.increment(p(ctx).className, p(ctx).objectId, field, amount as number, ctx));
        },
      },
      {
        method: "POST" as const, path: "/batch", access: "user", scope: "per-operation" as const,
        _openapi: { summary: "Run up to 50 operations in one request (not a transaction)" },
        handler: async (req: Request, ctx: any) => json(await traitApi.batch((await bodyOf(req))?.requests, ctx)),
      },
    ];

    return {
      "crud-routes": crud_routes,
      "crud": traitApi,
    };
  },
});
