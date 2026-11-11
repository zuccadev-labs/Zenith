/**
 * Parse Server-compatible Cloud Code: define/register functions, before/after triggers on collections, custom REST routes with security policies (Parse Server master key replacement via API keys).
 *
 * @barrits-trait
 * @barrits-summary ZenithCloudCode
 * @barrits-provides cloudcode-routes, cloud, triggers, cloud-functions
 * @barrits-consumes acl, db, schema
 * @barrits-state registeredFunctions, beforeFindTriggers, afterFindTriggers
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { fromFileUrl, toFileUrl } from "@std/path";
import type {
  CloudAfterFindHandler,
  CloudBeforeFindRequest,
  CloudFunctionRequest,
  CloudTriggerRequest,
} from "../../core/cloud.ts";
import { _cloudCodeRegistry } from "../../core/cloud.ts";

export interface CloudFunctionHandler {
  (request: CloudFunctionRequest, status?: (code: number, message: string) => never): unknown;
}

export interface CloudTriggerHandler {
  (request: CloudTriggerRequest): Promise<void> | void;
}

export interface CloudBeforeFindHandler {
  (request: CloudBeforeFindRequest): Promise<void> | void;
}

export interface FileTriggerSet {
  beforeWrite?: CloudTriggerHandler;
  afterWrite?: CloudTriggerHandler;
  beforeDelete?: CloudTriggerHandler;
  afterDelete?: CloudTriggerHandler;
}

export const CloudCodeTrait = createTraitDescriptor({
  name: "ZenithCloudCode",
  provides: ["cloudcode-routes", "cloud", "triggers", "cloud-functions"],
  consumes: ["acl", "db", "schema"],
  state: ["registeredFunctions", "beforeFindTriggers", "afterFindTriggers"],
  runtimes: ["deno"],
  summary:
    "Parse Server-compatible Cloud Code: define/register functions, before/after triggers on collections, custom REST routes with security policies (Parse Server master key replacement via API keys).",
  // deno-lint-ignore no-explicit-any
  create: (_deps: Record<string, any>) => {
    const registeredFunctions = new Map<string, CloudFunctionHandler>();
    const beforeSaveTriggers = new Map<string, CloudTriggerHandler[]>();
    const afterSaveTriggers = new Map<string, CloudTriggerHandler[]>();
    const beforeFindTriggers = new Map<string, CloudBeforeFindHandler[]>();
    const afterFindTriggers = new Map<string, CloudAfterFindHandler[]>();
    const beforeDeleteTriggers = new Map<string, CloudTriggerHandler[]>();
    const afterDeleteTriggers = new Map<string, CloudTriggerHandler[]>();
    const fileTriggers = new Map<string, FileTriggerSet>();
    const customRoutes = new Map<
      string,
      {
        method: string;
        path: string;
        handler: (req: Request, ctx: unknown) => Promise<Response>;
        security?: unknown;
      }
    >();

    type RouteHandler = (req: Request, ctx: unknown) => Promise<Response>;
    type SimpleHandler = (
      args: { params: Record<string, unknown>; query: Record<string, string> },
    ) => unknown;
    /** A plain handler gets { params, query } (params = JSON body on POST/PUT); its result, awaited, is the JSON reply. */
    const addRoute = (method: string, path: string, handler: unknown, security?: unknown) => {
      if (typeof handler !== "function") {
        throw new Error(`express.${method.toLowerCase()}(${path}): handler must be a function`);
      }
      const wrapped: RouteHandler = async (req: Request) => {
        const query = Object.fromEntries(new URL(req.url).searchParams);
        const params = method === "POST" || method === "PUT"
          ? await req.json().catch(() => ({}))
          : {};
        return Response.json(await (handler as SimpleHandler)({ params, query }));
      };
      return customRoutes.set(`${method} ${path}`, { method, path, handler: wrapped, security });
    };

    const traitApi = {
      define: (name: string, fn: CloudFunctionHandler) => {
        if (typeof name !== "string" || typeof fn !== "function") {
          throw new Error("define(name, fn): both required");
        }
        registeredFunctions.set(name, fn);
        return { name, registeredAt: new Date().toISOString() };
      },

      undefine: (name: string) => registeredFunctions.delete(name),

      run: async (
        name: string,
        params: Record<string, unknown>,
        context: Record<string, unknown> = {},
      ) => {
        const fn = registeredFunctions.get(name) ??
          _cloudCodeRegistry.getFunction(name)?.handler as CloudFunctionHandler | undefined;
        if (!fn) throw new Error(`cloud function not found: ${name}`);
        const request: CloudFunctionRequest = {
          params,
          user: context.user as { objectId: string; username?: string } | undefined,
          master: (context.master as boolean) || false,
          ip: context.ip as string | undefined,
          headers: (context.headers as Record<string, string>) || {},
          auth: context.auth as { userId: string; roles: string[] } | undefined,
          installationId: context.installationId as string | undefined,
          log: {
            info: (...args: unknown[]) => console.log(`[Cloud:${name}]`, ...args),
            error: (...args: unknown[]) => console.error(`[Cloud:${name}]`, ...args),
          },
        };
        return await fn(request, (code: number, message: string) => {
          throw Object.assign(new Error(message), { status: code });
        });
      },

      beforeSave: (className: string, fn: CloudTriggerHandler) => {
        if (!beforeSaveTriggers.has(className)) beforeSaveTriggers.set(className, []);
        beforeSaveTriggers.get(className)!.push(fn);
      },

      afterSave: (className: string, fn: CloudTriggerHandler) => {
        if (!afterSaveTriggers.has(className)) afterSaveTriggers.set(className, []);
        afterSaveTriggers.get(className)!.push(fn);
      },

      beforeFind: (className: string, fn: CloudBeforeFindHandler) => {
        if (!beforeFindTriggers.has(className)) beforeFindTriggers.set(className, []);
        beforeFindTriggers.get(className)!.push(fn);
      },

      afterFind: (className: string, fn: CloudAfterFindHandler) => {
        if (!afterFindTriggers.has(className)) afterFindTriggers.set(className, []);
        afterFindTriggers.get(className)!.push(fn);
      },

      beforeDelete: (className: string, fn: CloudTriggerHandler) => {
        if (!beforeDeleteTriggers.has(className)) beforeDeleteTriggers.set(className, []);
        beforeDeleteTriggers.get(className)!.push(fn);
      },

      afterDelete: (className: string, fn: CloudTriggerHandler) => {
        if (!afterDeleteTriggers.has(className)) afterDeleteTriggers.set(className, []);
        afterDeleteTriggers.get(className)!.push(fn);
      },

      beforeSaveFile: (fn: CloudTriggerHandler) => {
        fileTriggers.set("global", { ...(fileTriggers.get("global") || {}), beforeWrite: fn });
      },
      afterSaveFile: (fn: CloudTriggerHandler) => {
        fileTriggers.set("global", { ...(fileTriggers.get("global") || {}), afterWrite: fn });
      },
      beforeDeleteFile: (fn: CloudTriggerHandler) => {
        fileTriggers.set("global", { ...(fileTriggers.get("global") || {}), beforeDelete: fn });
      },
      afterDeleteFile: (fn: CloudTriggerHandler) => {
        fileTriggers.set("global", { ...(fileTriggers.get("global") || {}), afterDelete: fn });
      },

      express: {
        get: (path: string, handler: unknown, security?: unknown) =>
          addRoute("GET", path, handler, security),
        post: (path: string, handler: unknown, security?: unknown) =>
          addRoute("POST", path, handler, security),
        put: (path: string, handler: unknown, security?: unknown) =>
          addRoute("PUT", path, handler, security),
        delete: (path: string, handler: unknown, security?: unknown) =>
          addRoute("DELETE", path, handler, security),
      },

      listFunctions: () => {
        const traitFns = Array.from(registeredFunctions.keys());
        const globalFns = _cloudCodeRegistry.listFunctions();
        return Array.from(new Set([...traitFns, ...globalFns]));
      },

      runBeforeSave: async (className: string, request: CloudTriggerRequest) => {
        const triggers = beforeSaveTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runAfterSave: async (className: string, request: CloudTriggerRequest) => {
        const triggers = afterSaveTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runBeforeFind: async (className: string, request: CloudBeforeFindRequest) => {
        const triggers = beforeFindTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runAfterFind: async (
        className: string,
        request: {
          className: string;
          objects: Record<string, unknown>[];
          query: Record<string, unknown>;
        },
      ) => {
        const triggers = afterFindTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runBeforeDelete: async (className: string, request: CloudTriggerRequest) => {
        const triggers = beforeDeleteTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runAfterDelete: async (className: string, request: CloudTriggerRequest) => {
        const triggers = afterDeleteTriggers.get(className) || [];
        for (const fn of triggers) await fn(request);
      },

      runFileTrigger: async (
        phase: "beforeWrite" | "afterWrite" | "beforeDelete" | "afterDelete",
        request: CloudTriggerRequest,
      ) => {
        const triggers = fileTriggers.get("global");
        if (triggers && triggers[phase]) await triggers[phase]!(request);
      },

      loadCloudCode: async (cloudCodePath: string) => {
        // A path or a file:// URL: realPath only takes paths (a URL used to be reported "not found").
        const base = cloudCodePath.startsWith("file:") ? fromFileUrl(cloudCodePath) : cloudCodePath;
        const path = base.endsWith(".ts") ? base : `${base}/main.ts`;
        try {
          const resolved = await Deno.realPath(path);
          console.log(`[CloudCode] Loading cloud code from: ${resolved}`);
          await import(toFileUrl(resolved).href);
          const loaded = _cloudCodeRegistry.listFunctions();
          if (loaded.length > 0) {
            console.log(
              `[CloudCode] ✅ ${loaded.length} function(s) registered via global registry`,
            );
            for (const fn of loaded) {
              const entry = _cloudCodeRegistry.getFunction(fn);
              if (entry && !registeredFunctions.has(fn)) {
                registeredFunctions.set(fn, entry.handler as CloudFunctionHandler);
              }
            }
          }
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) {
            console.warn(`[CloudCode] ⚠️ Cloud code path '${cloudCodePath}' not found, skipping.`);
            return;
          }
          throw err;
        }
      },
    };

    const cloudcode_routes = [
      {
        method: "POST" as const,
        path: "/functions/:functionName",
        _openapi: {
          summary: "Execute a registered Cloud Code function",
          parameters: [{
            name: "functionName",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          requestBody: {
            content: {
              "application/json": { schema: { type: "object", additionalProperties: true } },
            },
          },
        },
        handler: async (
          req: Request,
          ctx: {
            user?: { objectId: string; username?: string };
            apiKey?: { master?: boolean };
            master?: boolean;
          },
        ) => {
          const url = new URL(req.url);
          const functionName = url.pathname.split("/").pop();
          const body = await req.json().catch(() => ({}));
          try {
            const result = await traitApi.run(functionName!, body, {
              user: ctx?.user,
              master: ctx?.apiKey?.master || ctx?.master,
              ip: req.headers.get("x-forwarded-for"),
              headers: Object.fromEntries(req.headers),
            });
            return new Response(JSON.stringify({ result }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          } catch (e: unknown) {
            const err = e as { status?: number; message: string };
            const status = err.status || 500;
            return new Response(JSON.stringify({ code: status, error: err.message }), {
              status,
              headers: { "content-type": "application/json" },
            });
          }
        },
      },
      {
        method: "GET" as const,
        path: "/functions",
        _openapi: { summary: "List all registered Cloud Code functions" },
        handler: async () =>
          new Response(JSON.stringify({ functions: traitApi.listFunctions() }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
      {
        method: "POST" as const,
        path: "/jobs/:jobName",
        _openapi: {
          summary: "Enqueue a background job",
          parameters: [{ name: "jobName", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: {
              "application/json": { schema: { type: "object", additionalProperties: true } },
            },
          },
        },
        handler: async (req: Request) => {
          const jobName = new URL(req.url).pathname.split("/").pop();
          const body = await req.json().catch(() => ({}));
          if (!traitApi.listFunctions().includes(jobName!)) {
            return new Response(JSON.stringify({ error: `job not found: ${jobName}` }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          const jobId = crypto.randomUUID();
          setTimeout(async () => {
            try {
              await traitApi.run(jobName!, body, { master: true });
            } catch { /* noop: background job */ }
          }, 0);
          return new Response(JSON.stringify({ jobId, status: "queued" }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        },
      },
    ];

    return {
      "cloudcode-routes": cloudcode_routes,
      "cloud": traitApi,
      "triggers": {
        runBeforeSave: traitApi.runBeforeSave,
        runAfterSave: traitApi.runAfterSave,
        runBeforeFind: traitApi.runBeforeFind,
        runAfterFind: traitApi.runAfterFind,
        runBeforeDelete: traitApi.runBeforeDelete,
        runAfterDelete: traitApi.runAfterDelete,
        runFileTrigger: traitApi.runFileTrigger,
      },
      "cloud-functions": {
        loadCloudCode: traitApi.loadCloudCode,
      },
    };
  },
});
