/**
 * OpenSearch / Elasticsearch adapter for Zenith — Full-text and vector search.
 *
 * @barrits-trait
 * @barrits-summary ZenithOpenSearch
 * @barrits-provides search-engine, injectPlugin
 * @barrits-consumes
 * @barrits-state plugin
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { SearchAdapter } from "../../core/types.ts";

/**
 * Creates a pure OpenSearch / Elasticsearch adapter implementing the SearchAdapter interface.
 * Supports document indexing, full-text search, k-NN vector search (semantic), and document deletion.
 * Compatible with AWS OpenSearch and Elasticsearch >= 7.x.
 *
 * @param client - OpenSearch/Elasticsearch client instance (from @opensearch-project/opensearch or @elastic/elasticsearch)
 * @returns SearchAdapter — search and indexing interface consumed by the Zenith pipeline
 */
export function createOpenSearchAdapter(client: any): SearchAdapter {
  return {
    connect: async () => { /* Manejado por el SDK del cliente */ },
    disconnect: async () => { /* Manejado por el SDK del cliente */ },
    
    indexDocument: async (index: string, id: string, document: any): Promise<void> => {
      await client.index({
        index: index.toLowerCase(),
        id,
        body: document,
        refresh: true
      });
    },

    search: async (index: string, query: Record<string, any>, options?: { limit?: number; skip?: number }): Promise<any[]> => {
      const response = await client.search({
        index: index.toLowerCase(),
        body: {
          query,
          size: options?.limit || 100,
          from: options?.skip || 0
        }
      });
      return response.body.hits.hits.map((hit: any) => ({ ...hit._source, _score: hit._score }));
    },

    /**
     * Búsqueda Semántica/Vectorial (k-NN)
     * Utiliza la funcionalidad k-NN nativa de OpenSearch para IA.
     */
    vectorSearch: async (index: string, vectorField: string, vector: number[], limit = 10): Promise<any[]> => {
      const response = await client.search({
        index: index.toLowerCase(),
        body: {
          size: limit,
          query: {
            knn: {
              [vectorField]: {
                vector,
                k: limit
              }
            }
          }
        }
      });
      return response.body.hits.hits.map((hit: any) => ({ ...hit._source, _score: hit._score }));
    },

    deleteDocument: async (index: string, id: string): Promise<void> => {
      await client.delete({
        index: index.toLowerCase(),
        id,
        refresh: true
      });
    }
  };
}

/**
 * TRAIT BARRITS: Inyector del motor de Búsqueda OpenSearch
 */
export const OpenSearchTrait = createTraitDescriptor({
  name: "ZenithOpenSearch",
  provides: ["search-engine", "injectPlugin"],
  consumes: [],
  state: ["plugin"],
  runtimes: ["deno"],
  create: (_deps: Record<string, unknown>) => {
    let adapter: SearchAdapter | null = null;
    return {
      injectPlugin: (plugin: SearchAdapter) => {
        adapter = plugin;
        console.log("[OpenSearchTrait] OpenSearch/ElasticSearch Plugin Injected");
      },
      // Exponemos la interfaz al resto de Zenith
      "search-engine": {
        indexDocument: (idx: string, id: string, doc: any) => adapter!.indexDocument(idx, id, doc),
        search: (idx: string, q: any, opt: any) => adapter!.search(idx, q, opt),
        vectorSearch: (idx: string, field: string, vec: number[], limit: number) => adapter!.vectorSearch(idx, field, vec, limit),
        deleteDocument: (idx: string, id: string) => adapter!.deleteDocument(idx, id)
      }
    };
  }
});
