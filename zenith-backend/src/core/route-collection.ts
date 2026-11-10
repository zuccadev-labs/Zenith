/**
 * @module @zenith/core/route-collection
 *
 * The one rule for "which routes does this engine serve". The router mounts what this returns and
 * the OpenAPI generator documents the same list, so the spec cannot drift from the server.
 *
 * A trait exposes routes under any capability whose key contains "routes" (`crud-routes`,
 * `user_routes`, `routes`…). Routes outside traits (`/health`, `/zen/api-keys`) are listed here
 * and in `security/api-keys/routes.ts`, and both the router and the generator take them from there.
 */

import type { ApiKeyScope } from "../security/api-keys/types.ts";

/** Who may call a route. Unset means "master": closed unless the trait opens it. */
export type RouteAccess = "public" | "user" | "master";

/**
 * What an API key needs to call a `user` route: one scope (`data:read`…), or "per-operation" when
 * the handler checks each operation itself (/batch). A `user` route without it rejects API keys.
 */
export type RouteScope = ApiKeyScope | "per-operation";

/** A route as traits declare it. `handler` is absent only in spec-only entries. */
export interface TraitRoute {
  method: string;
  path: string;
  access?: RouteAccess;
  scope?: RouteScope;
  handler?: unknown;
  _openapi?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Whether a capability key holds routes. */
export function isRoutesKey(key: string): boolean {
  return key.toLowerCase().includes("routes");
}

function isRoute(r: unknown): r is TraitRoute {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return typeof o.method === "string" && typeof o.path === "string";
}

/** Every route the composed traits expose, with the capability it came from. */
export function collectTraitRoutes(traits: Record<string, unknown>): Array<{ provider: string; route: TraitRoute }> {
  const out: Array<{ provider: string; route: TraitRoute }> = [];
  for (const [key, value] of Object.entries(traits)) {
    if (!isRoutesKey(key) || !Array.isArray(value)) continue;
    for (const route of value) if (isRoute(route)) out.push({ provider: key, route });
  }
  return out;
}

/** `GET /health`, mounted by the router itself. */
export const HEALTH_ROUTE: TraitRoute = {
  method: "GET",
  path: "/health",
  access: "public",
  _openapi: { tag: "Meta", summary: "Health check", responses: { "200": { description: "The server is up" } } },
};
