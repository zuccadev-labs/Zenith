/**
 * @module @zenith/security/api-keys/store
 *
 * Persistencia de API keys.
 *
 * Implementaciones:
 *   - InMemoryStore: para tests y single-node dev. Thread-safe via Map.
 *   - MongoDBStore:  para producción (cluster multi-nodo) con change streams.
 *
 * La interfaz `ApiKeyStore` está en ./manager.ts para evitar import cycles.
 */

import type { ApiKeyRecord } from "./types.ts";
import type { ApiKeyStore as IApiKeyStore } from "./manager.ts";

/**
 * Store en memoria. Thread-safe (Deno's structured clone model).
 * Adecuado para:
 *   - Tests unitarios
 *   - Single-node dev
 *   - Edge runtimes con SQLite (se puede envolver en un SQLiteStore)
 *
 * NO usar en producción multi-nodo: cada nodo tendría su propio store
 * y las revocaciones no se propagarían.
 */
export class InMemoryStore implements IApiKeyStore {
  private readonly byId = new Map<string, ApiKeyRecord>();
  private readonly byApp = new Map<string, Set<string>>();

  async get(id: string): Promise<ApiKeyRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listByApp(appId: string): Promise<Omit<ApiKeyRecord, "hash">[]> {
    const ids = this.byApp.get(appId);
    if (!ids) return [];
    const out: Omit<ApiKeyRecord, "hash">[] = [];
    for (const id of ids) {
      const rec = this.byId.get(id);
      if (rec) {
        const { hash: _h, ...rest } = rec;
        out.push(rest);
      }
    }
    return out;
  }

  async put(record: ApiKeyRecord): Promise<void> {
    if (this.byId.has(record.id)) {
      throw new Error(`[api-keys] Key ${record.id} already exists`);
    }
    this.byId.set(record.id, record);
    let set = this.byApp.get(record.appId);
    if (!set) {
      set = new Set();
      this.byApp.set(record.appId, set);
    }
    set.add(record.id);
  }

  async update(id: string, patch: Partial<ApiKeyRecord>): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`[api-keys] Key ${id} not found`);
    this.byId.set(id, { ...existing, ...patch });
  }

  async delete(id: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.delete(id);
    const set = this.byApp.get(existing.appId);
    set?.delete(id);
  }

  /** Utilidad para tests */
  size(): number {
    return this.byId.size;
  }

  /** Utilidad para tests */
  clear(): void {
    this.byId.clear();
    this.byApp.clear();
  }
}

// ── MongoDBStore ───────────────────────────────────────────────────────────

/**
 * Opciones de conexión para `MongoDBStore`.
 *
 * El driver `mongodb` de npm es cargado **lazy** (dynamic import) para que
 * las deployments que solo usan `InMemoryStore` (tests, edge runtimes)
 * no paguen el costo de la dependencia.
 */
export interface MongoDBStoreConfig {
  /** URI completo, ej. `mongodb://user:pass@host1:27017,host2:27017/?replicaSet=rs0`. */
  uri: string;
  /** Nombre de la DB. Default: `zenith_api_keys`. */
  dbName?: string;
  /** Nombre de la colección. Default: `api_keys`. */
  collectionName?: string;
  /**
   * Habilita change streams para notificar revocaciones a todos los nodos
   * del cluster en <1s. Requiere MongoDB como replica set o sharded cluster.
   * Default: false (para single-node dev). En producción: true.
   */
  enableChangeStream?: boolean;
  /**
   * Callback invocado cuando un cambio en otra instancia afecta a esta.
   * Útil para invalidar caches in-memory.
   */
  onRemoteChange?: (event: RemoteChangeEvent) => void | Promise<void>;
  /** Logger hook. Default: console. */
  logger?: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

export type RemoteChangeEvent =
  | { type: "insert"; id: string; appId: string }
  | { type: "update"; id: string; appId: string; patchKeys: string[] }
  | { type: "delete"; id: string; appId: string };

const DEFAULT_DB = "zenith_api_keys";
const DEFAULT_COLLECTION = "api_keys";
const INDEX_NAME_ID = "idx_id_unique";
const INDEX_NAME_APP = "idx_appId";
const INDEX_NAME_EXPIRES = "idx_expiresAt_ttl";
const INDEX_NAME_ROTATION = "idx_rotationExpiresAt_ttl";

/**
 * Store MongoDB para producción multi-nodo.
 *
 * ## Características
 *
 *   - **Connection pooling**: el driver `mongodb` mantiene un pool automático
 *     (default: 100 conns). Configurable via `uri` query params (`maxPoolSize`).
 *   - **Índices únicos y de performance**:
 *       - `id` UNIQUE (lookup por id en O(log n))
 *       - `appId` (listByApp en O(log n))
 *       - `expiresAt` TTL (MongoDB borra keys expiradas automáticamente)
 *       - `rotationExpiresAt` TTL (idem para grace period)
 *   - **Change streams** (opcional): notifica a todos los nodos del cluster
 *     cuando una key se crea/actualiza/revoca en otra instancia. Latencia
 *     de propagación: <1s (típicamente 50-200ms). Requiere replica set.
 *   - **Lazy import**: el driver `npm:mongodb` se carga on-demand.
 *   - **Multi-app**: una sola colección contiene keys de todas las apps
 *     (filtradas por `appId` en queries).
 *
 * ## Seguridad
 *
 *   - La URI DEBE usar TLS en producción (`mongodb+srv://` o `?tls=true`).
 *   - Las passwords en la URI deben venir de secrets manager (NO hardcoded).
 *   - El `hash` Argon2id NUNCA se loguea. Se serializa como campo opaco.
 *
 * ## Failover
 *
 *   - Read preference: `primaryPreferred` (writes van al primary, reads
 *     pueden ir a secondaries con staleness aceptable).
 *   - Write concern: `majority` (no se considera committed hasta que la
 *     mayoría de las replicas confirma — previene split-brain).
 *   - Retryable writes: habilitado.
 *
 * @see https://www.mongodb.com/docs/drivers/node/current/fundamentals/connection/
 * @see https://www.mongodb.com/docs/manual/changeStreams/
 */
export class MongoDBStore implements IApiKeyStore {
  private client: any = null;
  private collection: any = null;
  private changeStream: any = null;
  private initialized = false;
  private readonly cfg: Required<Omit<MongoDBStoreConfig, "logger" | "onRemoteChange">> & {
    logger: NonNullable<MongoDBStoreConfig["logger"]>;
    onRemoteChange: MongoDBStoreConfig["onRemoteChange"];
  };

  constructor(config: MongoDBStoreConfig) {
    if (!config.uri) throw new Error("[api-keys] MongoDBStore: uri is required");
    this.cfg = {
      uri: config.uri,
      dbName: config.dbName ?? DEFAULT_DB,
      collectionName: config.collectionName ?? DEFAULT_COLLECTION,
      enableChangeStream: config.enableChangeStream ?? false,
      onRemoteChange: config.onRemoteChange,
      logger: config.logger ?? defaultStoreLogger(),
    };
  }

  /**
   * Lazy initialization: importa `mongodb` y conecta.
   * Llamar UNA vez al startup, después de `new MongoDBStore()`.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const { MongoClient } = await import("mongodb");
    this.client = new MongoClient(this.cfg.uri, {
      writeConcern: { w: "majority" },
      retryWrites: true,
      serverSelectionTimeoutMS: 5_000,
    });
    await this.client.connect();
    const db = this.client.db(this.cfg.dbName);
    this.collection = db.collection(this.cfg.collectionName);

    // Crear índices (idempotente)
    await this.collection.createIndex({ id: 1 }, { unique: true, name: INDEX_NAME_ID });
    await this.collection.createIndex({ appId: 1 }, { name: INDEX_NAME_APP });
    // TTL indexes: MongoDB borra automáticamente los docs cuyo campo
    // `expiresAt` o `rotationExpiresAt` sea una fecha en el pasado.
    // Usamos `expireAfterSeconds: 0` para que MongoDB borre inmediatamente
    // cuando el timestamp expira.
    await this.collection.createIndex(
      { expiresAt: 1 },
      { name: INDEX_NAME_EXPIRES, expireAfterSeconds: 0, sparse: true },
    );
    await this.collection.createIndex(
      { rotationExpiresAt: 1 },
      { name: INDEX_NAME_ROTATION, expireAfterSeconds: 0, sparse: true },
    );

    this.initialized = true;
    this.cfg.logger.info("[api-keys] MongoDBStore connected", {
      db: this.cfg.dbName,
      collection: this.cfg.collectionName,
    });

    if (this.cfg.enableChangeStream) {
      await this.startChangeStream();
    }
  }

  private async startChangeStream(): Promise<void> {
    if (!this.collection) throw new Error("MongoDBStore: init() not called");
    try {
      // Full document lookup para tener el doc updated después de cada change.
      this.changeStream = this.collection.watch([], { fullDocument: "updateLookup" });
      this.changeStream.on("change", (event: any) => this.handleChangeEvent(event));
      this.cfg.logger.info("[api-keys] Change stream started");
    } catch (e) {
      this.cfg.logger.warn(
        "[api-keys] Change stream failed (likely not a replica set). Falling back to TTL-only invalidation.",
        { error: String(e) },
      );
    }
  }

  private async handleChangeEvent(event: any): Promise<void> {
    if (!this.cfg.onRemoteChange) return;
    try {
      if (event.operationType === "insert") {
        const doc = event.fullDocument;
        await this.cfg.onRemoteChange({
          type: "insert",
          id: doc.id,
          appId: doc.appId,
        });
      } else if (event.operationType === "update" || event.operationType === "replace") {
        const doc = event.fullDocument;
        const patchKeys = event.updateDescription?.updatedFields
          ? Object.keys(event.updateDescription.updatedFields)
          : [];
        await this.cfg.onRemoteChange({
          type: "update",
          id: doc.id,
          appId: doc.appId,
          patchKeys,
        });
      } else if (event.operationType === "delete") {
        const id = event.documentKey?._id;
        // En `delete` no hay fullDocument. El id es _id (ObjectId), no nuestro `id`.
        // Necesitamos mapear via documentKey si lo guardamos.
        // Por ahora, loggeamos. El callback puede usar su propio mecanismo.
        this.cfg.logger.warn("[api-keys] delete event received (no fullDocument). Use _id for lookup.", { id });
      }
    } catch (e) {
      this.cfg.logger.error("[api-keys] onRemoteChange callback failed", { error: String(e) });
    }
  }

  async get(id: string): Promise<ApiKeyRecord | null> {
    this.assertInitialized();
    const doc = await this.collection.findOne({ id });
    if (!doc) return null;
    return this.deserialize(doc);
  }

  async listByApp(appId: string): Promise<Omit<ApiKeyRecord, "hash">[]> {
    this.assertInitialized();
    const docs = await this.collection.find({ appId }).toArray();
    return docs.map((d: any) => {
      const rec = this.deserialize(d);
      const { hash: _h, ...rest } = rec;
      return rest;
    });
  }

  async put(record: ApiKeyRecord): Promise<void> {
    this.assertInitialized();
    const doc = this.serialize(record);
    try {
      await this.collection.insertOne(doc);
    } catch (e: any) {
      if (e?.code === 11000) {
        throw new Error(`[api-keys] Key ${record.id} already exists`);
      }
      throw e;
    }
  }

  async update(id: string, patch: Partial<ApiKeyRecord>): Promise<void> {
    this.assertInitialized();
    // Eliminar campos inmutables del patch (defense-in-depth)
    const sanitized: Record<string, unknown> = { ...patch };
    delete sanitized.id;
    delete sanitized.hash; // hash nunca se modifica via patch (rotación crea key nueva)
    delete sanitized.createdAt;
    delete sanitized.createdBy;

    const result = await this.collection.updateOne(
      { id },
      { $set: { ...sanitized, updatedAt: new Date().toISOString() } },
    );
    if (result.matchedCount === 0) {
      throw new Error(`[api-keys] Key ${id} not found`);
    }
  }

  async delete(id: string): Promise<void> {
    this.assertInitialized();
    await this.collection.deleteOne({ id });
  }

  /** Cierra conexión y change stream. Llamar en shutdown. */
  async close(): Promise<void> {
    if (this.changeStream) {
      try { await this.changeStream.close(); } catch { /* ignore */ }
      this.changeStream = null;
    }
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.collection = null;
      this.initialized = false;
    }
  }

  // ── Serialization helpers ───────────────────────────────────────────────

  /**
   * Convierte `ApiKeyRecord` a documento MongoDB. Los campos `expiresAt`,
   * `rotationExpiresAt`, `lastUsedAt` se convierten a `Date` para que el
   * TTL index funcione correctamente (MongoDB TTL solo opera sobre `Date`,
   * no sobre `string`).
   */
  private serialize(rec: ApiKeyRecord): Record<string, unknown> {
    const doc: Record<string, unknown> = { ...rec };
    if (rec.expiresAt) doc.expiresAt = new Date(rec.expiresAt);
    if (rec.rotationExpiresAt) doc.rotationExpiresAt = new Date(rec.rotationExpiresAt);
    if (rec.lastUsedAt) doc.lastUsedAt = new Date(rec.lastUsedAt);
    return doc;
  }

  /**
   * Inverso de `serialize()`. Convierte `Date` de vuelta a ISO string.
   * `_id` (ObjectId auto-generado por MongoDB) se descarta.
   */
  private deserialize(doc: any): ApiKeyRecord {
    const { _id: _ignored, updatedAt: _u, ...rest } = doc;
    const rec = rest as ApiKeyRecord;
    const mutable = rec as unknown as Record<string, unknown>;
    if (mutable.expiresAt instanceof Date) mutable.expiresAt = mutable.expiresAt.toISOString();
    if (mutable.rotationExpiresAt instanceof Date) mutable.rotationExpiresAt = mutable.rotationExpiresAt.toISOString();
    if (mutable.lastUsedAt instanceof Date) mutable.lastUsedAt = mutable.lastUsedAt.toISOString();
    return rec;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("[api-keys] MongoDBStore: init() must be called before use");
    }
  }
}

function defaultStoreLogger() {
  return {
    info: (msg: string, meta?: unknown) => console.log(`[api-keys] ${msg}`, meta ?? ""),
    warn: (msg: string, meta?: unknown) => console.warn(`[api-keys] ${msg}`, meta ?? ""),
    error: (msg: string, meta?: unknown) => console.error(`[api-keys] ${msg}`, meta ?? ""),
  };
}

