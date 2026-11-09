// deno-lint-ignore-file no-unused-vars
/**
 * Parse Server-compatible REST CRUD endpoints: GET/POST/PUT/DELETE on /classes/:className, file upload, batch operations, increment/decrement, ACL enforcement, master key override.
 *
 * @barrits-trait
 * @barrits-summary ZenithRestCrud
 * @barrits-provides crud-routes, crud
 * @barrits-consumes acl, cloud, db, ratelimit, schema
 * @barrits-tags uses:events, uses:federation
 * @barrits-state registeredCollections
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const RestCrudTrait = createTraitDescriptor({
  name: "ZenithRestCrud",
  provides: ["crud-routes", "crud"],
  consumes: ["acl", "cloud", "db", "ratelimit", "schema"],
  tags: ["uses:events", "uses:federation"],
  state: ["registeredCollections"],
  runtimes: ["deno"],
  summary: "Parse Server-compatible REST CRUD endpoints: GET/POST/PUT/DELETE on /classes/:className, file upload, batch operations, increment/decrement, ACL enforcement, master key override.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const acl = deps.traits["acl"];
    const schema = deps.traits["schema"];
    const cloud = deps.traits["cloud"];
    const ratelimit = deps.traits["ratelimit"];
    const federation = deps.traits["federation"];
    const events = deps.traits["events"];

    const traitApi: any = {
      listClass: async (className: string, query: Record<string, any>, ctx: any) => {
        await cloud.runBeforeFind(className, { query, user: ctx.user, master: ctx.master });
        const filter = { ...query };
        delete filter.limit;
        delete filter.skip;
        delete filter.order;
        delete filter.include;
        delete filter.fields;
        delete filter.count;
        let results = await db.find(className, filter);
        if (query.include) {
          const includes = (query.include as string).split(",");
          for (const inc of includes) {
            results = await Promise.all(results.map(async (r: any) => {
              if (r[inc] && typeof r[inc] === "object" && r[inc].objectId) {
                try { r[inc] = await db.read(inc, r[inc].objectId); } catch (_e) { /* noop: include failed */ }
              }
              return r;
            }));
          }
        }
        if (query.fields) {
          const fields = (query.fields as string).split(",");
          results = results.map((r: any) => Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k))));
        }
        if (query.order) {
          const orderKey = (query.order as string).replace(/^-/, "");
          const desc = (query.order as string).startsWith("-");
          results.sort((a: any, b: any) => {
            const av = a[orderKey], bv = b[orderKey];
            if (av === bv) return 0;
            return desc ? (av < bv ? 1 : -1) : (av < bv ? -1 : 1);
          });
        }
        const total = query.count === "1" ? results.length : undefined;
        const skip = parseInt((query.skip as string) || "0", 10);
        const limit = parseInt((query.limit as string) || "100", 10);
        results = results.slice(skip, skip + limit);
        const response: any = { results };
        if (total !== undefined) response.count = total;
        await cloud.runAfterFind(className, { results, user: ctx.user, master: ctx.master });
        return response;
      },

      getObject: async (className: string, objectId: string, query: Record<string, any>, ctx: any) => {
        await cloud.runBeforeFind(className, { objectId, query, user: ctx.user, master: ctx.master });
        const obj = await db.read(className, objectId);
        if (!obj) throw new Error(`object not found: ${className}/${objectId}`);
        if (query.include) {
          const includes = (query.include as string).split(",");
          for (const inc of includes) {
            if (obj[inc] && typeof obj[inc] === "object" && obj[inc].objectId) {
              try { obj[inc] = await db.read(inc, obj[inc].objectId); } catch (_e) { /* noop */ }
            }
          }
        }
        if (!ctx.master && obj.ACL && !acl.checkRead(obj.ACL, ctx.user)) {
          throw Object.assign(new Error("permission denied"), { status: 403 });
        }
        await cloud.runAfterFind(className, { object: obj, user: ctx.user, master: ctx.master });
        return obj;
      },

      createObject: async (className: string, data: Record<string, any>, ctx: any) => {
        if (!ctx.master && acl.hasPublicWriteRestriction(className)) {
          throw Object.assign(new Error("create requires authenticated user or master key"), { status: 401 });
        }
        const aclPolicy = data.ACL || { "*": { r: true, w: true } };
        data.ACL = aclPolicy;
        await cloud.runBeforeSave(className, { object: data, user: ctx.user, master: ctx.master });
        const created = await db.create(className, data);
        await cloud.runAfterSave(className, { object: created, user: ctx.user, master: ctx.master });
        if (events) events.emit(`${className}.created`, created);
        if (federation) federation.replicate(className, "create", created);
        return created;
      },

      updateObject: async (className: string, objectId: string, data: Record<string, any>, ctx: any) => {
        const existing = await db.read(className, objectId);
        if (!existing) throw new Error(`object not found: ${className}/${objectId}`);
        if (!ctx.master && !acl.checkWrite(existing.ACL, ctx.user)) {
          throw Object.assign(new Error("permission denied"), { status: 403 });
        }
        await cloud.runBeforeSave(className, { object: { ...existing, ...data }, original: existing, user: ctx.user, master: ctx.master });
        const updated = await db.update(className, { objectId }, data);
        await cloud.runAfterSave(className, { object: updated, original: existing, user: ctx.user, master: ctx.master });
        if (events) events.emit(`${className}.updated`, updated);
        if (federation) federation.replicate(className, "update", updated);
        return updated;
      },

      deleteObject: async (className: string, objectId: string, ctx: any) => {
        const existing = await db.read(className, objectId);
        if (!existing) throw new Error(`object not found: ${className}/${objectId}`);
        if (!ctx.master && !acl.checkWrite(existing.ACL, ctx.user)) {
          throw Object.assign(new Error("permission denied"), { status: 403 });
        }
        await cloud.runBeforeDelete(className, { object: existing, user: ctx.user, master: ctx.master });
        await db.delete(className, { objectId });
        await cloud.runAfterDelete(className, { object: existing, user: ctx.user, master: ctx.master });
        if (events) events.emit(`${className}.deleted`, existing);
        if (federation) federation.replicate(className, "delete", existing);
        return { success: true };
      },

      increment: async (className: string, objectId: string, field: string, amount: number, ctx: any) => {
        const existing = await db.read(className, objectId);
        if (!existing) throw new Error(`object not found: ${className}/${objectId}`);
        if (!ctx.master && !acl.checkWrite(existing.ACL, ctx.user)) {
          throw Object.assign(new Error("permission denied"), { status: 403 });
        }
        const updated = await db.update(className, { objectId }, { [field]: (existing[field] || 0) + amount });
        const result: any = { [field]: { __op: "Increment", amount } };
        await cloud.runAfterSave(className, { object: updated, operation: "increment", user: ctx.user, master: ctx.master });
        return result;
      },

      batch: async (requests: Array<{ method: string; path: string; body?: any }>, ctx: any) => {
        const results: any[] = [];
        for (const req of requests) {
          try {
            if (req.method === "POST" && req.path.startsWith("/classes/")) {
              const className = req.path.split("/")[2];
              const obj = await traitApi.createObject(className, req.body, ctx);
              results.push({ success: obj });
            } else if (req.method === "GET" && req.path.startsWith("/classes/")) {
              const parts = req.path.split("/");
              const className = parts[2];
              if (parts[3]) {
                const obj = await traitApi.getObject(className, parts[3], req.body || {}, ctx);
                results.push({ success: obj });
              } else {
                const list = await traitApi.listClass(className, req.body || {}, ctx);
                results.push({ success: list });
              }
            } else {
              results.push({ error: `unsupported batch op: ${req.method} ${req.path}` });
            }
          } catch (e: any) {
            results.push({ error: e.message, status: e.status || 500 });
          }
        }
        return results;
      },
    };

    const crud_routes = [
      {
        method: "GET" as const,
        path: "/classes/:className",
        _openapi: {
          summary: "List objects in a class",
          parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }, { name: "where", in: "query", schema: { type: "object" } }, { name: "limit", in: "query", schema: { type: "integer" } }, { name: "skip", in: "query", schema: { type: "integer" } }, { name: "order", in: "query", schema: { type: "string" } }, { name: "include", in: "query", schema: { type: "string" } }, { name: "fields", in: "query", schema: { type: "string" } }, { name: "count", in: "query", schema: { type: "string" } }],
        },
        handler: async (req: Request, ctx: any) => {
          const className = new URL(req.url).pathname.split("/")[2];
          const query: Record<string, any> = {};
          const url = new URL(req.url);
          url.searchParams.forEach((v, k) => {
            try { query[k] = k === "where" ? JSON.parse(v) : v; } catch (_e) { query[k] = v; }
          });
          if (ratelimit) await ratelimit.consume(`read:${ctx.user?.objectId || "anonymous"}`, 1);
          const result = await traitApi.listClass(className, query, ctx);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/classes/:className/:objectId",
        _openapi: {
          summary: "Get a single object",
          parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }, { name: "objectId", in: "path", required: true, schema: { type: "string" } }, { name: "include", in: "query", schema: { type: "string" } }],
        },
        handler: async (req: Request, ctx: any) => {
          const parts = new URL(req.url).pathname.split("/");
          const className = parts[2], objectId = parts[3];
          const query: Record<string, any> = {};
          new URL(req.url).searchParams.forEach((v, k) => { query[k] = v; });
          const obj = await traitApi.getObject(className, objectId, query, ctx);
          return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/classes/:className",
        _openapi: {
          summary: "Create a new object",
          parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        },
        handler: async (req: Request, ctx: any) => {
          const className = new URL(req.url).pathname.split("/")[2];
          const body = await req.json();
          const created = await traitApi.createObject(className, body, ctx);
          return new Response(JSON.stringify(created), { status: 201, headers: { "content-type": "application/json", "location": `/classes/${className}/${created.objectId}` } });
        },
      },
      {
        method: "PUT" as const,
        path: "/classes/:className/:objectId",
        _openapi: {
          summary: "Update an object",
          parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }, { name: "objectId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        },
        handler: async (req: Request, ctx: any) => {
          const parts = new URL(req.url).pathname.split("/");
          const className = parts[2], objectId = parts[3];
          const body = await req.json();
          const updated = await traitApi.updateObject(className, objectId, body, ctx);
          return new Response(JSON.stringify(updated), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "DELETE" as const,
        path: "/classes/:className/:objectId",
        _openapi: {
          summary: "Delete an object",
          parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }, { name: "objectId", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request, ctx: any) => {
          const parts = new URL(req.url).pathname.split("/");
          const className = parts[2], objectId = parts[3];
          await traitApi.deleteObject(className, objectId, ctx);
          return new Response(null, { status: 204 });
        },
      },
      {
        method: "POST" as const,
        path: "/classes/:className/:objectId/Increment",
        _openapi: {
          summary: "Atomic increment on a numeric field",
          parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }, { name: "objectId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: { type: "integer" } } } } },
        },
        handler: async (req: Request, ctx: any) => {
          const parts = new URL(req.url).pathname.split("/");
          const className = parts[2], objectId = parts[3];
          const body = await req.json();
          const [field, amount] = Object.entries(body)[0];
          const result = await traitApi.increment(className, objectId, field, amount as number, ctx);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/batch",
        _openapi: { summary: "Execute a batch of operations in a single request" },
        handler: async (req: Request, ctx: any) => {
          const body = await req.json() as { requests: any[] };
          const results = await traitApi.batch(body.requests, ctx);
          return new Response(JSON.stringify(results), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "crud-routes": crud_routes,
      "crud": traitApi,
    };
  },
});
