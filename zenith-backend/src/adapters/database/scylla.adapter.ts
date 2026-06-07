import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { DatabaseAdapter, ZenithQuery, ZenithObject } from "../../core/types.ts";
import type { Client } from "cassandra-driver";

/**
 * PLUGIN ESTÁNDAR: Adaptador Puro de ScyllaDB/Cassandra
 */
export function createScyllaAdapter(client: Client): DatabaseAdapter {
  return {
    connect: async () => { /* Manejado por el inyector padre */ },
    disconnect: async () => { /* Manejado por el inyector padre */ },
    
    find: async (collection: string, _query: ZenithQuery): Promise<ZenithObject[]> => {
      // Simulación de CQL: SELECT * FROM {collection} WHERE ...
      // El plugin procesaría query.where y lo convertiría a CQL puro.
      const queryStr = `SELECT * FROM ${collection}`;
      const result = await client.execute(queryStr, [], { prepare: true });
      return result.rows as unknown as ZenithObject[];
    },

    findOne: async (collection: string, query: ZenithQuery): Promise<ZenithObject | null> => {
      // Convertir query.where a un CQL seguro
      const conditions = Object.keys(query.where || {}).map(k => `${k} = ?`).join(" AND ");
      const values = Object.values(query.where || {});
      const queryStr = `SELECT * FROM ${collection} ${conditions ? "WHERE " + conditions : ""} LIMIT 1`;
      
      const result = await client.execute(queryStr, values, { prepare: true });
      return result.rows.length > 0 ? (result.rows[0] as unknown as ZenithObject) : null;
    },

    insert: async (collection: string, data: ZenithObject): Promise<ZenithObject> => {
      const keys = Object.keys(data).filter(k => k !== 'objectId'); // En Scylla, objectId es usualmente id (UUID)
      const values = keys.map(k => data[k]);
      const placeholders = keys.map(() => "?").join(", ");
      
      const queryStr = `INSERT INTO ${collection} (id, ${keys.join(", ")}) VALUES (uuid(), ${placeholders})`;
      await client.execute(queryStr, values, { prepare: true });
      return data;
    },

    update: async (collection: string, objectId: string, data: Partial<ZenithObject>): Promise<ZenithObject> => {
      const keys = Object.keys(data);
      const values = keys.map(k => data[k]);
      const setClause = keys.map(k => `${k} = ?`).join(", ");
      
      const queryStr = `UPDATE ${collection} SET ${setClause} WHERE id = ?`;
      await client.execute(queryStr, [...values, objectId], { prepare: true });
      return { objectId, ...data } as ZenithObject;
    },

    delete: async (collection: string, objectId: string): Promise<void> => {
      await client.execute(`DELETE FROM ${collection} WHERE id = ?`, [objectId], { prepare: true });
    }
  };
}

/**
 * TRAIT BARRITS: Inyector del plugin de ScyllaDB
 */
export const DatabaseScyllaTrait = createTraitDescriptor({
  name: "ZenithDatabaseScylla",
  provides: ["database-crud", "injectScyllaPlugin"],
  consumes: [],
  state: ["scylla_plugin"],
  runtimes: ["deno"],
  create: (_deps: Record<string, any>) => {
    
    let dbAdapter: DatabaseAdapter | null = null;

    const traitApi = {
      injectScyllaPlugin: (plugin: DatabaseAdapter) => {
        dbAdapter = plugin;
        console.log("[ScyllaTrait] ScyllaDB Plugin Injected");
      },
      // Exponemos la interfaz estándar bajo la llave "database-crud"
      "database-crud": {
        find: (col: string, q: ZenithQuery) => dbAdapter!.find(col, q),
        findOne: (col: string, q: ZenithQuery) => dbAdapter!.findOne(col, q),
        insert: (col: string, data: ZenithObject) => dbAdapter!.insert(col, data),
        update: (col: string, id: string, data: Partial<ZenithObject>) => dbAdapter!.update(col, id, data),
        delete: (col: string, id: string) => dbAdapter!.delete(col, id),
      }
    };
    return traitApi;
  }
});
