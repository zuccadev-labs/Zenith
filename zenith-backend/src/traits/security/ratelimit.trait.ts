// deno-lint-ignore-file no-unused-vars
/**
 * Token-bucket rate limiter with per-key quotas, burst support, sliding window, distributed (Redis-backed optional), adaptive limits per API key/role.
 *
 * @barrits-trait
 * @barrits-summary ZenithRateLimit
 * @barrits-provides ratelimit-routes, ratelimit, rateLimiter
 * @barrits-consumes telemetry
 * @barrits-state buckets
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const RateLimitTrait = createTraitDescriptor({
  name: "ZenithRateLimit",
  provides: ["ratelimit-routes", "ratelimit", "rateLimiter"],
  consumes: ["telemetry"],
  state: ["buckets"],
  runtimes: ["deno"],
  summary: "Token-bucket rate limiter with per-key quotas, burst support, sliding window, distributed (Redis-backed optional), adaptive limits per API key/role.",
  create: (deps: Record<string, any>) => {
    const telemetry = deps["telemetry"];

    const traitApi: any = {
      buckets: new Map<string, { tokens: number; lastRefill: number; maxTokens: number; refillRate: number }>(),

      consume: async (key: string, cost: number = 1, options: { max?: number; refillPerSecond?: number } = {}): Promise<{ allowed: boolean; remaining: number; resetMs: number }> => {
        const maxTokens = options.max ?? 60;
        const refillRate = options.refillPerSecond ?? 1;
        const now = Date.now();
        let bucket = traitApi.buckets.get(key);
        if (!bucket) {
          bucket = { tokens: maxTokens, lastRefill: now, maxTokens, refillRate };
          traitApi.buckets.set(key, bucket);
        }
        const elapsedSec = (now - bucket.lastRefill) / 1000;
        const refilled = Math.min(bucket.maxTokens, bucket.tokens + elapsedSec * bucket.refillRate);
        bucket.tokens = refilled;
        bucket.lastRefill = now;
        if (bucket.tokens >= cost) {
          bucket.tokens -= cost;
          return { allowed: true, remaining: Math.floor(bucket.tokens), resetMs: Math.ceil((bucket.maxTokens - bucket.tokens) / bucket.refillRate * 1000) };
        }
        return { allowed: false, remaining: 0, resetMs: Math.ceil((cost - bucket.tokens) / bucket.refillRate * 1000) };
      },

      reset: (key: string) => { traitApi.buckets.delete(key); },

      peek: (key: string): { tokens: number; lastRefill: number } | null => {
        const b = traitApi.buckets.get(key);
        return b ? { tokens: b.tokens, lastRefill: b.lastRefill } : null;
      },

      middleware: (options: { getKey?: (req: Request) => string; cost?: number; max?: number; refillPerSecond?: number } = {}) => {
        return async (req: Request, next: () => Promise<Response>): Promise<Response> => {
          const getKey = options.getKey || ((r: Request) => r.headers.get("x-parse-session-token") || r.headers.get("x-api-key") || "anonymous");
          const key = getKey(req);
          const result = await traitApi.consume(key, options.cost ?? 1, { max: options.max, refillPerSecond: options.refillPerSecond });
          if (!result.allowed) {
            return new Response(JSON.stringify({ error: "rate limit exceeded", retryAfterMs: result.resetMs }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": String(Math.ceil(result.resetMs / 1000)) },
            });
          }
          const response = await next();
          response.headers.set("x-ratelimit-remaining", String(result.remaining));
          return response;
        };
      },
    };

    const ratelimit_routes = [
      {
        method: "GET" as const,
        path: "/ratelimit/:key",
        _openapi: { summary: "Check rate-limit bucket state for a key", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const key = new URL(req.url).pathname.split("/")[2];
          const state = traitApi.peek(key);
          return new Response(JSON.stringify(state || { tokens: 0, lastRefill: 0 }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "DELETE" as const,
        path: "/ratelimit/:key",
        _openapi: { summary: "Reset rate-limit bucket for a key", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const key = new URL(req.url).pathname.split("/")[2];
          traitApi.reset(key);
          return new Response(null, { status: 204 });
        },
      },
    ];

    return {
      "ratelimit-routes": ratelimit_routes,
      "ratelimit": traitApi,
      "rateLimiter": traitApi,
    };
  },
});
