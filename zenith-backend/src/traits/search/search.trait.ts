// deno-lint-ignore-file no-unused-vars
/**
 * Search Trait — Full-text search global + filtros avanzados.
 *
 * Indexa Contact, Deal, Lead, Account, Product, Note (bodyText)
 * en un solo endpoint unificado con relevancia por score.
 * Reutiliza el FilterParser de trait-utils para condiciones avanzadas.
 *
 * @barrits-trait
 * @barrits-summary ZenithSearch
 * @barrits-provides search_routes, search
 * @barrits-consumes db
 * @barrits-tags uses:vectordb
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import {
  applyFilter,
  errRes,
  jsonRes,
  parseFilterParam,
  sortResults,
} from "../../core/trait-utils.ts";

/** Configuración de qué campos se indexan por clase */
const SEARCH_INDEX: Record<string, string[]> = {
  Contact: ["name", "email", "phone", "company", "title", "notes"],
  Lead: ["stage", "currency"],
  Deal: ["title", "pipeline", "stage"],
  Account: ["name", "email", "industry", "website"],
  Product: ["name", "sku", "description", "category"],
  Note: ["title", "bodyText"],
  Task: ["title", "body"],
  Employee: ["name", "email", "role", "department"],
};

/**
 * Search trait: one full-text search endpoint over the business classes (contacts, deals, leads,
 * accounts, products, notes…) ranked by score, plus suggestions (`/zen/search`,
 * `/zen/search/suggest`).
 */
export const SearchTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithSearch",
  provides: ["search_routes", "search"],
  consumes: ["db"],
  tags: ["uses:vectordb"],
  state: [],
  runtimes: ["deno"],

  summary:
    "Global full-text search across CRM/ERP records. Advanced filter engine (eq/neq/gt/lt/in/like/ilike). Optional AI semantic search via VectorDB.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const vectordb = deps.traits["vectordb"];

    const api = {
      /**
       * Búsqueda full-text en memoria (fallback cuando no hay VectorDB).
       * Para producción con VectorDB, usa semantic search con embeddings.
       */
      async search(
        q: string,
        types?: string[],
        limit = 20,
        filter?: string,
      ): Promise<{ results: any[]; total: number }> {
        const term = (q ?? "").toLowerCase().trim();
        const targets = types?.length
          ? types.filter((t) => SEARCH_INDEX[t])
          : Object.keys(SEARCH_INDEX);
        const filterGroup = parseFilterParam(filter);

        const hits: Array<{ _type: string; _score: number; [key: string]: any }> = [];

        await Promise.all(targets.map(async (className) => {
          const fields = SEARCH_INDEX[className];
          const records = await db.find(className, {}).catch(() => []);

          for (const record of records) {
            // Aplicar filtro avanzado si existe
            if (filterGroup && !applyFilter(record, filterGroup)) continue;

            // Calcular relevancia por coincidencia de campos
            if (!term) {
              hits.push({ ...record, _type: className, _score: 1 });
              continue;
            }
            let score = 0;
            for (const field of fields) {
              const val = String(record[field] ?? "").toLowerCase();
              if (val === term) score += 100; // exacto
              else if (val.startsWith(term)) score += 60; // prefijo
              else if (val.includes(term)) score += 30; // contiene
            }
            if (score > 0) hits.push({ ...record, _type: className, _score: score });
          }
        }));

        const sorted = sortResults(hits, "-_score").slice(0, limit);
        return { results: sorted, total: hits.length };
      },

      /**
       * Búsqueda semántica con VectorDB (AI-powered).
       * Si no hay VectorDB configurado, hace fallback a full-text.
       */
      async semanticSearch(q: string, types?: string[], limit = 10): Promise<any> {
        if (!vectordb) return api.search(q, types, limit);
        try {
          return await vectordb.search("crm_insights", q, {
            topK: limit,
            filter: types ? { _type: { $in: types } } : undefined,
          });
        } catch {
          return api.search(q, types, limit);
        }
      },

      /** Sugiere completions para el searchbox (primeros 5 matches exactos de name/title/email) */
      async suggest(
        q: string,
      ): Promise<{ suggestions: Array<{ label: string; type: string; objectId: string }> }> {
        if (!q || q.length < 2) return { suggestions: [] };
        const term = q.toLowerCase();
        const suggestions: Array<{ label: string; type: string; objectId: string }> = [];
        const quickFields: Record<string, string> = {
          Contact: "name",
          Deal: "title",
          Lead: "stage",
          Account: "name",
          Product: "name",
        };

        await Promise.all(
          Object.entries(quickFields).map(async ([cls, field]) => {
            const records = await db.find(cls, {}).catch(() => []);
            for (const r of records) {
              const val = String(r[field] ?? "").toLowerCase();
              if (val.startsWith(term) && suggestions.length < 10) {
                suggestions.push({ label: r[field], type: cls, objectId: r.objectId });
              }
            }
          }),
        );

        return { suggestions: suggestions.slice(0, 5) };
      },
    };

    const search_routes = [
      {
        method: "GET" as const,
        path: "/zen/search",
        _openapi: {
          summary: "Full-text search global (CRM/ERP/Notes/Tasks)",
          tags: ["Search"],
          parameters: [
            {
              name: "q",
              in: "query",
              description: "Término de búsqueda",
              schema: { type: "string" },
            },
            {
              name: "types",
              in: "query",
              description: "Tipos a buscar ej: Contact,Deal,Note",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              description: "Máximo de resultados (default 20)",
              schema: { type: "integer" },
            },
            {
              name: "filter",
              in: "query",
              description: "FilterGroup JSON para filtros avanzados",
              schema: { type: "string" },
            },
            {
              name: "mode",
              in: "query",
              description: "text|semantic (default: text)",
              schema: { type: "string" },
            },
          ],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const url = new URL(req.url);
            const q = url.searchParams.get("q") ?? "";
            const types = url.searchParams.get("types")?.split(",").filter(Boolean);
            const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
            const filter = url.searchParams.get("filter") ?? undefined;
            const mode = url.searchParams.get("mode") ?? "text";
            const result = mode === "semantic"
              ? await api.semanticSearch(q, types, limit)
              : await api.search(q, types, limit, filter);
            return jsonRes(result);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/search/suggest",
        _openapi: { summary: "Sugerencias de búsqueda (searchbox autocomplete)", tags: ["Search"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const q = new URL(req.url).searchParams.get("q") ?? "";
            return jsonRes(await api.suggest(q));
          } catch (e) {
            return errRes(e);
          }
        },
      },
    ];

    return { search_routes, search: api };
  },
});
