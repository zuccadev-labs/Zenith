/**
 * SurrealDB adapter for Zenith — Multi-model (document + graph + SQL) database integration.
 *
 * @barrits-trait
 * @barrits-summary ZenithDatabaseSurreal
 * @barrits-provides database-crud, surreal-client
 * @barrits-consumes
 * @barrits-state surrealAdapter, surrealClient
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { DatabaseAdapter, ZenithObject, ZenithQuery } from "../../core/types.ts";

/**
 * @module @zenith/adapters/database/surreal
 *
 * Adaptador SurrealDB para Zenith — Multi-Model: Document + Graph + SQL en uno.
 * SurrealDB expone una API HTTP/WS con SurrealQL. Este adaptador habla HTTP REST
 * usando fetch nativo de Deno para máxima compatibilidad sin dependencias nativas.
 *
 * Conexión: http://<host>:8000
 * Auth: Basic (user/pass) → Devuelve JWT de sesión
 *
 * Endpoints usados:
 *   POST /sql           → Ejecutar SurrealQL
 *   POST /key/:table    → Insert
 *   GET  /key/:table/:id → Get
 *   PUT  /key/:table/:id → Update completo
 *   PATCH /key/:table/:id → Partial update
 *   DELETE /key/:table/:id → Delete
 */

export interface SurrealConfig {
  url: string; // ej. "http://localhost:58000"
  user: string; // ej. "root"
  pass: string; // ej. "zenithlab"
  namespace: string; // ej. "zenith"
  database: string; // ej. "main"
}

/**
 * Cliente HTTP puro para SurrealDB — sin SDK externo.
 * Usa fetch nativo, compatible con Deno Edge.
 */
export class SurrealClient {
  private baseHeaders: Record<string, string>;
  private ensured: Promise<void> | null = null;

  constructor(private config: SurrealConfig) {
    // They go into DEFINE statements: identifiers only, never data.
    for (
      const [k, v] of [["namespace", config.namespace], ["database", config.database]] as const
    ) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(v))) {
        throw new Error(
          `[SurrealDB] Invalid ${k} name: ${JSON.stringify(v)}`,
        );
      }
    }
    const credentials = btoa(`${config.user}:${config.pass}`);
    this.baseHeaders = {
      "Authorization": `Basic ${credentials}`,
      "NS": config.namespace,
      "DB": config.database,
      // SurrealDB 2.x solo reconoce estos nombres
      "surreal-ns": config.namespace,
      "surreal-db": config.database,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };
  }

  async sql(query: string, vars?: Record<string, unknown>): Promise<any[]> {
    const body = vars
      ? query.replace(/\$(\w+)/g, (_, k) => JSON.stringify(vars[k] ?? null))
      : query;

    const res = await fetch(`${this.config.url}/sql`, {
      method: "POST",
      headers: { ...this.baseHeaders, "Content-Type": "text/plain" },
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`[SurrealDB] SQL error ${res.status}: ${err}`);
    }

    const results: any[] = await res.json();
    // SurrealDB devuelve array de resultados por statement
    return results;
  }

  /**
   * SurrealDB 3+ no longer creates the namespace and database on first use (2.x did): the adapter
   * failed with "The namespace 'zenith' does not exist". Created once, idempotently, when missing; an
   * account that may not define them gets the original error.
   */
  private ensureNamespaceAndDatabase(): Promise<void> {
    this.ensured ??= (async () => {
      const { namespace: ns, database: db } = this.config;
      const res = await fetch(`${this.config.url}/sql`, {
        method: "POST",
        headers: {
          Authorization: this.baseHeaders.Authorization,
          Accept: "application/json",
          "Content-Type": "text/plain",
        },
        body:
          `DEFINE NAMESPACE IF NOT EXISTS ${ns}; USE NS ${ns}; DEFINE DATABASE IF NOT EXISTS ${db};`,
      });
      if (!res.ok) {
        throw new Error(
          `[SurrealDB] Could not define namespace/database: ${res.status} ${await res.text()}`,
        );
      }
    })().catch((e) => {
      this.ensured = null;
      throw e;
    });
    return this.ensured;
  }

  /** Ejecuta una query SurrealQL y retorna los resultados del primer statement */
  async query<T = any>(surrealQL: string, vars?: Record<string, unknown>): Promise<T[]> {
    let results = await this.sql(surrealQL, vars);
    const missing = (r: any) =>
      r && r.status !== "OK" &&
      /(namespace|database) '[^']*' does not exist/i.test(String(r.detail ?? r.result ?? ""));
    if (missing(results[0])) {
      await this.ensureNamespaceAndDatabase();
      results = await this.sql(surrealQL, vars);
    }
    const first = results[0];
    // SurrealDB 3+ fails on a table nobody has written to yet (2.x returned nothing). For Zenith, as
    // for Parse, a class without objects is empty: reads, updates and deletes on it match nothing.
    if (
      first && first.status !== "OK" &&
      /The table '[^']*' does not exist/.test(String(first.detail ?? first.result ?? ""))
    ) {
      return [] as T[];
    }
    if (!first || first.status !== "OK") {
      throw new Error(
        `[SurrealDB] Query failed: ${first?.detail ?? first?.result ?? "unknown error"}`,
      );
    }
    return (first.result ?? []) as T[];
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.url}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Normaliza un documento SurrealDB al formato estándar Zenith.
 * SurrealDB usa "id" con formato "table:ulid" (ej. "GameScore:01h7x2...")
 * Lo convertimos a "objectId" (solo el ID parte) para compatibilidad Parse/Zenith.
 */
const deserialize = (doc: any): any => {
  if (!doc) return null;
  const out = { ...doc };
  if (out.id) {
    // "GameScore:01h7x2kz..." → "01h7x2kz..."
    const parts = String(out.id).split(":");
    out.objectId = parts.slice(1).join(":") || String(out.id);
  }
  return out;
};

/**
 * Convierte los operadores de query Zenith/Parse a SurrealQL WHERE clause.
 * Soporta: $gt, $gte, $lt, $lte, $ne, $in, $nin, $exists, $regex, $or, $and
 */
const buildWhereClause = (
  where: Record<string, any>,
  tableAlias = "",
  collection?: string,
): string => {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const clauses: string[] = [];

  for (const [key, val] of Object.entries(where)) {
    if (key === "$or") {
      const orClauses = (val as any[]).map((cond) =>
        `(${buildWhereClause(cond, tableAlias, collection)})`
      );
      clauses.push(`(${orClauses.join(" OR ")})`);
      continue;
    }
    if (key === "$and") {
      const andClauses = (val as any[]).map((cond) =>
        `(${buildWhereClause(cond, tableAlias, collection)})`
      );
      clauses.push(`(${andClauses.join(" AND ")})`);
      continue;
    }

    // El id es un record, no un string: compararlo con texto nunca coincide
    if (key === "objectId" && collection && typeof val === "string") {
      clauses.push(`id = type::record(${JSON.stringify(collection)}, ${JSON.stringify(val)})`);
      continue;
    }

    const field = key === "objectId" ? "id" : `${prefix}${key}`;

    if (val && typeof val === "object" && !Array.isArray(val)) {
      if (val.$gt !== undefined) clauses.push(`${field} > ${JSON.stringify(val.$gt)}`);
      if (val.$gte !== undefined) clauses.push(`${field} >= ${JSON.stringify(val.$gte)}`);
      if (val.$lt !== undefined) clauses.push(`${field} < ${JSON.stringify(val.$lt)}`);
      if (val.$lte !== undefined) clauses.push(`${field} <= ${JSON.stringify(val.$lte)}`);
      if (val.$ne !== undefined) clauses.push(`${field} != ${JSON.stringify(val.$ne)}`);
      if (val.$in !== undefined) clauses.push(`${field} INSIDE ${JSON.stringify(val.$in)}`);
      if (val.$nin !== undefined) clauses.push(`${field} NOT INSIDE ${JSON.stringify(val.$nin)}`);
      if (val.$exists === true) clauses.push(`type::is::none(${field}) = false`);
      if (val.$exists === false) clauses.push(`type::is::none(${field}) = true`);
      if (val.$regex !== undefined) clauses.push(`string::matches(${field}, /${val.$regex}/)`);
    } else {
      clauses.push(`${field} = ${JSON.stringify(val)}`);
    }
  }

  return clauses.length > 0 ? clauses.join(" AND ") : "true";
};

const MAX_CONFLICT_RETRIES = 30;

/** SurrealDB aborta las escrituras concurrentes sobre un registro y pide reintentarlas. */
async function retryOnConflict<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0;; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (
        attempt >= MAX_CONFLICT_RETRIES ||
        !String((err as Error).message).includes("can be retried")
      ) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * (attempt + 1)));
    }
  }
}

/**
 * Creates a standard Zenith DatabaseAdapter over SurrealDB via its HTTP REST API.
 * Translates Parse-compatible queries into SurrealQL, supporting filtering operators
 * ($gt, $gte, $lt, $lte, $ne, $in, $nin, $exists, $regex, $or, $and),
 * ordering, pagination, and atomic operations (Increment, AddUnique, Remove, Delete).
 *
 * @param client - Connected SurrealClient instance
 * @returns DatabaseAdapter — standard CRUD interface consumed by the Zenith pipeline
 */
export function createSurrealAdapter(client: SurrealClient): DatabaseAdapter {
  return {
    connect: async () => {
      const ok = await client.ping();
      if (!ok) {
        throw new Error("[SurrealDB] Cannot connect to SurrealDB. Check URL and credentials.");
      }
      console.log("[SurrealDB] ✅ Connected and healthy.");
    },

    disconnect: async () => {
      console.log("[SurrealDB] Disconnected (stateless HTTP — no action needed).");
    },

    find: async (collection: string, query: ZenithQuery): Promise<ZenithObject[]> => {
      let surrealQL = `SELECT * FROM ${collection}`;

      if (query.where && Object.keys(query.where).length > 0) {
        surrealQL += ` WHERE ${buildWhereClause(query.where, "", collection)}`;
      }

      if (query.order) {
        const fields = query.order.split(",").map((f) => f.trim());
        const orderParts = fields.map((f) =>
          f.startsWith("-") ? `${f.substring(1)} DESC` : `${f} ASC`
        );
        surrealQL += ` ORDER BY ${orderParts.join(", ")}`;
      }

      if (query.limit) surrealQL += ` LIMIT ${query.limit}`;
      if (query.skip) surrealQL += ` START ${query.skip}`;

      const docs = await client.query(surrealQL);
      return docs.map(deserialize) as ZenithObject[];
    },

    findOne: async (collection: string, query: ZenithQuery): Promise<ZenithObject | null> => {
      let surrealQL = `SELECT * FROM ${collection}`;
      if (query.where && Object.keys(query.where).length > 0) {
        surrealQL += ` WHERE ${buildWhereClause(query.where, "", collection)}`;
      }
      surrealQL += " LIMIT 1";

      const docs = await client.query(surrealQL);
      return docs.length > 0 ? deserialize(docs[0]) : null;
    },

    insert: async (collection: string, data: ZenithObject): Promise<ZenithObject> => {
      const payload: Record<string, unknown> = { ...data };
      delete payload.objectId; // SurrealDB genera su propio ID
      payload.createdAt = payload.createdAt ?? new Date().toISOString();
      payload.updatedAt = new Date().toISOString();

      const docs = await client.query(
        `CREATE ${collection} CONTENT ${JSON.stringify(payload)}`,
      );
      return deserialize(docs[0]);
    },

    update: async (
      collection: string,
      objectId: string,
      data: Partial<ZenithObject>,
    ): Promise<ZenithObject> => {
      const payload: Record<string, unknown> = { ...data };
      delete payload.objectId;
      payload.updatedAt = new Date().toISOString();

      // Soporte para operadores Zenith (__op: Increment, AddUnique, Remove, Delete)
      const $set: Record<string, any> = {};
      const mergeOps: string[] = [];

      for (const [key, val] of Object.entries(payload)) {
        if (val && typeof val === "object" && (val as any).__op) {
          const op = (val as any).__op;
          if (op === "Increment") mergeOps.push(`${key} += ${(val as any).amount}`);
          else if (op === "AddUnique") {
            mergeOps.push(
              `${key} += [${(val as any).objects.map((v: any) => JSON.stringify(v)).join(",")}]`,
            );
          } else if (op === "Remove") {
            mergeOps.push(
              `${key} -= [${(val as any).objects.map((v: any) => JSON.stringify(v)).join(",")}]`,
            );
          } else if (op === "Delete") mergeOps.push(`${key} = NONE`);
        } else {
          $set[key] = val;
        }
      }

      // Ejecutar MERGE para campos simples
      const recordId = `${collection}:${objectId}`;
      const surrealQL = `UPDATE ${recordId} MERGE ${JSON.stringify($set)}`;

      let docs = await retryOnConflict(() => client.query(surrealQL));
      // Los operadores no caben en MERGE: se aplican con SET
      if (mergeOps.length > 0) {
        docs = await retryOnConflict(() =>
          client.query(`UPDATE ${recordId} SET ${mergeOps.join(", ")}`)
        );
      }
      return deserialize(docs[0]);
    },

    updateIf: async (
      collection: string,
      objectId: string,
      conditions: Record<string, unknown>,
      data: Partial<ZenithObject>,
    ): Promise<ZenithObject | null> => {
      const field = (name: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid field name: ${name}`);
        return name;
      };
      const assignments = Object.entries({ ...data, updatedAt: new Date().toISOString() }).map(
        ([key, val]: [string, any]) => {
          if (val?.__op === "Increment") return `${field(key)} += ${Number(val.amount)}`;
          if (val?.__op) throw new Error(`updateIf does not support ${val.__op}`);
          return `${field(key)} = ${JSON.stringify(val)}`;
        },
      );
      const checks = Object.entries(conditions).map(([key, val]: [string, any]) =>
        val && typeof val === "object" && "$gte" in val
          ? `${field(key)} >= ${JSON.stringify(val.$gte)}`
          : `${field(key)} = ${JSON.stringify(val)}`
      );
      const record = `type::record(${JSON.stringify(field(collection))}, ${
        JSON.stringify(objectId)
      })`;
      const docs = await retryOnConflict(() =>
        client.query(
          `UPDATE ${record} SET ${assignments.join(", ")} WHERE ${
            checks.join(" AND ")
          } RETURN AFTER`,
        )
      );
      const doc = Array.isArray(docs[0]) ? docs[0][0] : docs[0];
      return doc ? deserialize(doc) : null;
    },

    delete: async (collection: string, objectId: string): Promise<void> => {
      await client.query(`DELETE ${collection}:${objectId}`);
    },
  };
}

/**
 * TRAIT BARRITS: Inyector del adaptador SurrealDB en el ecosistema Zenith.
 */
export const DatabaseSurrealTrait = createTraitDescriptor({
  name: "ZenithDatabaseSurreal",
  provides: ["database-crud", "surreal-client"],
  consumes: [],
  state: ["surrealAdapter", "surrealClient"],
  runtimes: ["deno"],
  create: (_deps: Record<string, unknown>) => {
    let adapter: DatabaseAdapter | null = null;
    let client: SurrealClient | null = null;

    return {
      /**
       * Inicializa la conexión a SurrealDB con los datos de configuración.
       * Llamar desde mod.ts antes de levantar el servidor HTTP.
       */
      initSurreal: async (config: SurrealConfig) => {
        client = new SurrealClient(config);
        adapter = createSurrealAdapter(client);
        await adapter.connect(config.url);
        console.log(
          `[SurrealTrait] ✅ SurrealDB connected (${config.url}) ns=${config.namespace} db=${config.database}`,
        );
      },

      /** Expone el cliente SurrealDB crudo para queries avanzados con SurrealQL */
      "surreal-client": {
        query: (surrealQL: string, vars?: Record<string, unknown>) => {
          if (!client) throw new Error("[SurrealTrait] Not initialized. Call initSurreal() first.");
          return client.query(surrealQL, vars);
        },
        sql: (surrealQL: string) => {
          if (!client) throw new Error("[SurrealTrait] Not initialized.");
          return client.sql(surrealQL);
        },
      },

      // Interface estándar Zenith DatabaseAdapter
      "database-crud": {
        find: (col: string, q: ZenithQuery) => adapter!.find(col, q),
        findOne: (col: string, q: ZenithQuery) => adapter!.findOne(col, q),
        insert: (col: string, data: ZenithObject) => adapter!.insert(col, data),
        update: (col: string, id: string, data: Partial<ZenithObject>) =>
          adapter!.update(col, id, data),
        delete: (col: string, id: string) => adapter!.delete(col, id),
      },
    };
  },
});
