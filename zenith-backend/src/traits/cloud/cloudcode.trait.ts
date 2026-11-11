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
import type { CloudValidator } from "../../core/cloud.ts";
import { _cloudCodeRegistry } from "../../core/cloud.ts";
import { denied } from "../../core/router.ts";
import {
  checkValidator,
  CloudValidationError,
  functionAccess,
  triggerFailure,
} from "./validator.ts";
import { runRegistryTrigger, type TriggerRequest, validateTrigger } from "./registry-triggers.ts";

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
    const registeredFunctions = new Map<
      string,
      { fn: CloudFunctionHandler; validator?: CloudValidator }
    >();
    /** A function defined on this trait, or else through Zen.Cloud (the global registry, also in compiled apps). */
    const functionEntry = (name: string) => {
      const local = registeredFunctions.get(name);
      if (local) return local;
      const global = _cloudCodeRegistry.getFunction(name);
      return global
        ? { fn: global.handler as CloudFunctionHandler, validator: global.validator }
        : undefined;
    };
    type Category =
      | "beforeSave"
      | "afterSave"
      | "beforeFind"
      | "afterFind"
      | "beforeDelete"
      | "afterDelete";
    type AnyRequest = TriggerRequest;
    const validate = validateTrigger;
    /** Wraps a handler so its validator runs first. */
    const guarded = <F extends (r: AnyRequest) => unknown>(
      category: Category,
      fn: F,
      v?: CloudValidator,
    ) => (v
      ? (async (r: AnyRequest) => (await validate(v, category, r), fn(r))) as unknown as F
      : fn);
    /**
     * Triggers registered with Zen.Cloud.beforeSave() & co. live in the global registry (registry-triggers.ts).
     * Before, nothing read it: they never ran. They run first, then the trait's.
     */
    const runGlobal = async (category: Category, className: string, r: AnyRequest) => {
      const request = category === "afterFind"
        ? { ...r, objects: r.results ?? (r.object ? [r.object] : []) }
        : r;
      const { out } = await runRegistryTrigger(category, className, request);
      // afterFind may return the objects to answer with (Parse Server): they replace the results.
      if (category === "afterFind" && Array.isArray(out)) {
        if (Array.isArray(r.results)) r.results.splice(0, r.results.length, ...out);
        else if (r.object && out[0] && typeof out[0] === "object") {
          for (const k of Object.keys(r.object)) delete r.object[k];
          Object.assign(r.object, out[0]);
        }
      }
    };
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
      define: (name: string, fn: CloudFunctionHandler, validator?: CloudValidator) => {
        if (typeof name !== "string" || typeof fn !== "function") {
          throw new Error("define(name, fn): both required");
        }
        registeredFunctions.set(name, { fn, validator });
        return { name, registeredAt: new Date().toISOString() };
      },

      undefine: (name: string) => registeredFunctions.delete(name),

      run: async (
        name: string,
        params: Record<string, unknown>,
        context: Record<string, unknown> = {},
      ) => {
        const entry = functionEntry(name);
        if (!entry) {
          throw Object.assign(new Error(`Invalid function: "${name}"`), { code: 141 });
        }
        const fn = entry.fn;
        // A copy: defaults set by the validator must not leak into the caller's object.
        params = { ...params };
        await checkValidator(entry.validator, {
          master: (context.master as boolean) || false,
          user: context.user as { objectId: string; roles?: string[] } | undefined,
          apiKey: !!context.apiKey,
        }, params);
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
        // response.error(code, message), Parse style: a Parse error code, not an HTTP status.
        return await fn(request, (code: number, message: string) => {
          throw Object.assign(new Error(message), { code });
        });
      },

      beforeSave: (className: string, fn: CloudTriggerHandler, validator?: CloudValidator) => {
        if (!beforeSaveTriggers.has(className)) beforeSaveTriggers.set(className, []);
        // deno-lint-ignore no-explicit-any
        beforeSaveTriggers.get(className)!.push(guarded("beforeSave", fn as any, validator) as any);
      },

      afterSave: (className: string, fn: CloudTriggerHandler, validator?: CloudValidator) => {
        if (!afterSaveTriggers.has(className)) afterSaveTriggers.set(className, []);
        // deno-lint-ignore no-explicit-any
        afterSaveTriggers.get(className)!.push(guarded("afterSave", fn as any, validator) as any);
      },

      beforeFind: (className: string, fn: CloudBeforeFindHandler, validator?: CloudValidator) => {
        if (!beforeFindTriggers.has(className)) beforeFindTriggers.set(className, []);
        // deno-lint-ignore no-explicit-any
        beforeFindTriggers.get(className)!.push(guarded("beforeFind", fn as any, validator) as any);
      },

      afterFind: (className: string, fn: CloudAfterFindHandler, validator?: CloudValidator) => {
        if (!afterFindTriggers.has(className)) afterFindTriggers.set(className, []);
        // deno-lint-ignore no-explicit-any
        afterFindTriggers.get(className)!.push(guarded("afterFind", fn as any, validator) as any);
      },

      beforeDelete: (className: string, fn: CloudTriggerHandler, validator?: CloudValidator) => {
        if (!beforeDeleteTriggers.has(className)) beforeDeleteTriggers.set(className, []);
        // deno-lint-ignore no-explicit-any
        beforeDeleteTriggers.get(className)!.push(
          guarded("beforeDelete", fn as any, validator) as any,
        );
      },

      afterDelete: (className: string, fn: CloudTriggerHandler, validator?: CloudValidator) => {
        if (!afterDeleteTriggers.has(className)) afterDeleteTriggers.set(className, []);
        // deno-lint-ignore no-explicit-any
        afterDeleteTriggers.get(className)!.push(
          guarded("afterDelete", fn as any, validator) as any,
        );
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
        try {
          await runGlobal("beforeSave", className, request as AnyRequest);
          const triggers = beforeSaveTriggers.get(className) || [];
          for (const fn of triggers) await fn(request);
        } catch (e) {
          throw triggerFailure(e);
        }
      },

      runAfterSave: async (className: string, request: CloudTriggerRequest) => {
        // The object is already saved: a failing afterSave is logged, not returned (Parse Server).
        try {
          await runGlobal("afterSave", className, request as AnyRequest);
          const triggers = afterSaveTriggers.get(className) || [];
          for (const fn of triggers) await fn(request);
        } catch (e) {
          console.error(`[Cloud:afterSave:${className}]`, (e as Error)?.message ?? e);
        }
      },

      runBeforeFind: async (className: string, request: CloudBeforeFindRequest) => {
        try {
          await runGlobal("beforeFind", className, request as AnyRequest);
          const triggers = beforeFindTriggers.get(className) || [];
          for (const fn of triggers) await fn(request);
        } catch (e) {
          throw triggerFailure(e);
        }
      },

      runAfterFind: async (
        className: string,
        request: {
          className: string;
          objects: Record<string, unknown>[];
          query: Record<string, unknown>;
        },
      ) => {
        try {
          await runGlobal("afterFind", className, request as AnyRequest);
          const triggers = afterFindTriggers.get(className) || [];
          for (const fn of triggers) await fn(request);
        } catch (e) {
          throw triggerFailure(e);
        }
      },

      runBeforeDelete: async (className: string, request: CloudTriggerRequest) => {
        try {
          await runGlobal("beforeDelete", className, request as AnyRequest);
          const triggers = beforeDeleteTriggers.get(className) || [];
          for (const fn of triggers) await fn(request);
        } catch (e) {
          throw triggerFailure(e);
        }
      },

      runAfterDelete: async (className: string, request: CloudTriggerRequest) => {
        // The object is already saved: a failing afterDelete is logged, not returned (Parse Server).
        try {
          await runGlobal("afterDelete", className, request as AnyRequest);
          const triggers = afterDeleteTriggers.get(className) || [];
          for (const fn of triggers) await fn(request);
        } catch (e) {
          console.error(`[Cloud:afterDelete:${className}]`, (e as Error)?.message ?? e);
        }
      },

      runFileTrigger: async (
        phase: "beforeWrite" | "afterWrite" | "beforeDelete" | "afterDelete",
        request: CloudTriggerRequest,
      ) => {
        const category = ({
          beforeWrite: "beforeSaveFile",
          afterWrite: "afterSaveFile",
          beforeDelete: "beforeDeleteFile",
          afterDelete: "afterDeleteFile",
        } as const)[phase];
        try {
          await runRegistryTrigger(category, "_File", request as AnyRequest);
          const triggers = fileTriggers.get("global");
          if (triggers && triggers[phase]) await triggers[phase]!(request);
        } catch (e) {
          // As for objects: a before* refusal reaches the client (142); an after* failure is logged.
          if (phase.startsWith("before")) throw triggerFailure(e);
          console.error(`[Cloud:${category}]`, (e as Error)?.message ?? e);
        }
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
                registeredFunctions.set(fn, {
                  fn: entry.handler as CloudFunctionHandler,
                  validator: entry.validator,
                });
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
        // Who may call it is decided per function (validator.ts, functionAccess): master-only unless its
        // validator opens it. API keys need functions:invoke for functions open to users.
        access: "public" as const,
        handler: async (
          req: Request,
          // deno-lint-ignore no-explicit-any
          ctx: any,
        ) => {
          const functionName = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
          const entry = functionEntry(functionName);
          // An unknown function answers like a master-only one: a caller without the master key cannot tell
          // which functions exist.
          const refusal = denied(functionAccess(entry?.validator), ctx ?? {}, "functions:invoke");
          if (refusal) return refusal;
          const body = await req.json().catch(() => ({}));
          const json = (status: number, payload: unknown) =>
            new Response(JSON.stringify(payload), {
              status,
              headers: { "content-type": "application/json" },
            });
          try {
            const result = await traitApi.run(functionName, body, {
              user: ctx?.user,
              master: ctx?.master === true || ctx?.masterKey === true,
              apiKey: !!ctx?.apiKey && !ctx?.user,
              ip: ctx?.clientIp,
              headers: Object.fromEntries(req.headers),
            });
            return json(200, { result });
          } catch (e: unknown) {
            // Parse Server: HTTP 400 with the Parse error code (142 validation, 141 script failed or unknown
            // function, or whatever code the function chose with response.error). Before, the code was used as
            // the HTTP status, and new Response() throws for 141.
            const err = e as { code?: number; message?: string };
            if (e instanceof CloudValidationError) {
              return json(400, { code: e.code, error: e.message });
            }
            const code = Number.isInteger(err.code) ? err.code! : 141;
            return json(400, { code, error: err.message ?? "Cloud function failed." });
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
