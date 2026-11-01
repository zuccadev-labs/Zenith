import type { GraphAdapter } from "../../core/types.ts";

/**
 * Creates a Neo4j graph database adapter implementing the standard GraphAdapter interface.
 * Enables deep relationship traversal via Cypher queries against a Neo4j cluster.
 * Currently provides a mock implementation — replace with actual neo4j-driver in production.
 *
 * @returns GraphAdapter — interface for Cypher execution and connection management
 */
export function createNeo4jAdapter(): GraphAdapter {
  let isConnected = false;

  return {
    connect: async (uri: string, _user: string, _pass: string): Promise<void> => {
      // Mock: driver de neo4j
      console.log(`[Neo4jAdapter] Conectado a clúster Graph en ${uri}`);
      isConnected = true;
    },

    runCypher: async (query: string, _params?: Record<string, any>): Promise<any[]> => {
      if (!isConnected) throw new Error("Neo4j not connected");
      console.log(`[Neo4j] Executing Cypher: ${query}`);
      // Mock result
      return [{ n: { properties: { objectId: "node_123" } } }];
    },

    disconnect: async (): Promise<void> => {
      isConnected = false;
      console.log(`[Neo4jAdapter] Desconectado.`);
    }
  };
}
