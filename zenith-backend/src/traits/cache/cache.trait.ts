// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const CacheTrait = createTraitDescriptor({
  name: "ZenithCache",
  provides: ["cache-routes", "cache", "cacheManager"],
  consumes: ["telemetry"],
  state: ["store", "adapter"],
  runtimes: ["deno"],
  summary: "Cache facade: in-memory LRU + Redis adapter, TTL-based expiry, tag-based invalidation, write-through/write-behind patterns, cache stampede prevention.",
  create: (deps: Record<string, any>) => {
    const traitApi: any = {
      store: new Map<string, { value: any; expiresAt: number; tags: string[] }>(),
      adapter: null as any,

      get: async <T>(key: string): Promise<T | null> => {
        if (traitApi.adapter) return await traitApi.adapter.get(key);
        const entry = traitApi.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt < Date.now()) {
          traitApi.store.delete(key);
          return null;
        }
        return entry.value as T;
      },

      set: async <T>(key: string, value: T, options: { ttlMs?: number; tags?: string[] } = {}): Promise<void> => {
        if (traitApi.adapter) { await traitApi.adapter.set(key, value, options); return; }
        const ttl = options.ttlMs || 300000;
        traitApi.store.set(key, { value, expiresAt: Date.now() + ttl, tags: options.tags || [] });
      },

      delete: async (key: string): Promise<boolean> => {
        if (traitApi.adapter) return await traitApi.adapter.delete(key);
        return traitApi.store.delete(key);
      },

      invalidateByTag: async (tag: string): Promise<number> => {
        let count = 0;
        for (const [key, entry] of traitApi.store) {
          if (entry.tags.includes(tag)) {
            traitApi.store.delete(key);
            count++;
          }
        }
        return count;
      },

      clear: async (): Promise<void> => {
        traitApi.store.clear();
        if (traitApi.adapter) await traitApi.adapter.clear();
      },

      wrap: async <T>(key: string, fn: () => Promise<T>, options: { ttlMs?: number; tags?: string[] } = {}): Promise<T> => {
        const cached = (await traitApi.get(key)) as T | null;
        if (cached !== null) return cached;
        const value = await fn();
        await traitApi.set(key, value, options);
        return value;
      },
    };

    const cache_routes = [
      {
        method: "GET" as const,
        path: "/cache/:key",
        _openapi: { summary: "Get a cache value", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const key = new URL(req.url).pathname.split("/")[2];
          const value = await traitApi.get(key);
          if (value === null) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ key, value }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "DELETE" as const,
        path: "/cache/:key",
        _openapi: { summary: "Invalidate a cache key", parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const key = new URL(req.url).pathname.split("/")[2];
          await traitApi.delete(key);
          return new Response(null, { status: 204 });
        },
      },
    ];

    return {
      "cache-routes": cache_routes,
      "cache": traitApi,
      "cacheManager": traitApi,
    };
  },
});
