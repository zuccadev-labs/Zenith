/**
 * Cloud Code Hooks compatibles con Parse Server (`/hooks/functions`, `/hooks/triggers`): una función de
 * Cloud Code o un trigger de una clase se resuelve llamando a una URL externa. Es RPC síncrona en el
 * camino de la petición; los webhooks de eventos asíncronos son la pieza `webhooks`.
 *
 * Igual que Parse Server (`HooksRouter`, `HooksController`):
 * - **API solo con master key:**
 *   - `GET` y `POST` en `/hooks/functions` y `/hooks/triggers`;
 *   - `GET` y `PUT` en `/hooks/functions/:functionName` y en `/hooks/triggers/:className/:triggerName`;
 *   - `PUT` con `{ "__op": "Delete" }` borra.
 * - **Errores Parse 143:** `invalid hook declaration`, `no function named: X is defined`,
 *   `class X already has trigger Y`.
 * - **Almacén:** clase `_Hooks` (`functionName`, `className`, `triggerName`, `url`).
 * - **Llamada:** `POST` con JSON. La respuesta `{ success }` es el resultado y `{ error }` falla. En
 *   `beforeSave`, un `success` objeto sustituye los campos del objeto, salvo `createdAt`, `updatedAt` y
 *   `className`. Un estado no 2xx falla.
 * - **Cabecera `X-Parse-Webhook-Key`:** con `PARSE_SERVER_WEBHOOK_KEY` o `ZENITH_WEBHOOK_KEY`.
 *
 * Mejoras sobre Parse Server:
 * - **Firma Standard Webhooks** (`webhook-id`, `webhook-timestamp`, `webhook-signature`) si se configura
 *   `ZENITH_HOOKS_SECRET` (`whsec_…`): la clave estática de Parse viaja en claro y no protege contra
 *   reenvíos.
 * - **Cliente saliente seguro** (`security/outbound-http.ts`): solo https, sin destinos privados ni de
 *   metadatos, sin redirecciones y con 15 s de límite. Parse no pone límite de tiempo.
 * - **Sin credenciales:** no se reenvían las cabeceras del cliente y el cuerpo sale sin credenciales
 *   (`security/sanitize.ts`).
 * - **Función original:** borrar el hook de una función restaura la de `cloud/main.ts` que
 *   sustituía, porque vuelve a resolverse desde el registro global de Cloud Code.
 * - **Triggers after\*:** si el hook falla, se registra y no se deshace la operación ya hecha. Los
 *   before\* sí la detienen.
 *
 * @barrits-trait
 * @barrits-summary ZenithCloudHooks
 * @barrits-provides hooks_routes, cloudHooks
 * @barrits-consumes cloud, db
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithError, ZenithErrorCode } from "../../core/errors.ts";
import { randomBytes, toBase64Url } from "../../core/crypto.ts";
import { checkOutboundUrl, type OutboundPolicy, safeFetch } from "../../security/outbound-http.ts";
import { sanitizePayload } from "../../security/sanitize.ts";
import { webhookHeaders } from "../../security/webhook-signature.ts";

export const HOOKS_CLASS = "_Hooks";
/** Triggers que Zenith ejecuta (los de `cloudcode.trait.ts`). */
export const HOOK_TRIGGERS = [
  "beforeSave",
  "afterSave",
  "beforeDelete",
  "afterDelete",
  "beforeFind",
  "afterFind",
] as const;
type TriggerName = typeof HOOK_TRIGGERS[number];

const hookError = (message: string) => new ZenithError(ZenithErrorCode.WEBHOOK_ERROR, message, 400);
const INVALID = "invalid hook declaration";

function envOf(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

export interface CloudHooksOptions {
  readonly policy?: OutboundPolicy;
  /** `X-Parse-Webhook-Key`. Por defecto, `PARSE_SERVER_WEBHOOK_KEY` o `ZENITH_WEBHOOK_KEY`. */
  readonly webhookKey?: string;
  /** Secreto `whsec_…` para firmar según Standard Webhooks. Por defecto, `ZENITH_HOOKS_SECRET`. */
  readonly signingSecret?: string;
}

type Hook = {
  objectId?: string;
  functionName?: string;
  className?: string;
  triggerName?: string;
  url: string;
};

export function createCloudHooksTrait(options: CloudHooksOptions = {}): AnyTraitDescriptor {
  return createTraitDescriptor({
    name: "ZenithCloudHooks",
    provides: ["hooks_routes", "cloudHooks"],
    consumes: ["cloud", "db"],
    state: [],
    runtimes: ["deno"],
    summary:
      "Parse Server Cloud Code Hooks (/hooks/functions, /hooks/triggers): functions and triggers served by external URLs, signed (Standard Webhooks), SSRF-safe, with timeouts.",

    create: (deps: Record<string, any>) => {
      const cloud = deps.traits["cloud"];
      const db = deps.traits["db"];
      const allowPrivate = envOf("ZENITH_WEBHOOKS_ALLOW_PRIVATE") === "1";
      const policy: OutboundPolicy = options.policy ??
        (allowPrivate ? { allowHttp: true, allowPrivate: true } : {});
      const webhookKey = options.webhookKey ?? envOf("PARSE_SERVER_WEBHOOK_KEY") ??
        envOf("ZENITH_WEBHOOK_KEY");
      const signingSecret = options.signingSecret ?? envOf("ZENITH_HOOKS_SECRET");
      let warnedKey = false;

      // Estado en memoria: lo que hoy está registrado. Se carga de _Hooks al arrancar.
      const functionHooks = new Map<string, string>();
      const triggerHooks = new Map<string, string>(); // "className|triggerName" → url
      const dispatchers = new Set<string>();

      /** POST al hook con la semántica de Parse: { success } o { error }. */
      const call = async (url: string, payload: Record<string, unknown>): Promise<unknown> => {
        const body = JSON.stringify(sanitizePayload(payload));
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "user-agent": "Zenith-Hooks/1.0",
        };
        if (webhookKey) headers["X-Parse-Webhook-Key"] = webhookKey;
        else if (!warnedKey && !signingSecret) {
          warnedKey = true;
          console.warn(
            "[hooks] Making outgoing hook calls without PARSE_SERVER_WEBHOOK_KEY or ZENITH_HOOKS_SECRET: receivers cannot authenticate them.",
          );
        }
        if (signingSecret) {
          Object.assign(
            headers,
            await webhookHeaders([signingSecret], `hook_${toBase64Url(randomBytes(12))}`, body),
          );
        }
        let res: Response;
        try {
          res = await safeFetch(url, { method: "POST", headers, body }, policy);
        } catch (e) {
          throw new ZenithError(
            ZenithErrorCode.SCRIPT_FAILED,
            `Hook call failed: ${(e as Error).message}`,
            400,
          );
        }
        const text = await res.text().catch(() => "");
        if (res.status < 200 || res.status >= 300) {
          throw new ZenithError(
            ZenithErrorCode.SCRIPT_FAILED,
            `Hook answered HTTP ${res.status}.`,
            400,
          );
        }
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          throw new ZenithError(
            ZenithErrorCode.SCRIPT_FAILED,
            `Malformed hook response: ${text.slice(0, 100)}`,
            400,
          );
        }
        if (json?.error !== undefined) {
          const err = json.error;
          const code = typeof err?.code === "number" ? err.code : ZenithErrorCode.SCRIPT_FAILED;
          const msg = typeof err === "string"
            ? err
            : typeof err?.error === "string"
            ? err.error
            : typeof err?.message === "string"
            ? err.message
            : "Hook returned an error.";
          throw new ZenithError(code, msg, 400);
        }
        return json?.success;
      };

      const contextOf = (request: any) => ({
        master: request?.master === true,
        user: request?.user ?? null,
        ...(request?.installationId ? { installationId: request.installationId } : {}),
        ...(request?.ip ? { ip: request.ip } : {}),
      });

      const registerFunction = (name: string, url: string) => {
        if (!functionHooks.has(name) && cloud.listFunctions?.().includes(name)) {
          console.warn(
            `[hooks] Hook "${name}" overrides the Cloud Code function of the same name until it is deleted.`,
          );
        }
        functionHooks.set(name, url);
        cloud.define(
          name,
          async (request: any) =>
            await call(functionHooks.get(name)!, {
              functionName: name,
              params: request?.params ?? {},
              ...contextOf(request),
            }),
        );
      };

      const unregisterFunction = (name: string) => {
        functionHooks.delete(name);
        // The Cloud Code function it overrode (cloud/main.ts) comes back from the global registry.
        cloud.undefine?.(name);
      };

      const registerTrigger = (className: string, triggerName: TriggerName, url: string) => {
        const key = `${className}|${triggerName}`;
        triggerHooks.set(key, url);
        if (dispatchers.has(key)) return;
        dispatchers.add(key);
        const before = triggerName.startsWith("before");
        cloud[triggerName](className, async (request: any) => {
          const current = triggerHooks.get(key);
          if (!current) return; // hook deleted: the dispatcher stays, inert
          const payload = {
            triggerName,
            ...(request?.object ? { object: { ...request.object, className } } : {}),
            ...(request?.original ? { original: { ...request.original, className } } : {}),
            ...(request?.query ? { query: request.query } : {}),
            ...(request?.results ? { objects: request.results } : {}),
            ...contextOf(request),
          };
          try {
            const result = await call(current, payload);
            if (
              triggerName === "beforeSave" && result && typeof result === "object" &&
              request?.object && typeof request.object === "object"
            ) {
              const { createdAt: _c, updatedAt: _u, className: _n, objectId: _id, ...changes } =
                result as Record<string, unknown>;
              Object.assign(request.object, changes);
            }
          } catch (e) {
            if (before) throw e;
            console.warn(
              `[hooks] ${triggerName} ${className} hook failed: ${(e as Error).message}`,
            );
          }
        });
      };

      /** Same policy as the calls: https, public destination. Parse only checks that url is not empty. */
      const validateUrl = async (url: unknown) => {
        if (typeof url !== "string" || !url) throw hookError(INVALID);
        try {
          await checkOutboundUrl(url, policy);
        } catch (e) {
          throw hookError(`${INVALID}: ${(e as Error).message}`);
        }
        return url;
      };
      const validTrigger = (className: unknown, triggerName: unknown): [string, TriggerName] => {
        if (typeof className !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(className)) {
          throw hookError(INVALID);
        }
        if (
          typeof triggerName !== "string" ||
          !(HOOK_TRIGGERS as readonly string[]).includes(triggerName)
        ) throw hookError(INVALID);
        return [className, triggerName as TriggerName];
      };
      const validFunction = (name: unknown): string => {
        if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) {
          throw hookError(INVALID);
        }
        return name;
      };

      const api = {
        /** Carga `_Hooks` (lo llama `startBackground` al arrancar). */
        async load() {
          for (const h of (await db.find(HOOKS_CLASS, {})) as Hook[]) {
            if (h.functionName) registerFunction(h.functionName, h.url);
            else if (
              h.className && h.triggerName &&
              (HOOK_TRIGGERS as readonly string[]).includes(h.triggerName)
            ) {
              registerTrigger(h.className, h.triggerName as TriggerName, h.url);
            }
          }
        },
        startBackground() {
          return api.load().catch((e) =>
            console.warn(`[hooks] could not load ${HOOKS_CLASS}: ${(e as Error).message}`)
          );
        },

        listFunctions: async () =>
          ((await db.find(HOOKS_CLASS, {})) as Hook[]).filter((h) => h.functionName).map((
            { functionName, url },
          ) => ({ functionName, url })),
        listTriggers: async () =>
          ((await db.find(HOOKS_CLASS, {})) as Hook[]).filter((h) => h.triggerName).map((
            { className, triggerName, url },
          ) => ({ className, triggerName, url })),

        async getFunction(name: string) {
          const [h] = (await db.find(HOOKS_CLASS, { functionName: name })) as Hook[];
          if (!h) throw hookError(`no function named: ${name} is defined`);
          return { functionName: h.functionName, url: h.url };
        },
        async getTrigger(className: string, triggerName: string) {
          const [h] = (await db.find(HOOKS_CLASS, { className, triggerName })) as Hook[];
          if (!h) throw hookError(`class ${className} does not exist`);
          return { className: h.className, triggerName: h.triggerName, url: h.url };
        },

        async createFunction(body: Record<string, unknown>) {
          const name = validFunction(body.functionName);
          const url = await validateUrl(body.url);
          if ((await db.find(HOOKS_CLASS, { functionName: name })).length) {
            throw hookError(`function name: ${name} already exists`);
          }
          await db.create(HOOKS_CLASS, { functionName: name, url });
          registerFunction(name, url);
          return { functionName: name, url };
        },
        async createTrigger(body: Record<string, unknown>) {
          const [className, triggerName] = validTrigger(body.className, body.triggerName);
          const url = await validateUrl(body.url);
          if ((await db.find(HOOKS_CLASS, { className, triggerName })).length) {
            throw hookError(`class ${className} already has trigger ${triggerName}`);
          }
          await db.create(HOOKS_CLASS, { className, triggerName, url });
          registerTrigger(className, triggerName, url);
          return { className, triggerName, url };
        },

        async putFunction(name: string, body: Record<string, unknown>) {
          const [h] = (await db.find(HOOKS_CLASS, { functionName: name })) as Hook[];
          if (body.__op === "Delete") {
            if (h) await db.delete(HOOKS_CLASS, { objectId: h.objectId! });
            unregisterFunction(name);
            return {};
          }
          if (!h) throw hookError(`no function named: ${name} is defined`);
          const url = await validateUrl(body.url);
          await db.update(HOOKS_CLASS, { objectId: h.objectId! }, { url });
          registerFunction(name, url);
          return { functionName: name, url };
        },
        async putTrigger(className: string, triggerName: string, body: Record<string, unknown>) {
          const [h] = (await db.find(HOOKS_CLASS, { className, triggerName })) as Hook[];
          if (body.__op === "Delete") {
            if (h) await db.delete(HOOKS_CLASS, { objectId: h.objectId! });
            triggerHooks.delete(`${className}|${triggerName}`);
            return {};
          }
          if (!h) throw hookError(`class ${className} does not exist`);
          const [c, t] = validTrigger(className, triggerName);
          const url = await validateUrl(body.url);
          await db.update(HOOKS_CLASS, { objectId: h.objectId! }, { url });
          registerTrigger(c, t, url);
          return { className: c, triggerName: t, url };
        },
      };

      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      const bodyOf = async (req: Request) => {
        try {
          return (await req.json()) ?? {};
        } catch {
          throw new ZenithError(ZenithErrorCode.INVALID_JSON, "Invalid JSON body.", 400);
        }
      };
      const route = (
        method: "GET" | "POST" | "PUT",
        path: string,
        summary: string,
        run: (req: Request, p: Record<string, string>) => Promise<Response>,
      ) => ({
        method,
        path,
        access: "master" as const,
        _openapi: { summary, tags: ["Hooks"] },
        handler: (req: Request, ctx: any) =>
          run(req, (ctx?.params ?? {}) as Record<string, string>),
      });

      const hooks_routes = [
        route(
          "GET",
          "/hooks/functions",
          "List function hooks (Parse Server)",
          async () => json(await api.listFunctions()),
        ),
        route(
          "POST",
          "/hooks/functions",
          "Create a function hook: { functionName, url }",
          async (req) => json(await api.createFunction(await bodyOf(req)), 201),
        ),
        route(
          "GET",
          "/hooks/functions/:functionName",
          "Get a function hook",
          async (_r, p) => json(await api.getFunction(p.functionName)),
        ),
        route(
          "PUT",
          "/hooks/functions/:functionName",
          'Update its url, or delete it with { __op: "Delete" }',
          async (req, p) => json(await api.putFunction(p.functionName, await bodyOf(req))),
        ),
        route(
          "GET",
          "/hooks/triggers",
          "List trigger hooks (Parse Server)",
          async () => json(await api.listTriggers()),
        ),
        route(
          "POST",
          "/hooks/triggers",
          "Create a trigger hook: { className, triggerName, url }",
          async (req) => json(await api.createTrigger(await bodyOf(req)), 201),
        ),
        route(
          "GET",
          "/hooks/triggers/:className/:triggerName",
          "Get a trigger hook",
          async (_r, p) => json(await api.getTrigger(p.className, p.triggerName)),
        ),
        route(
          "PUT",
          "/hooks/triggers/:className/:triggerName",
          'Update its url, or delete it with { __op: "Delete" }',
          async (req, p) =>
            json(await api.putTrigger(p.className, p.triggerName, await bodyOf(req))),
        ),
      ];

      return { hooks_routes, cloudHooks: api };
    },
  });
}

export const CloudHooksTrait: AnyTraitDescriptor = createCloudHooksTrait();
