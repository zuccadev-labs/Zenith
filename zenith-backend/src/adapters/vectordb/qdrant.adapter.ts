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

/** Connection settings of a Qdrant server. */
export interface QdrantConfig {
  /** Base URL of the Qdrant REST API, e.g. `http://localhost:56333`. */
  url: string;
  /** API key sent as the `api-key` header, when the server requires one. */
  apiKey?: string;
}

/** A vector stored in a collection, with its id and optional metadata payload. */
export interface VectorPoint {
  /** Point id, unique within the collection. */
  id: string;
  /** The embedding; its length must match the collection's vector size. */
  vector: number[];
  /** Metadata stored with the point; filters match against it. */
  payload?: Record<string, any>;
}

/** One hit of a similarity search. */
export interface VectorSearchResult {
  /** Id of the matching point. */
  id: string;
  /** Similarity score under the collection's distance (higher is closer for Cosine and Dot). */
  score: number;
  /** The point's payload, when requested with `withPayload`. */
  payload?: Record<string, any>;
  /** The point's vector, when requested with `withVector`. */
  vector?: number[];
}

/** Options of a similarity search. */
export interface VectorSearchOptions {
  /** Maximum number of hits returned (default 10). */
  topK?: number;
  /**
   * Payload filter: `key: value` for equality, `key: [a, b]` for any-of, and
   * `key: { $gte, $lte, $gt, $lt }` for ranges; all conditions must hold.
   */
  filter?: Record<string, any>;
  /** Whether to return each hit's payload. */
  withPayload?: boolean;
  /** Whether to return each hit's vector. */
  withVector?: boolean;
  /** Hits scoring below this value are dropped. */
  scoreThreshold?: number;
}

/**
 * Standard Zenith VectorDB interface.
 * Lets the backend change (Qdrant, pgvector, Weaviate) without touching business code.
 */
export interface VectorDBAdapter {
  /** Creates a vector collection with the given size and distance if it does not exist. */
  ensureCollection(
    name: string,
    vectorSize: number,
    distance?: "Cosine" | "Dot" | "Euclid",
  ): Promise<void>;
  /** Inserts or replaces points by id. */
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  /** Returns the points most similar to `vector`. */
  search(
    collection: string,
    vector: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;
  /** Text search using an embedding computed beforehand (RAG helper). */
  searchByText?(
    collection: string,
    embedding: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;
  /** Deletes points by id. */
  delete(collection: string, ids: string[]): Promise<void>;
  /** Returns a point by id, or null when it does not exist. */
  get(collection: string, id: string): Promise<VectorPoint | null>;
  /** Lists the collection names. */
  listCollections(): Promise<string[]>;
  /** Deletes a whole collection. */
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
      if (value.$gt !== undefined) range.gt = value.$gt;
      if (value.$lt !== undefined) range.lt = value.$lt;
      if (Object.keys(range).length > 0) {
        must.push({ key, range });
      }
    } else {
      must.push({ key, match: { value } });
    }
  }

  return must.length > 0 ? { must } : undefined;
}

/**
 * Creates a Qdrant vector database adapter implementing the VectorDBAdapter interface.
 * Communicates with Qdrant over its HTTP REST API (no SDK required) for collection management,
 * vector upsert, similarity search, filtering, and full lifecycle operations.
 *
 * @param config - QdrantConfig with server URL and optional API key
 * @returns VectorDBAdapter — full vector database CRUD and search interface
 */
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
        console.log(
          `[Qdrant] ✅ Collection '${name}' created (dim=${vectorSize}, dist=${distance})`,
        );
      }
    },

    async upsert(collection, points) {
      const qdrantPoints = points.map((p) => ({
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
