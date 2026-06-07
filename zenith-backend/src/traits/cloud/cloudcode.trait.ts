// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const CloudCodeTrait = createTraitDescriptor({
  name: "ZenithCloudCode",
  provides: ["cloudcode-routes", "cloud", "triggers"],
  consumes: ["db", "acl", "schema", "webhook", "telemetry"],
  state: ["registeredFunctions", "beforeFindTriggers", "afterFindTriggers"],
  runtimes: ["deno"],
  summary: "Parse Server-compatible Cloud Code: define/register functions, before/after triggers on collections, custom REST routes with security policies (Parse Server master key replacement via API keys).",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const acl = deps["acl"];
    const schema = deps["schema"];
    const webhook = deps["webhook"];

    const registeredFunctions = new Map<string, (request: any, status?: any) => any>();
    const beforeSaveTriggers = new Map<string, Array<(request: any) => any>>();
    const afterSaveTriggers = new Map<string, Array<(request: any) => any>>();
    const beforeFindTriggers = new Map<string, Array<(request: any) => any>>();
    const afterFindTriggers = new Map<string, Array<(request: any) => any>>();
    const beforeDeleteTriggers = new Map<string, Array<(request: any) => any>>();
    const afterDeleteTriggers = new Map<string, Array<(request: any) => any>>();
    const fileTriggers = new Map<string, { beforeWrite?: (request: any) => any; afterWrite?: (request: any) => any; beforeDelete?: (request: any) => any; afterDelete?: (request: any) => any }>();
    const customRoutes = new Map<string, { method: string; path: string; handler: (req: Request, ctx: any) => Promise<Response>; security?: any }>();

    const traitApi: any = {
      define: (name: string, fn: (request: any) => any) => {
        if (typeof name !== "string" || typeof fn !== "function") throw new Error("define(name, fn): both required");
        registeredFunctions.set(name, fn);
        return { name, registeredAt: new Date().toISOString() };
      },

      undefine: (name: string) => registeredFunctions.delete(name),

      run: async (name: string, params: Record<string, any>, context: any = {}) => {
        const fn = registeredFunctions.get(name);
        if (!fn) throw new Error(`cloud function not found: ${name}`);
        const request = { params, user: context.user, master: context.master || false, ip: context.ip, headers: context.headers, log: (...args: any[]) => console.log(`[Cloud:${name}]`, ...args), error: (...args: any[]) => console.error(`[Cloud:${name}]`, ...args) };
        return await fn(request, (code: number, message: string) => { throw Object.assign(new Error(message), { status: code }); });
      },

      beforeSave: (className: string, fn: (request: any) => any) => {
        if (!beforeSaveTriggers.has(className)) beforeSaveTriggers.set(className, []);
        beforeSaveTriggers.get(className)!.push(fn);
      },

      afterSave: (className: string, fn: (request: any) => any) => {
        if (!afterSaveTriggers.has(className)) afterSaveTriggers.set(className, []);
        afterSaveTriggers.get(className)!.push(fn);
      },

      beforeFind: (className: string, fn: (request: any) => any) => {
        if (!beforeFindTriggers.has(className)) beforeFindTriggers.set(className, []);
        beforeFindTriggers.get(className)!.push(fn);
      },

      afterFind: (className: string, fn: (request: any) => any) => {
        if (!afterFindTriggers.has(className)) afterFindTriggers.set(className, []);
        afterFindTriggers.get(className)!.push(fn);
      },

      beforeDelete: (className: string, fn: (request: any) => any) => {
        if (!beforeDeleteTriggers.has(className)) beforeDeleteTriggers.set(className, []);
        beforeDeleteTriggers.get(className)!.push(fn);
      },

      afterDelete: (className: string, fn: (request: any) => any) => {
        if (!afterDeleteTriggers.has(className)) afterDeleteTriggers.set(className, []);
        afterDeleteTriggers.get(className)!.push(fn);
      },

      beforeSaveFile: (fn: (request: any) => any) => { fileTriggers.set("global", { ...(fileTriggers.get("global") || {}), beforeWrite: fn }); },
      afterSaveFile: (fn: (request: any) => any) => { fileTriggers.set("global", { ...(fileTriggers.get("global") || {}), afterWrite: fn }); },
      beforeDeleteFile: (fn: (request: any) => any) => { fileTriggers.set("global", { ...(fileTriggers.get("global") || {}), beforeDelete: fn }); },
      afterDeleteFile: (fn: (request: any) => any) => { fileTriggers.set("global", { ...(fileTriggers.get("global") || {}), afterDelete: fn }); },

      express: {
        get: (path: string, handler: any, security?: any) => customRoutes.set(`GET ${path}`, { method: "GET", path, handler: typeof handler === "function" ? (req: Request) => new Response(JSON.stringify(handler({ params: {}, query: Object.fromEntries(new URL(req.url).searchParams) }))) : handler, security }),
        post: (path: string, handler: any, security?: any) => customRoutes.set(`POST ${path}`, { method: "POST", path, handler: typeof handler === "function" ? async (req: Request) => { const body = await req.json().catch(() => ({})); return new Response(JSON.stringify(handler({ params: body, query: Object.fromEntries(new URL(req.url).searchParams) }))); } : handler, security }),
        put: (path: string, handler: any, security?: any) => customRoutes.set(`PUT ${path}`, { method: "PUT", path, handler: typeof handler === "function" ? async (req: Request) => { const body = await req.json().catch(() => ({})); return new Response(JSON.stringify(handler({ params: body, query: Object.fromEntries(new URL(req.url).searchParams) }))); } : handler, security }),
        delete: (path: string, handler: any, security?: any) => customRoutes.set(`DELETE ${path}`, { method: "DELETE", path, handler: typeof handler === "function" ? (req: Request) => new Response(JSON.stringify(handler({ params: {}, query: Object.fromEntries(new URL(req.url).searchParams) }))) : handler, security }),
      },

      listFunctions: () => Array.from(registeredFunctions.keys()),

      runBeforeSave: async (className: string, request: any) => {
        const triggers = beforeSaveTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runAfterSave: async (className: string, request: any) => {
        const triggers = afterSaveTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runBeforeFind: async (className: string, request: any) => {
        const triggers = beforeFindTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runAfterFind: async (className: string, request: any) => {
        const triggers = afterFindTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runBeforeDelete: async (className: string, request: any) => {
        const triggers = beforeDeleteTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runAfterDelete: async (className: string, request: any) => {
        const triggers = afterDeleteTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runFileTrigger: async (phase: "beforeWrite" | "afterWrite" | "beforeDelete" | "afterDelete", request: any) => {
        const triggers = fileTriggers.get("global");
        if (triggers && triggers[phase]) await triggers[phase]!(request);
      },
    };

    const cloudcode_routes = [
      {
        method: "POST" as const,
        path: "/functions/:functionName",
        _openapi: {
          summary: "Execute a registered Cloud Code function",
          parameters: [{ name: "functionName", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        },
        handler: async (req: Request, ctx: any) => {
          const url = new URL(req.url);
          const functionName = url.pathname.split("/").pop();
          const body = await req.json().catch(() => ({}));
          try {
            const result = await traitApi.run(functionName!, body, { user: ctx?.user, master: ctx?.apiKey?.master || ctx?.master, ip: req.headers.get("x-forwarded-for"), headers: Object.fromEntries(req.headers) });
            return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
          } catch (e: any) {
            const status = e.status || 500;
            return new Response(JSON.stringify({ code: status, error: e.message }), { status, headers: { "content-type": "application/json" } });
          }
        },
      },
      {
        method: "GET" as const,
        path: "/functions",
        _openapi: { summary: "List all registered Cloud Code functions" },
        handler: async () => new Response(JSON.stringify({ functions: traitApi.listFunctions() }), { status: 200, headers: { "content-type": "application/json" } }),
      },
      {
        method: "POST" as const,
        path: "/jobs/:jobName",
        _openapi: {
          summary: "Enqueue a background job",
          parameters: [{ name: "jobName", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        },
        handler: async (req: Request) => {
          const jobName = new URL(req.url).pathname.split("/").pop();
          const body = await req.json().catch(() => ({}));
          if (!registeredFunctions.has(jobName!)) return new Response(JSON.stringify({ error: `job not found: ${jobName}` }), { status: 404, headers: { "content-type": "application/json" } });
          const jobId = crypto.randomUUID();
          setTimeout(async () => {
            try { await traitApi.run(jobName!, body, { master: true }); } catch (_e) { /* noop: background job */ }
          }, 0);
          return new Response(JSON.stringify({ jobId, status: "queued" }), { status: 202, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "cloudcode-routes": cloudcode_routes,
      "cloud": traitApi,
      "triggers": { runBeforeSave: traitApi.runBeforeSave, runAfterSave: traitApi.runAfterSave, runBeforeFind: traitApi.runBeforeFind, runAfterFind: traitApi.runAfterFind, runBeforeDelete: traitApi.runBeforeDelete, runAfterDelete: traitApi.runAfterDelete, runFileTrigger: traitApi.runFileTrigger },
    };
  },
});
