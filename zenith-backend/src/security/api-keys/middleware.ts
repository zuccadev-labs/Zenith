/**
 * @module @zenith/security/api-keys/middleware
 *
 * Middleware para validar API keys en el pipeline de requests.
 *
 * Estrategia:
 *   1. Lee la key del header `Authorization: Bearer <key>` o
 *      `X-API-Key: <key>` (compat con SDK Parse-Server).
 *   2. Verifica la key contra el store (Argon2id).
 *   3. Verifica scopes vs la operación solicitada.
 *   4. Emite audit log.
 *   5. Si todo OK, enriquece el contexto con `auth.apiKey`.
 *
 * Integración con el pipeline existente (src/core/pipeline.ts):
 *   El pipeline llama a `extractContext(headers, url, ip)`. Esta función
 *   añade verificación de API keys en el campo `auth.apiKey`.
 *
 * Rate limiting por key:
 *   Implementado con un sliding window in-memory. Para producción multi-nodo,
 *   usar Redis (Phase 1).
 */

import { audit } from "./audit.ts";
import { hasScope, normalizeScopes } from "./scopes.ts";
import type { ApiKeyManager } from "./manager.ts";
import type { ApiKeyRecord, ApiKeyScope } from "./types.ts";

// ─── Rate limiter (sliding window in-memory) ─────────────────────────────────

interface RateLimitEntry {
  timestamps: number[]; // últimos N timestamps
}

/**
 * Rate limiter por key. In-memory; adecuado para single-node.
 * Para multi-nodo, reemplazar por Redis con ZADD/ZRANGEBYSCORE.
 */
export class PerKeyRateLimiter {
  private readonly windows = new Map<string, RateLimitEntry>();

  /**
   * @returns true si la request está dentro del límite, false si fue rechazada.
   */
  check(record: ApiKeyRecord, now = Date.now()): boolean {
    const limit = record.rateLimit.requestsPerMinute;
    if (limit <= 0) return true; // 0 o negativo = sin límite

    let entry = this.windows.get(record.id);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(record.id, entry);
    }

    // Drop timestamps older than 60s
    const cutoff = now - 60_000;
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= limit) {
      return false;
    }
    entry.timestamps.push(now);
    return true;
  }

  /** Limpia entradas inactivas (llamar periódicamente) */
  cleanup(): void {
    const cutoff = Date.now() - 60_000;
    for (const [id, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) this.windows.delete(id);
    }
  }
}

// ─── Middleware ──────────────────────────────────────────────────────────────

export interface ApiKeyContext {
  /** Registro de la key verificada (si válida) */
  record?: ApiKeyRecord;
  /** Scopes normalizados */
  scopes?: ApiKeyScope[];
  /** Motivo de rechazo (si inválida) */
  reason?: string;
}

export interface ExtractKeyOpts {
  /** Función para resolver la IP del cliente (debe ser la IP real, no X-Forwarded-For) */
  resolveClientIp?: (headers: Headers) => string;
  /** Si true, emite audit log en cada verificación */
  audit?: boolean;
}

/**
 * Extrae y verifica una API key de los headers. Retorna el contexto.
 *
 * Headers aceptados (en orden de prioridad):
 *   1. `Authorization: Bearer <key>`
 *   2. `X-API-Key: <key>`           (estándar)
 *   3. `Zen-Api-Key: <key>`         (Parse-Server compat)
 *   4. `X-Parse-REST-API-Key: <key>` (Parse-Server legacy)
 */
export async function extractAndVerifyKey(
  headers: Headers,
  manager: ApiKeyManager,
  rateLimiter: PerKeyRateLimiter,
  opts: ExtractKeyOpts = {},
): Promise<ApiKeyContext> {
  const auth = headers.get("authorization");
  let plaintext: string | null = null;
  if (auth?.startsWith("Bearer ")) {
    plaintext = auth.slice(7);
  } else {
    plaintext = headers.get("x-api-key") ??
      headers.get("zen-api-key") ??
      headers.get("x-parse-rest-api-key") ??
      null;
  }

  if (!plaintext) {
    return { reason: "no_key_provided" };
  }

  const clientIp = opts.resolveClientIp?.(headers);
  const result = await manager.verify(plaintext, clientIp);

  if (!result.valid) {
    if (opts.audit !== false) {
      await audit.rejected(result.reason, result.keyId, clientIp);
    }
    return { reason: result.reason };
  }

  const record = result.key;

  // Rate limit
  if (!rateLimiter.check(record)) {
    if (opts.audit !== false) {
      await audit.rateLimited(record, clientIp);
    }
    return { record, scopes: normalizeScopes(record.scopes), reason: "rate_limited" };
  }

  if (opts.audit !== false) {
    await audit.verified(record, clientIp);
  }

  return { record, scopes: normalizeScopes(record.scopes) };
}

/**
 * Helper para que un handler verifique scope sin tener que conocer
 * la estructura interna del contexto.
 *
 * @throws  Error con código 403 si falta el scope
 */
export function requireScope(ctx: ApiKeyContext, required: ApiKeyScope): ApiKeyRecord {
  if (!ctx.record) {
    throw new Error("AUTH_REQUIRED: no API key in context");
  }
  if (!hasScope(ctx.scopes ?? [], required)) {
    // Fire-and-forget audit (no awaited para no bloquear la respuesta)
    audit.scopeDenied(ctx.record, required).catch(() => {});
    const err: any = new Error(`FORBIDDEN: missing scope '${required}'`);
    err.code = 403;
    throw err;
  }
  return ctx.record;
}
