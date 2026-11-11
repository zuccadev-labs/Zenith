/**
 * Cache adapter interface — key-value caching with optional TTL support.
 */
export interface CacheAdapter {
  /** Retrieves a value by key, returning null if not found */
  get(key: string): Promise<any | null>;
  /** Stores a value with optional TTL in seconds */
  set(key: string, value: any, ttlSeconds?: number): Promise<void>;
  /** Deletes a key from the cache */
  del(key: string): Promise<void>;
  /** Flushes all cached data */
  clear(): Promise<void>;
}

/**
 * Creates a LuxDB cache adapter using Redis RESP protocol compatibility.
 * Wraps a LuxDB or Redis client instance behind the CacheAdapter interface for
 * transparent caching throughout the Zenith pipeline.
 *
 * @param luxClient - Connected LuxDB/Redis client instance (RESP or TCP)
 * @returns CacheAdapter — get, set, del, and clear interface
 */
export function createLuxAdapter(luxClient: any): CacheAdapter {
  return {
    async get(key: string) {
      if (!luxClient) return null;
      const data = await luxClient.get(key);
      if (!data) return null;
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    },

    async set(key: string, value: any, ttlSeconds?: number) {
      if (!luxClient) return;
      const stringValue = typeof value === "string" ? value : JSON.stringify(value);
      if (ttlSeconds) {
        await luxClient.setex(key, ttlSeconds, stringValue);
      } else {
        await luxClient.set(key, stringValue);
      }
    },

    async del(key: string) {
      if (!luxClient) return;
      await luxClient.del(key);
    },

    async clear() {
      if (!luxClient) return;
      await luxClient.flushall();
    },
  };
}
