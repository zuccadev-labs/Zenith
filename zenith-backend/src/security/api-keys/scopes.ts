/**
 * @module @zenith/security/api-keys/scopes
 *
 * Jerarquía de scopes y función de verificación.
 *
 * Modelo (estilo OAuth + Stripe):
 *   - `*` concede TODO (super admin)
 *   - `recurso:*` concede TODAS las ops de un recurso
 *   - `recurso:accion` concede una op específica
 *
 * El wildcard `*` también cubre wildcards de recurso:
 *   - hasScope(["*"], "data:read")        → true
 *   - hasScope(["data:*"], "data:read")  → true
 *   - hasScope(["data:read"], "data:read")→ true
 *   - hasScope(["data:read"], "data:write")→ false
 */

import type { ApiKeyScope } from "./types.ts";

/**
 * Verifica si un set de scopes concedidos cubre un scope requerido.
 */
export function hasScope(granted: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  for (const g of granted) {
    if (g === "*") return true;
    if (g === required) return true;
    if (g.endsWith(":*")) {
      const resource = g.slice(0, -2);
      if (required.startsWith(resource + ":") || required === resource) return true;
    }
  }
  return false;
}

/**
 * Verifica múltiples scopes requeridos (AND lógico).
 */
export function hasAllScopes(
  granted: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): boolean {
  return required.every((r) => hasScope(granted, r));
}

/**
 * Verifica múltiples scopes requeridos (OR lógico).
 */
export function hasAnyScope(
  granted: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): boolean {
  return required.some((r) => hasScope(granted, r));
}

/**
 * Normaliza y deduplica un set de scopes. Si se incluye un wildcard
 * más específico junto con `*`, se queda solo con `*`.
 */
export function normalizeScopes(scopes: readonly ApiKeyScope[]): ApiKeyScope[] {
  const set = new Set(scopes);
  if (set.has("*")) return ["*"];
  // Si hay wildcards de recurso, se pueden quitar los específicos
  const wildcards = [...set].filter((s) => s.endsWith(":*"));
  for (const w of wildcards) {
    const resource = w.slice(0, -2);
    for (const specific of [...set]) {
      if (specific !== w && specific.startsWith(resource + ":")) {
        set.delete(specific);
      }
    }
  }
  return [...set];
}

/**
 * Default scopes seguros para cada tipo de key.
 */
export const DEFAULT_SCOPES: Record<"sk" | "pk" | "rk", ApiKeyScope[]> = {
  // Server key: control total del backend (CRUD, users, functions)
  sk: [
    "data:read",
    "data:write",
    "data:create",
    "data:delete",
    "users:read",
    "users:write",
    "files:read",
    "files:write",
    "files:delete",
    "functions:invoke",
    "functions:deploy",
    "push:send",
    "analytics:read",
  ],
  // Publishable key: solo lectura (clientes públicos / SDK)
  pk: [
    "data:read",
    "users:read",
    "files:read",
    "analytics:read",
  ],
  // Restricted key: un solo scope (configurable, default analytics:read)
  rk: [
    "analytics:read",
  ],
};

/**
 * Rate limits por defecto (requests/min) para cada tipo.
 */
export const DEFAULT_RATE_LIMITS: Record<"sk" | "pk" | "rk", number> = {
  sk: 1000,
  pk: 6000, // cliente público: alto volumen pero solo lectura
  rk: 60, // restricted: bajo
};

/** The data operations an API key may be scoped to. */
export type DataOperation = "read" | "create" | "write" | "delete";

/**
 * The scope an API key needs for `op` on `className`: `users:*` for `_User`, `data:*` for the rest.
 * Updates and increments are `write`; `create` and `delete` are separate so a key can add without erasing.
 */
export function dataScope(op: DataOperation, className: string): ApiKeyScope {
  if (className === "_User") return op === "read" ? "users:read" : "users:write";
  return `data:${op}`;
}

/**
 * Why the request's API key may not do what needs `scope`, or null if it may (or no API key is
 * involved: sessions and the master key are governed by ACL/CLP and `access`, not by key scopes).
 * When a session and a key arrive together, the key still limits the request.
 */
export function missingKeyScope(
  ctx: { apiKey?: { scopes: readonly string[] } },
  scope: ApiKeyScope,
): string | null {
  if (!ctx.apiKey) return null;
  return hasScope(ctx.apiKey.scopes as ApiKeyScope[], scope)
    ? null
    : `This API key lacks the scope ${scope}.`;
}
