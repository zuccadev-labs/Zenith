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

export interface RouteDefinition {
  method: HttpMethod | "*";
  pattern: URLPattern;
  handler: RouteHandler;
}

// ─── Builder del Router ────────────────────────────────────────────────────────

export class ZenithRouter {
  private readonly routes: RouteDefinition[] = [];

  on(method: HttpMethod | "*", path: string, handler: RouteHandler): this {
    this.routes.push({
      method,
      pattern: new URLPattern({ pathname: path }),
      handler,
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
          const params = (match.pathname.groups ?? {}) as Record<string, string>;
          const enrichedCtx = { ...ctx, params };
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
  router.get("/health", healthHandler);

  // Escaneo dinámico de rutas expuestas por los Traits (Flattened Barrits Capabilities)
  const flattenedDeps = deps.traits || deps;
  for (const [key, value] of Object.entries(flattenedDeps)) {
    if (key.toLowerCase().includes("routes") && Array.isArray(value)) {
      console.log(`[Router] Mounting ${value.length} routes from capability: ${key}`);
      for (const route of value) {
        if (route.method && route.path && route.handler) {
          router.on(route.method, route.path, route.handler);
        }
      }
    }
  }

  return router;
}
