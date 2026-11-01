/**
 * @module @zenith/core/pipeline
 * Pipeline funcional de requests — reemplaza la cadena de middlewares de Express.
 *
 * Cada paso del pipeline es una función pura que recibe un contexto inmutable
 * y retorna un nuevo contexto transformado o lanza un ZenithError.
 * 
 * Inspirado en composePipeline de @zuccadev-labs/barrits pero especializado
 * para el ciclo de vida de una request HTTP en Zenith.
 */

import type { ZenithRequestContext } from "./types.ts";
import { ZenithError, ZenithErrors } from "./errors.ts";
import type { ApiKeyManager } from "../security/api-keys/manager.ts";
import { PerKeyRateLimiter, extractAndVerifyKey } from "../security/api-keys/middleware.ts";

// ─── Tipos del Pipeline ────────────────────────────────────────────────────────

export type PipelineStep = (
  req: Request,
  ctx: ZenithRequestContext,
) => Promise<ZenithRequestContext>;

export type RouteHandler = (
  req: Request,
  ctx: ZenithRequestContext,
) => Promise<Response>;

/**
 * Opciones para `extractContext`.
 *
 * El sistema de API Keys estilo Stripe (Phase 0.D) es el método de auth
 * preferido. El master key estática sigue siendo válida SOLO para:
 *   - Compat con SDK Parse-Server legacy
 *   - Operaciones de bootstrap (migración de datos, etc.)
 *   - Requests desde localhost (donde se asume un operador/admin)
 *
 * Orden de prioridad:
 *   1. JWT Zen-Internal-Token (firma RSA + claims) — si está, master key válido
 *   2. API key (Bearer / X-API-Key / Zen-Api-Key / X-Parse-REST-API-Key)
 *      — si está y es válida, setea ctx.apiKey, NO masterKey
 *   3. Master key estática — solo desde localhost, comparación en tiempo constante
 */
export interface ExtractContextOpts {
  configMasterKey: string;
  publicKeyStr?: string;
  trustedProxies?: string[];
  /** Manager de API keys. Si no se provee, se cae directamente a master key. */
  apiKeyManager?: ApiKeyManager;
  /** Rate limiter por key. Si no se provee, se crea uno in-memory. */
  rateLimiter?: PerKeyRateLimiter;
  /** Si true, emite audit log en cada request (default: true) */
  audit?: boolean;
}

// ─── Pasos Estándar del Pipeline ──────────────────────────────────────────────

/**
 * Paso 1: Extrae el contexto base desde los headers modernos de Zenith.
 *
 * [SecOps H-02] La IP del cliente se lee del socket TCP real (`req.__socketAddr`),
 * que es inyectado por el handler de Deno.serve. X-Forwarded-For solo se confía
 * si la petición proviene de una IP en `trustedProxies`.
 *
 * [SecOps H-03] JWT `Zen-Internal-Token` valida firma RSA-SHA256 Y claims
 * (exp, iat, sub) para prevenir tokens eternos o de futuro.
 *
 * [SecOps H-2/H-3 mitigado] API keys estilo Stripe son el método de auth
 * preferido. Si se provee `apiKeyManager` y la request trae una key válida,
 * `ctx.apiKey` se setea y `ctx.masterKey` queda undefined. La master key
 * estática solo se usa como fallback para localhost.
 */
export function extractContext(
  optsOrConfigMasterKey: string | ExtractContextOpts,
  publicKeyStr?: string,
  trustedProxies: string[] = [],
): PipelineStep {
  // Compat: aceptar signature vieja (string, string, string[]) o nueva (objeto)
  const opts: ExtractContextOpts = typeof optsOrConfigMasterKey === "string"
    ? { configMasterKey: optsOrConfigMasterKey, publicKeyStr, trustedProxies }
    : optsOrConfigMasterKey;
  const {
    configMasterKey,
    publicKeyStr: _pubKey,
    trustedProxies: proxies = [],
    apiKeyManager,
    rateLimiter,
    audit: doAudit = true,
  } = opts;
  const rateLimiterInstance = rateLimiter ?? new PerKeyRateLimiter();

  return async (
    req: Request,
    _ctx: ZenithRequestContext,
  ): Promise<ZenithRequestContext> => {
  const headers = req.headers;
  const url = new URL(req.url);

  // ── Resolución Segura de IP del Cliente (H-02) ────────────────────────────
  // La IP real viene del socket TCP, inyectada por Deno.serve como __socketAddr.
  // NO confiamos en X-Forwarded-For a menos que la petición llegue de un proxy
  // cuya IP esté en trustedProxies (ej. Nginx, Cloudflare, AWS ALB).
  const socketIp: string = (req as any).__socketAddr?.hostname ?? "0.0.0.0";
  let resolvedClientIp = socketIp;

  if (proxies.length > 0 && proxies.includes(socketIp)) {
    // Solo confiamos en el header si viene de un proxy autorizado
    const forwarded = headers.get("X-Forwarded-For") || headers.get("CF-Connecting-IP");
    if (forwarded) {
      // X-Forwarded-For puede ser una lista "client, proxy1, proxy2" — tomamos el primero
      resolvedClientIp = forwarded.split(",")[0].trim();
    }
  }

  const isLocalhost = resolvedClientIp === "127.0.0.1" || resolvedClientIp === "::1" || resolvedClientIp === "0.0.0.0";

  let isMasterKeyValid = false;
  let apiKeyCtx: Awaited<ReturnType<typeof extractAndVerifyKey>> | null = null;

  // ── Zero-Trust JWT MasterKey Authentication (H-03 mejorado) ───────────────
  const internalToken = headers.get("Zen-Internal-Token");
  if (internalToken && publicKeyStr) {
    try {
      const nodeCrypto = await import("node:crypto");
      const parts = internalToken.split('.');
      if (parts.length === 3) {
        // Verificar firma RSA-SHA256
        const verify = nodeCrypto.createVerify('RSA-SHA256');
        verify.update(`${parts[0]}.${parts[1]}`);
        verify.end();
        const signature = parts[2].replace(/-/g, '+').replace(/_/g, '/');
        const isSignatureValid = verify.verify(publicKeyStr, signature, 'base64');

        if (isSignatureValid) {
          // [H-03] Decodificar y validar claims del payload
          const payloadJson = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
          const payload = JSON.parse(payloadJson);

          const nowSeconds = Math.floor(Date.now() / 1000);
          const clockSkewSeconds = 30; // Tolerancia de reloj de 30 segundos

          // Verificar expiración (exp)
          if (payload.exp && nowSeconds > payload.exp + clockSkewSeconds) {
            console.warn(`[SecOps] JWT rechazado: token expirado (exp=${payload.exp}, now=${nowSeconds})`);
          }
          // Verificar issued-at no es del futuro (iat)
          else if (payload.iat && payload.iat > nowSeconds + clockSkewSeconds) {
            console.warn(`[SecOps] JWT rechazado: token emitido en el futuro (iat=${payload.iat}, now=${nowSeconds})`);
          }
          // Verificar sub está presente (identidad del nodo)
          else if (!payload.sub) {
            console.warn(`[SecOps] JWT rechazado: falta el claim 'sub' (identidad del nodo emisor)`);
          }
          else {
            isMasterKeyValid = true;
          }
        }
      }
    } catch (_e) {
      // Fallo silencioso — no conceder acceso
    }
  }

  // ── API Key Authentication (Stripe-style) — método preferido ────────────
  // [H-2/H-3 mitigation] Si hay un apiKeyManager configurado, intentar
  // autenticar primero con API key. Si es válida, setea ctx.apiKey y
  // concede acceso. NO se requiere master key.
  if (apiKeyManager) {
    apiKeyCtx = await extractAndVerifyKey(
      headers,
      apiKeyManager,
      rateLimiterInstance,
      { resolveClientIp: () => resolvedClientIp, audit: doAudit },
    );
  }

  // ── Legacy Static MasterKey (Restringida a red interna / Localhost) ────────
  // [H-02] Ahora usamos resolvedClientIp (IP real del socket), no X-Forwarded-For.
  // [H-3 mitigation] Si ya se autenticó vía API key, NO se considera master key.
  // Solo aplica si la API key falló o no estaba presente.
  const providedMasterKey = headers.get("Zen-Master-Key") ?? headers.get("X-Parse-Master-Key");
  const authenticatedByApiKey = !!(apiKeyCtx?.record && !apiKeyCtx.reason);
  if (!isMasterKeyValid && !authenticatedByApiKey && providedMasterKey) {
    if (!isLocalhost) {
      console.warn(`[SecOps] 🛡️ Bloqueado uso de MasterKey estática desde IP externa: ${resolvedClientIp}. Usa Zen-Internal-Token (JWT RSA) para acceso de red.`);
    } else {
      // Comparación en tiempo constante (Bitwise XOR) contra timing attacks
      const encoder = new TextEncoder();
      const a = await crypto.subtle.digest("SHA-256", encoder.encode(providedMasterKey));
      const b = await crypto.subtle.digest("SHA-256", encoder.encode(configMasterKey));
      const a8 = new Uint8Array(a);
      const b8 = new Uint8Array(b);
      let result = 0;
      for (let i = 0; i < a8.length; i++) {
        result |= a8[i] ^ b8[i];
      }
      isMasterKeyValid = result === 0;
    }
  }

  return {
    appId: headers.get("Zen-Application-Id") ?? headers.get("X-Parse-Application-Id") ?? url.searchParams.get("appId") ?? "",
    masterKey: isMasterKeyValid ? true : undefined,
    apiKey: authenticatedByApiKey && apiKeyCtx?.record ? {
      id: apiKeyCtx.record.id,
      prefix: apiKeyCtx.record.prefix,
      env: apiKeyCtx.record.env,
      appId: apiKeyCtx.record.appId,
      name: apiKeyCtx.record.name,
      scopes: apiKeyCtx.scopes ?? apiKeyCtx.record.scopes,
      rateLimit: apiKeyCtx.record.rateLimit,
    } : undefined,
    // Solo marcamos `apiKeyRejected` si la request NO se autenticó por API key
    // (incluyendo el caso "no se proveyó key"). Si autenticó OK, queda undefined.
    apiKeyRejected: !authenticatedByApiKey
      ? (apiKeyManager ? (apiKeyCtx?.reason ?? "no_key_provided") : undefined)
      : undefined,
    sessionToken: headers.get("Zen-Session-Token") ?? headers.get("X-Parse-Session-Token") ?? undefined,
    clientVersion: headers.get("Zen-Client-Version") ?? headers.get("X-Parse-Client-Version") ?? undefined,
    installationId: headers.get("Zen-Installation-Id") ?? headers.get("X-Parse-Installation-Id") ?? undefined,
    tenantId: headers.get("Zen-Tenant-Id") ?? undefined,
    workspaceId: headers.get("Zen-Workspace-Id") ?? undefined,
    javascriptKey: headers.get("Zen-JavaScript-Key") ?? headers.get("X-Parse-JavaScript-Key") ?? undefined,
    clientKey: headers.get("Zen-Client-Key") ?? headers.get("X-Parse-Client-Key") ?? undefined,
  };
};
}


/**
 * Helper para extraer el token de sesión de los headers o del contexto base.
 */
export function extractSessionToken(req: Request, ctx: ZenithRequestContext): string | undefined {
  const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
  return authHeader || ctx.sessionToken;
}

/**
 * Paso 2: CORS — Adjunta los headers de control de acceso.
 * Equivalente a `allowCrossDomain` de Parse Server.
 */
export function applyCORS(_allowedOrigin = "*"): PipelineStep {
  return async (_req: Request, ctx: ZenithRequestContext) => ctx;
}

export function getCORSHeaders(allowedOrigin = "*"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Zen-Application-Id, Zen-Master-Key, Zen-Session-Token, Zen-Api-Key, Zen-Tenant-Id, Zen-Workspace-Id, Zen-Client-Version, Zen-Installation-Id, Zen-JavaScript-Key, Zen-Client-Key, X-Parse-Application-Id, X-Parse-Master-Key, X-Parse-Session-Token, X-Parse-REST-API-Key, X-Parse-JavaScript-Key, X-Parse-Client-Key, X-Parse-Installation-Id, X-Parse-Client-Version",
  };
}

/**
 * Paso 3: Valida que el appId sea correcto para esta instancia.
 */
export function validateAppId(validAppId: string): PipelineStep {
  return async (req: Request, ctx: ZenithRequestContext) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/openapi.json") || url.pathname.endsWith("/swagger")) {
      return ctx; // Bypass validation for OpenAPI docs
    }

    // WebSocket upgrade — appId is in query string (browsers can't set custom headers).
    // extractContext already reads url.searchParams.get("appId"), so ctx.appId is set.
    // No need to bypass — just let the normal check run with query-param appId.
    if (ctx.appId !== validAppId) {
      throw ZenithErrors.unauthorized(
        `Invalid Application ID: ${ctx.appId}`,
      );
    }
    return ctx;
  };
}

/**
 * Paso 4: Resuelve la autenticación.
 * Verifica el sessionToken contra el trait de autenticación e inyecta `ctx.auth`.
 * Esto es vital para que el ACLTrait (Row-Level Security) funcione.
 */
export function resolveAuthentication(authService: any): PipelineStep {
  return async (req: Request, ctx: ZenithRequestContext) => {
    const token = extractSessionToken(req, ctx);
    
    if (token) {
      try {
        const payload = authService.verifySession(token);
        if (payload && payload.sub) {
          const userId = payload.sub as string;
          // Resolver recursivamente los roles (Jerarquía de Roles de Fase 16)
          let roles = payload.roles || [];
          if (authService.resolveUserRoles) {
             const inheritedRoles = await authService.resolveUserRoles(userId);
             roles = Array.from(new Set([...roles, ...inheritedRoles]));
          }

          return {
            ...ctx,
            auth: {
              userId,
              roles
            }
          };
        }
      } catch (_e) {
        // Token inválido o expirado. Se ignora, quedando como 'anónimo'.
        // Si el ACL exige auth, fallará luego.
      }
    }
    return ctx;
  };
}

/**
 * Paso 5: Rate Limiting.
 * Verifica que el cliente (IP) no haya excedido la cuota de peticiones.
 * Esto es infraestructura pura del core — el usuario nunca lo ve.
 * Endpoints sensibles como /login y /users tienen cuotas más estrictas.
 */
export function applyRateLimit(rateLimiter: any): PipelineStep {
  // Defaults: 100 req/min global, 10 req/min para auth endpoints
  const GLOBAL_MAX = 100;
  const AUTH_MAX = 10;
  const WINDOW_MS = 60_000; // 1 minuto

  return async (req: Request, ctx: ZenithRequestContext) => {
    // Master Key bypasses rate limiting
    if (ctx.masterKey) return ctx;

    const url = new URL(req.url);
    const identifier = req.headers.get("X-Forwarded-For")
      || req.headers.get("CF-Connecting-IP")
      || "unknown";

    // Endpoints de autenticación: cuota estricta contra fuerza bruta
    const isSensitive = url.pathname === "/login" || url.pathname === "/users";
    const limit = isSensitive ? AUTH_MAX : GLOBAL_MAX;

    await rateLimiter.checkLimit(identifier, url.pathname, limit, WINDOW_MS);
    return ctx;
  };
}

// ─── Motor del Pipeline ────────────────────────────────────────────────────────

/**
 * Ejecuta una secuencia de pasos de pipeline de forma funcional y asíncrona.
 * Si cualquier paso lanza un ZenithError, lo propaga.
 */
export async function runPipeline(
  req: Request,
  initialCtx: ZenithRequestContext,
  steps: PipelineStep[],
): Promise<ZenithRequestContext> {
  let ctx = initialCtx;
  for (const step of steps) {
    ctx = await step(req, ctx);
  }
  return ctx;
}

/**
 * Wrapper principal del servidor. Maneja el ciclo completo de una request:
 * pipeline → router → respuesta → manejo de errores.
 */
export function createRequestHandler(
  pipeline: PipelineStep[],
  router: RouteHandler,
  corsOrigin = "*",
): (req: Request) => Promise<Response> {
  const corsHeaders = getCORSHeaders(corsOrigin);
  const emptyCtx: ZenithRequestContext = { appId: "" };

  return async (req: Request): Promise<Response> => {
    // Preflight CORS
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const ctx = await runPipeline(req, emptyCtx, pipeline);
      const response = await router(req, ctx);

      // ── WebSocket upgrade guard ──────────────────────────────────────────────
      // Deno.upgradeWebSocket() returns a Response with status 101 that carries
      // internal state managing the WS connection. Wrapping it in new Response()
      // destroys that state, silently killing the connection.
      // LiveQuery depends on this — return as-is, no CORS injection needed.
      if (response.status === 101) {
        return response;
      }

      // Inyectar CORS en todas las respuestas exitosas
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders)) {
        newHeaders.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    } catch (err) {
      if (err instanceof ZenithError) {
        const errHeaders = new Headers({ "Content-Type": "application/json" });
        for (const [k, v] of Object.entries(corsHeaders)) {
          errHeaders.set(k, v);
        }
        return new Response(JSON.stringify(err.toJSON()), {
          status: err.httpStatus,
          headers: errHeaders,
        });
      }
      // Error inesperado (Sanitized for Enterprise Security)
      console.error("[ZenithRouter] Unhandled Error:", err);
      const internal = ZenithErrors.internal(
        "An internal server error occurred. Please try again later."
      );
      
      const internalHeaders = new Headers({ "Content-Type": "application/json" });
      for (const [k, v] of Object.entries(corsHeaders)) {
        internalHeaders.set(k, v);
      }
      
      return new Response(JSON.stringify(internal.toJSON()), {
        status: 500,
        headers: internalHeaders,
      });
    }
  };
}
