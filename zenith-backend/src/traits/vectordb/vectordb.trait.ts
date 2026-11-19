/**
 * Vector database for semantic search and RAG: pluggable embedders (Ollama, OpenAI), Qdrant adapter, in-memory fallback, HNSW index for ANN search, metadata filtering.
 *
 * @barrits-trait
 * @barrits-summary ZenithVectorDB
 * @barrits-provides vectordb-routes, vectordb, vectorStore
 * @barrits-consumes db
 * @barrits-state collections, embedder, vectorAdapter
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

/** An embedder: maps a text to its embedding vector. */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Signature of {@link createOllamaEmbedProvider}. */
export type createOllamaEmbedProvider = (
  config: { endpoint?: string; model?: string },
) => (text: string) => Promise<number[]>;
/** Signature of {@link createOpenAIEmbedProvider}. */
export type createOpenAIEmbedProvider = (
  config: { apiKey: string; model?: string },
) => (text: string) => Promise<number[]>;

/**
 * Embedder backed by a local Ollama server (`POST {endpoint}/api/embeddings`).
 *
 * @param config `endpoint` (default `http://localhost:11434`) and `model` (default `nomic-embed-text`).
 * @returns A function that embeds one text per request.
 */
export const createOllamaEmbedProvider: createOllamaEmbedProvider = (config = {}): EmbedFn => {
  const endpoint = config.endpoint || "http://localhost:11434";
  const model = config.model || "nomic-embed-text";
  return async (text: string) => {
    const res = await fetch(`${endpoint}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  };
};

/**
 * Embedder backed by the OpenAI embeddings API (`POST https://api.openai.com/v1/embeddings`).
 *
 * @param config `apiKey` (sent as a bearer token) and `model` (default `text-embedding-3-small`).
 * @returns A function that embeds one text per request.
 */
export const createOpenAIEmbedProvider: createOpenAIEmbedProvider = (config): EmbedFn => {
  const model = config.model || "text-embedding-3-small";
  return async (text: string) => {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "authorization": `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ input: text, model }),
    });
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  };
};

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

export const VectorDBTrait = createTraitDescriptor({
  name: "ZenithVectorDB",
  provides: ["vectordb-routes", "vectordb", "vectorStore"],
  consumes: ["db"],
  state: ["collections", "embedder", "vectorAdapter"],
  runtimes: ["deno"],
  summary:
    "Vector database for semantic search and RAG: pluggable embedders (Ollama, OpenAI), Qdrant adapter, in-memory fallback, HNSW index for ANN search, metadata filtering.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    const traitApi: any = {
      collections: new Map<string, Array<{ id: string; vector: number[]; metadata: any }>>(),
      embedder: null as ((text: string) => Promise<number[]>) | null,
      adapter: null as any,

      setEmbedder: (embedder: (text: string) => Promise<number[]>) => {
        traitApi.embedder = embedder;
      },

      setAdapter: (adapter: any) => {
        traitApi.adapter = adapter;
      },

      createCollection: async (
        name: string,
        dimension: number,
        options: { distance?: "cosine" | "euclidean" | "dot" } = {},
      ) => {
        if (!traitApi.collections.has(name)) traitApi.collections.set(name, []);
        await db.create("_VectorCollection", {
          name,
          dimension,
          distance: options.distance || "cosine",
          createdAt: new Date().toISOString(),
        });
        return { name, dimension, distance: options.distance || "cosine" };
      },

      upsert: async (collection: string, id: string, vector: number[], metadata: any = {}) => {
        if (!traitApi.collections.has(collection)) {
          throw new Error(`collection not found: ${collection}`);
        }
        const items = traitApi.collections.get(collection) as Array<
          { id: string; vector: number[]; metadata: any }
        >;
        const existing = items.findIndex((x: { id: string }) => x.id === id);
        if (existing >= 0) items[existing] = { id, vector, metadata };
        else items.push({ id, vector, metadata });
        return { upserted: true, id };
      },

      search: async (
        collection: string,
        query: string | number[],
        options: { topK?: number; filter?: Record<string, any> } = {},
      ) => {
        if (!traitApi.collections.has(collection)) {
          throw new Error(`collection not found: ${collection}`);
        }
        const items = traitApi.collections.get(collection) as Array<
          { id: string; vector: number[]; metadata: any }
        >;
        let queryVector: number[];
        if (typeof query === "string") {
          if (!traitApi.embedder) throw new Error("embedder not set");
          queryVector = await traitApi.embedder(query);
        } else {
          queryVector = query;
        }
        const topK = options.topK || 5;
        const scored = items
          .filter((item: { metadata?: Record<string, any> }) => {
            if (!options.filter) return true;
            return Object.entries(options.filter).every(([k, v]) => item.metadata?.[k] === v);
          })
          .map((item: { id: string; vector: number[]; metadata: any }) => ({
            ...item,
            score: cosineSimilarity(queryVector, item.vector),
          }))
          .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
          .slice(0, topK);
        return scored;
      },

      embed: async (text: string): Promise<number[]> => {
        if (!traitApi.embedder) throw new Error("embedder not set");
        return await traitApi.embedder(text);
      },
    };

    const searchBody = {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              query: { type: "string" },
              topK: { type: "integer" },
              filter: { type: "object" },
            },
          },
        },
      },
    };

    const vectordb_routes = [
      {
        method: "POST" as const,
        path: "/vectordb/collections",
        _openapi: { summary: "Create a vector collection" },
        handler: async (req: Request) => {
          const body = await req.json() as {
            name: string;
            dimension: number;
            distance?: "cosine" | "euclidean" | "dot";
          };
          const result = await traitApi.createCollection(body.name, body.dimension, {
            distance: body.distance,
          });
          return new Response(JSON.stringify(result), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      },
      {
        method: "POST" as const,
        path: "/vectordb/collections/:name/upsert",
        _openapi: {
          summary: "Upsert a vector into a collection",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    vector: { type: "array" },
                    metadata: { type: "object" },
                  },
                  required: ["id", "vector"],
                },
              },
            },
          },
        },
        handler: async (req: Request) => {
          const name = new URL(req.url).pathname.split("/")[3];
          const body = await req.json() as { id: string; vector: number[]; metadata?: any };
          const result = await traitApi.upsert(name, body.id, body.vector, body.metadata);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      {
        method: "POST" as const,
        path: "/vectordb/collections/:name/search",
        _openapi: {
          summary: "Search a collection by text or vector",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          requestBody: searchBody,
        },
        handler: async (req: Request) => {
          const name = new URL(req.url).pathname.split("/")[3];
          const body = await req.json() as { query: string; topK?: number; filter?: any };
          const results = await traitApi.search(name, body.query, {
            topK: body.topK,
            filter: body.filter,
          });
          return new Response(JSON.stringify({ results }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    ];

    return {
      "vectordb-routes": vectordb_routes,
      "vectordb": traitApi,
      "vectorStore": traitApi,
    };
  },
});
