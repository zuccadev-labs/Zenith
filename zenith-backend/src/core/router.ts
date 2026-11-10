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
export type RouteAccess = "public" | "user" | "master";

export interface RouteDefinition {
  method: HttpMethod | "*";
  pattern: URLPattern;
  handler: RouteHandler;
  access: RouteAccess;
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

/** `null` if `ctx` may call a route with `access`, otherwise the refusal. */
export function denied(access: RouteAccess, ctx: ZenithRequestContext): Response | null {
  if (access === "public" || isMaster(ctx)) return null;
  if (access === "user" && (ctx.auth?.userId || ctx.apiKey)) return null;
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

  on(method: HttpMethod | "*", path: string, handler: RouteHandler, access: RouteAccess = "master"): this {
    if (!["public", "user", "master"].includes(access)) throw new Error(`route ${method} ${path}: unknown access ${JSON.stringify(access)}`);
    this.routes.push({
      method,
      pattern: new URLPattern({ pathname: path }),
      handler,
      access,
    });
    return this;
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
          const refusal = denied(route.access, ctx);
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
  router.on("GET", "/health", healthHandler, "public");

  // Escaneo dinámico de rutas expuestas por los Traits (Flattened Barrits Capabilities)
  const flattenedDeps = deps.traits || deps;
  for (const [key, value] of Object.entries(flattenedDeps)) {
    if (key.toLowerCase().includes("routes") && Array.isArray(value)) {
      console.log(`[Router] Mounting ${value.length} routes from capability: ${key}`);
      for (const route of value) {
        if (route.method && route.path && route.handler) {
          router.on(route.method, route.path, route.handler, route.access ?? "master");
        }
      }
    }
  }

  return router;
}
