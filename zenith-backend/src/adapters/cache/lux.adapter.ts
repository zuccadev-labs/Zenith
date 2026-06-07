export interface CacheAdapter {
  get(key: string): Promise<any | null>;
  set(key: string, value: any, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
}

// Para conectarnos a LuxDB usaremos la compatibilidad con el protocolo Redis RESP.
// Deno no tiene un cliente redis incorporado por defecto, usaremos fetch si exponen API REST,
// o un cliente de Redis básico. Para este adapter simularemos la interfaz, asumiendo
// que `client` es una instancia conectada por RESP o TCP.
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
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
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
    }
  };
}
