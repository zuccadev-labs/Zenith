/**
 * Core Zenith server: builds the HTTP handler from all traits, initializes API keys, rate limiting, CORS, and app ID validation.
 *
 * @barrits-trait
 * @barrits-summary ZenithCoreServer
 * @barrits-provides getHandler, initKeys
 * @barrits-consumes authentication, ratelimit, telemetry
 * @barrits-tags uses:billing-metering
 * @barrits-state serverInstance
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import {
  applyCORS,
  applyRateLimit,
  buildDynamicRouter,
  createRequestHandler,
  extractContext,
  resolveAuthentication,
  validateAppId,
} from "./mod.ts";
import type { ZenithConfig } from "./types.ts";
import { ApiKeyManager } from "../security/api-keys/manager.ts";
import { apiKeyRoutes, apiKeyStoreFor } from "../security/api-keys/routes.ts";
import { PerKeyRateLimiter } from "../security/api-keys/middleware.ts";
import { bootstrapApiKey } from "../security/api-keys/bootstrap.ts";

export const ServerTrait = createTraitDescriptor({
  name: "ZenithCoreServer",
  provides: ["getHandler", "initKeys"],
  consumes: ["authentication", "ratelimit", "telemetry"],
  tags: ["uses:billing-metering"],
  state: ["serverInstance"],
  runtimes: ["deno"],
  create: (deps: Record<string, unknown>) => {
    let _publicKey = "";
    // [H-2/H-3 mitigation] API key manager + rate limiter, one per app. The store depends on the
    // app's database (MongoDB when available), so it is built with the first handler.
    let apiKeys: { manager: ApiKeyManager; store: ReturnType<typeof apiKeyStoreFor> } | null = null;
    const perKeyRateLimiter = new PerKeyRateLimiter();
    return {
      initKeys: (_privateKey: string, publicKey: string) => {
        _publicKey = publicKey;
      },
      getHandler: (config: ZenithConfig) => {
        // barrits hands every composed capability, live, under `traits`.
        const caps = (deps as any).traits as Record<string, any>;
        const obs = caps["telemetry"];
        obs?.log?.(`[ZenithServer] Building handler for App ID: ${config.appId}`);

        // 1. Construir el Router con dependencias inyectadas (Auto-descubrimiento)
        const router = buildDynamicRouter(deps);
        if (!apiKeys) {
          const store = apiKeyStoreFor(config as { databaseURI?: string }, (m) => obs?.warn?.(m));
          apiKeys = { store, manager: new ApiKeyManager(store) };
        }
        const apiKeyManager = apiKeys.manager;
        for (const r of apiKeyRoutes(config.appId, apiKeys.manager, apiKeys.store)) {
          router.on(r.method, r.path, r.handler, r.access);
        }

        // 2. Bootstrap: si la app no tiene keys, crear una sk_live (solo dev)
        //    Esto se hace sincrónicamente antes de armar el pipeline para que
        //    el operador pueda usar la key inmediatamente.
        bootstrapApiKey(apiKeyManager, {
          appId: config.appId,
          appName: (config as any).appName,
        }).catch((err) => {
          obs?.warn?.(`[ZenithServer] Bootstrap key creation failed: ${err.message}`);
        });

        // 3. Definir el Pipeline Funcional (con API key auth + master key fallback)
        const pipeline = [
          extractContext({
            configMasterKey: config.masterKey as string,
            publicKeyStr: _publicKey,
            trustedProxies: (config as any).trustedProxies ?? [],
            apiKeyManager,
            rateLimiter: perKeyRateLimiter,
            audit: true,
            appId: config.appId,
            onMasterKey: () => caps["metric-registry"]?.increment("zenith_master_key_usage_total"),
            onApiKey: (env) =>
              caps["metric-registry"]?.increment("zenith_api_key_requests_total", { env }),
          }),
          applyCORS("*"),
          validateAppId(config.appId),
          resolveAuthentication(caps["authentication"]),
          applyRateLimit(caps["ratelimit"]),
        ];

        // 3. Crear el Request Handler con Telemetría Global
        const rawDispatch = router.dispatch();
        const tracedDispatch = async (req: Request, ctx: any) => {
          const url = new URL(req.url);
          const currentObs = caps["telemetry"];
          if (currentObs?.withSpan) {
            return await currentObs.withSpan(`HTTP ${req.method} ${url.pathname}`, {
              "http.method": req.method,
              "http.url": url.pathname,
            }, async () => {
              const response = await rawDispatch(req, ctx);

              // Lógica de Negocio Corporativa: Metering (Consumo de API y Ancho de Banda)
              const billing = caps["billing-metering"];
              if (billing && ctx.auth?.userId) {
                try {
                  // Contamos 1 petición
                  billing.consumeQuota(ctx.auth.userId, "api_requests", 1).catch(() => {});

                  // Estimamos ancho de banda basado en Content-Length si existe, sino usamos una aproximación
                  const cl = response.headers.get("Content-Length");
                  if (cl) {
                    const bytes = parseInt(cl, 10);
                    if (!isNaN(bytes)) {
                      billing.consumeQuota(ctx.auth.userId, "bandwidth_bytes", bytes).catch(
                        () => {},
                      );
                    }
                  } else if (response.status === 200) {
                    // Si no hay Content-Length, hacemos una estimación mínima asumiendo JSON
                    billing.consumeQuota(ctx.auth.userId, "bandwidth_bytes", 1024).catch(() => {}); // 1KB proxy
                  }
                } catch (_e) { /* noop: no bloquear el flujo de respuesta */ }
              }

              return response;
            });
          } else {
            return await rawDispatch(req, ctx);
          }
        };

        const handler = createRequestHandler(pipeline, tracedDispatch);
        // HTTP metrics (http_requests_total, http_request_duration_seconds) around everything, so the 401
        // and 429 the pipeline answers count too. Before, the middleware existed but nothing called it: the
        // availability SLO, the latency panels and the error alerts had no data.
        const httpMetrics = caps["observability"]?.middleware;
        return httpMetrics
          ? (req: Request) =>
            httpMetrics(
              req,
              () => handler(req),
              (m: string, p: string) => router.routeOf(m, p),
            ) as Promise<
              Response
            >
          : handler;
      },
    };
  },
});
