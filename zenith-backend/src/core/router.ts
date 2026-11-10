/**
 * @module @zenith/core/router
 * Router declarativo de Zenith — despacha requests HTTP a los handlers correctos.
 *
 * Los routers se definen como Maps de patrones URL → handlers.
 * No hay dependencia de Express, Oak ni ningún framework externo.
 * Compatible con el URLPattern API nativo de Deno.
 */

import type { ZenithRequestContext } from "./types.ts";
import type { RouteHandler } from "./pipeline.ts";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";

/**
 * Who may call a route. Deny by default (OWASP): a route that does not say is `master`.
 * - `public`: anyone (health, docs, sign-up and log-in).
 * - `user`: a verified user (`ctx.auth`), an API key, or the master key. The handler still checks
 *   object-level permissions.
 * - `master`: the master key, `Zen-Internal-Token`, or an API key with scope `*`.
 */
import type { RouteAccess, RouteScope } from "./route-collection.ts";
import { missingKeyScope } from "../security/api-keys/scopes.ts";
import { collectTraitRoutes, HEALTH_ROUTE } from "./route-collection.ts";
export type { RouteAccess, RouteScope };

export interface RouteDefinition {
  method: HttpMethod | "*";
  pattern: URLPattern;
  handler: RouteHandler;
  access: RouteAccess;
  /** What an API key needs here (see RouteScope). */
  scope?: RouteScope;
}

const isMaster = (ctx: ZenithRequestContext) => ctx.masterKey === true || (ctx.apiKey?.scopes ?? []).includes("*");

/**
 * `ctx.master` and `ctx.user` — the shape the traits read (ACL, CLP, cloud hooks). Roles are the
 * caller's Parse roles plus its directory groups (FreeIPA/LDAP via engine-auth), so an ACL entry
 * `role:admins` matches members of the `admins` group.
 */
export function callerFields(ctx: ZenithRequestContext): { master: boolean; user?: { objectId: string; id: string; roles: string[] } } {
  const userId = ctx.auth?.userId;
  if (!userId) return { master: isMaster(ctx) };
  const roles = [...new Set([...(ctx.auth?.roles ?? []), ...(ctx.auth?.groups ?? [])])].map(String);
  return { master: isMaster(ctx), user: { objectId: userId, id: userId, roles } };
}

const forbidden = (error: string): Response =>
  new Response(JSON.stringify({ code: 119, error }), { status: 403, headers: { "Content-Type": "application/json" } });

/** `null` if `ctx` may call a route with `access`, otherwise the refusal. */
export function denied(access: RouteAccess, ctx: ZenithRequestContext, scope?: RouteScope): Response | null {
  if (access === "public" || isMaster(ctx)) return null;
  if (access === "user" && ctx.apiKey) {
    // An API key only reaches what its scopes cover. Fail closed: a user route that declares no
    // scope is not open to API keys at all. "per-operation" routes (/batch) check each operation.
    const why = scope === undefined
      ? "This route does not accept API keys."
      : scope === "per-operation" ? null : missingKeyScope(ctx, scope);
    if (why) return forbidden(why);
    return null;
  }
  if (access === "user" && ctx.auth?.userId) return null;
  const anonymous = !ctx.auth?.userId && !ctx.apiKey;
  return new Response(
    JSON.stringify(anonymous
      ? { code: 209, error: "Authentication required." }
      : { code: 119, error: "This operation requires the master key." }),
    { status: anonymous ? 401 : 403, headers: { "Content-Type": "application/json" } },
  );
}

// ─── Builder del Router ────────────────────────────────────────────────────────

export class ZenithRouter {
  private readonly routes: RouteDefinition[] = [];

  on(method: HttpMethod | "*", path: string, handler: RouteHandler, access: RouteAccess = "master", scope?: RouteScope): this {
    if (!["public", "user", "master"].includes(access)) throw new Error(`route ${method} ${path}: unknown access ${JSON.stringify(access)}`);
    this.routes.push({
      method,
      pattern: new URLPattern({ pathname: path }),
      handler,
      access,
      ...(scope ? { scope } : {}),
    });
    return this;
  }

  /** What is mounted: method, path and access of every route, in order. */
  list(): Array<{ method: HttpMethod | "*"; path: string; access: RouteAccess; scope?: RouteScope }> {
    return this.routes.map((r) => ({ method: r.method, path: r.pattern.pathname, access: r.access, ...(r.scope ? { scope: r.scope } : {}) }));
  }

  get(path: string, handler: RouteHandler): this {
    return this.on("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.on("POST", path, handler);
  }

  put(path: string, handler: RouteHandler): this {
    return this.on("PUT", path, handler);
  }

  delete(path: string, handler: RouteHandler): this {
    return this.on("DELETE", path, handler);
  }

  /**
   * Retorna un RouteHandler unificado compatible con el pipeline.
   * Se registrarán primero las rutas más específicas.
   */
  dispatch(): RouteHandler {
    return async (req: Request, ctx: ZenithRequestContext): Promise<Response> => {
      const url = new URL(req.url);
      let pathname = url.pathname;

      // Alias nativos para SaaS y Paridad
      if (pathname.startsWith("/roles")) {
         pathname = pathname.replace("/roles", "/classes/_Role");
      } else if (pathname.startsWith("/users")) {
         if (pathname === "/users" && req.method === "POST") {
             // Handle signup directly
         } else if (pathname === "/users/me") {
             // /users/me handled separately
         } else {
             pathname = pathname.replace("/users", "/classes/_User");
         }
      } else if (pathname.startsWith("/installations")) {
         pathname = pathname.replace("/installations", "/classes/_Installation");
      }

      for (const route of this.routes) {
        if (route.method !== "*" && route.method !== req.method) continue;
        const match = route.pattern.exec({ pathname });
        if (match) {
          // Inyectar params en el contexto
          const refusal = denied(route.access, ctx, route.scope);
          if (refusal) return refusal;
          const params = (match.pathname.groups ?? {}) as Record<string, string>;
          const enrichedCtx = { ...ctx, params, ...callerFields(ctx) };
          return await route.handler(req, enrichedCtx);
        }
      }
      // 404 si no hay match
      return new Response(
        JSON.stringify({ code: 141, error: `Route not found: ${req.method} ${url.pathname}` }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    };
  }
}

// ─── Routers Estándar de Zenith ────────────────────────────────────────────────

/** Endpoint de salud — equivalente a `/health` de Parse Server */
export const healthHandler: RouteHandler = async (_req, _ctx) => {
  return new Response(
    JSON.stringify({ status: "ok", runtime: "deno", name: "Zenith" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

/**
 * Construye el Router Dinámicamente basándose en los Traits inyectados.
 * Esto permite compilar microservicios agnósticos (ej. un pod solo para Media).
 */
export function buildDynamicRouter(deps: Record<string, any>): ZenithRouter {
  const router = new ZenithRouter();
  
  // Endpoint de salud base
  router.on("GET", HEALTH_ROUTE.path, healthHandler, "public");

  // Rutas de los traits: la misma lista que documenta OpenAPI (route-collection.ts).
  const mounted = new Map<string, number>();
  for (const { provider, route } of collectTraitRoutes(deps.traits || deps)) {
    if (typeof route.handler !== "function") continue;
    router.on(route.method as HttpMethod | "*", route.path, route.handler as RouteHandler, route.access ?? "master", route.scope);
    mounted.set(provider, (mounted.get(provider) ?? 0) + 1);
  }
  for (const [provider, n] of mounted) console.log(`[Router] Mounting ${n} routes from capability: ${provider}`);

  return router;
}
