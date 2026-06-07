/**
 * @module @zenith/adapters/vectordb/qdrant
 *
 * Adaptador Qdrant para Zenith VectorDB Trait.
 * Qdrant es un vector DB de alto rendimiento escrito en Rust.
 *
 * Usa la API HTTP REST de Qdrant (sin SDK) para máxima portabilidad.
 * Docs: https://qdrant.tech/documentation/interfaces/rest-api/
 *
 * Infra lab: http://localhost:56333
 * API Key: QDRANT__SERVICE__API_KEY del .env
 */

export interface QdrantConfig {
  url: string;     // ej. "http://localhost:56333"
  apiKey?: string; // ej. "zenithqdrant"
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload?: Record<string, any>;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  payload?: Record<string, any>;
  vector?: number[];
}

export interface VectorSearchOptions {
  topK?: number;
  filter?: Record<string, any>;
  withPayload?: boolean;
  withVector?: boolean;
  scoreThreshold?: number;
}

/**
 * Interfaz estándar de VectorDB para Zenith.
 * Permite cambiar el backend (Qdrant → pgvector → Weaviate) sin tocar el código de negocio.
 */
export interface VectorDBAdapter {
  /** Crear una colección vectorial si no existe */
  ensureCollection(name: string, vectorSize: number, distance?: "Cosine" | "Dot" | "Euclid"): Promise<void>;
  /** Insertar o actualizar puntos (upsert semántico) */
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  /** Búsqueda por similitud de vector */
  search(collection: string, vector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  /** Búsqueda por texto usando un vector pre-computado (RAG helper) */
  searchByText?(collection: string, embedding: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  /** Eliminar puntos por ID */
  delete(collection: string, ids: string[]): Promise<void>;
  /** Obtener punto por ID */
  get(collection: string, id: string): Promise<VectorPoint | null>;
  /** Listar colecciones */
  listCollections(): Promise<string[]>;
  /** Eliminar colección completa */
  dropCollection(collection: string): Promise<void>;
}

/**
 * Convierte el formato de filter Zenith al formato de filter Qdrant.
 * Zenith usa un objeto plano key:value → Qdrant usa { must: [{ key, match: { value } }] }
 */
function buildQdrantFilter(filter?: Record<string, any>): any {
  if (!filter || Object.keys(filter).length === 0) return undefined;

  const must: any[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      must.push({ key, match: { any: value } });
    } else if (value && typeof value === "object") {
      // Soporte para rangos: { $gte: 0, $lte: 100 }
      const range: any = {};
      if (value.$gte !== undefined) range.gte = value.$gte;
      if (value.$lte !== undefined) range.lte = value.$lte;
      if (value.$gt !== undefined)  range.gt = value.$gt;
      if (value.$lt !== undefined)  range.lt = value.$lt;
      if (Object.keys(range).length > 0) {
        must.push({ key, range });
      }
    } else {
      must.push({ key, match: { value } });
    }
  }

  return must.length > 0 ? { must } : undefined;
}

export function createQdrantAdapter(config: QdrantConfig): VectorDBAdapter {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (config.apiKey) headers["api-key"] = config.apiKey;

  const req = async (method: string, path: string, body?: any): Promise<any> => {
    const res = await fetch(`${config.url}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`[Qdrant] ${method} ${path} → HTTP ${res.status}: ${errBody}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  return {
    async ensureCollection(name, vectorSize, distance = "Cosine") {
      try {
        await req("GET", `/collections/${name}`);
        // Colección ya existe — no hacer nada
      } catch {
        // Crear la colección
        await req("PUT", `/collections/${name}`, {
          vectors: {
            size: vectorSize,
            distance,
          },
          optimizers_config: {
            default_segment_number: 2,
          },
          replication_factor: 1,
        });
        console.log(`[Qdrant] ✅ Collection '${name}' created (dim=${vectorSize}, dist=${distance})`);
      }
    },

    async upsert(collection, points) {
      const qdrantPoints = points.map(p => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload ?? {},
      }));

      await req("PUT", `/collections/${collection}/points`, {
        points: qdrantPoints,
      });
    },

    async search(collection, vector, options = {}) {
      const body: any = {
        vector,
        limit: options.topK ?? 10,
        with_payload: options.withPayload ?? true,
        with_vector: options.withVector ?? false,
      };

      if (options.filter) body.filter = buildQdrantFilter(options.filter);
      if (options.scoreThreshold !== undefined) body.score_threshold = options.scoreThreshold;

      const result = await req("POST", `/collections/${collection}/points/search`, body);
      return (result?.result ?? []).map((r: any) => ({
        id: String(r.id),
        score: r.score,
        payload: r.payload,
        vector: r.vector,
      })) as VectorSearchResult[];
    },

    async searchByText(collection, embedding, options = {}) {
      return this.search(collection, embedding, options);
    },

    async delete(collection, ids) {
      await req("POST", `/collections/${collection}/points/delete`, {
        points: ids,
      });
    },

    async get(collection, id) {
      try {
        const result = await req("GET", `/collections/${collection}/points/${id}`);
        const r = result?.result;
        if (!r) return null;
        return { id: String(r.id), vector: r.vector ?? [], payload: r.payload };
      } catch {
        return null;
      }
    },

    async listCollections() {
      const result = await req("GET", "/collections");
      return (result?.result?.collections ?? []).map((c: any) => c.name);
    },

    async dropCollection(collection) {
      await req("DELETE", `/collections/${collection}`);
      console.log(`[Qdrant] 🗑️ Collection '${collection}' dropped.`);
    },
  };
}
