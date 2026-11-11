// deno-lint-ignore-file no-unused-vars
/**
 * CSV Import/Export Trait — Importación y exportación masiva de datos CRM/ERP.
 *
 * Import: multipart/form-data con archivo CSV → parseo robusto →
 *         validación por clase → inserción por lotes (configurable).
 * Export: query + filtros → generación de CSV en streaming.
 *
 * Clases soportadas: Contact, Lead, Deal, Account, Product, Employee, Invoice.
 * Patrón: el trait no tiene lógica de negocio — delega a db.create/db.find.
 *
 * @barrits-trait
 * @barrits-summary ZenithCSV
 * @barrits-provides csv_routes, csvManager
 * @barrits-consumes db
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import {
  applyFilter,
  errRes,
  jsonRes,
  now,
  parseFilterParam,
  pathParams,
} from "../../core/trait-utils.ts";

/** Campos exportables por clase */
const EXPORT_FIELDS: Record<string, string[]> = {
  Contact: [
    "objectId",
    "name",
    "email",
    "phone",
    "company",
    "title",
    "stage",
    "score",
    "currency",
    "createdAt",
    "updatedAt",
  ],
  Lead: [
    "objectId",
    "contactId",
    "stage",
    "score",
    "currency",
    "probability",
    "notes",
    "createdAt",
    "updatedAt",
  ],
  Deal: [
    "objectId",
    "title",
    "amount",
    "stage",
    "pipeline",
    "currency",
    "closeDate",
    "probability",
    "createdAt",
    "updatedAt",
  ],
  Account: [
    "objectId",
    "name",
    "email",
    "phone",
    "industry",
    "website",
    "employees",
    "revenue",
    "createdAt",
    "updatedAt",
  ],
  Product: [
    "objectId",
    "name",
    "sku",
    "price",
    "currency",
    "stock",
    "category",
    "status",
    "createdAt",
    "updatedAt",
  ],
  Employee: [
    "objectId",
    "name",
    "email",
    "role",
    "department",
    "salary",
    "currency",
    "hireDate",
    "status",
    "createdAt",
    "updatedAt",
  ],
  Invoice: [
    "objectId",
    "number",
    "status",
    "currency",
    "subtotal",
    "tax",
    "discount",
    "total",
    "dueDate",
    "paidAt",
    "createdAt",
    "updatedAt",
  ],
};

/** Campos requeridos para importación */
const REQUIRED_FIELDS: Record<string, string[]> = {
  Contact: ["name"],
  Lead: ["contactId", "stage"],
  Deal: ["title", "stage"],
  Account: ["name"],
  Product: ["name", "sku", "price"],
  Employee: ["name", "email", "role"],
  Invoice: ["currency"],
};

/** Parsea un CSV (text) en array de objetos. Soporta comillas y comas en valores. */
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) =>
    l.trim()
  );
  if (lines.length < 2) return [];

  // Parsear una línea CSV respetando comillas
  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else current += ch;
    }
    fields.push(current.trim());
    return fields;
  };

  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseLine(line);
    return Object.fromEntries(headers.map((h, i) => [h.trim(), values[i]?.trim() ?? ""]));
  });
}

/** Convierte array de objetos a CSV string */
function toCSV(rows: Record<string, any>[], fields: string[]): string {
  const escape = (v: any): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const header = fields.join(",");
  const body = rows.map((r) => fields.map((f) => escape(r[f])).join(",")).join("\n");
  return `${header}\n${body}`;
}

export const CSVTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithCSV",
  provides: ["csv_routes", "csvManager"],
  consumes: ["db"],
  state: [],
  runtimes: ["deno"],
  summary:
    "CSV Import (multipart, batch insert, validation) and Export (streaming, advanced filters) for Contact, Lead, Deal, Account, Product, Employee, Invoice.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    const api = {
      async importCSV(
        className: string,
        csvText: string,
        options: { batchSize?: number; dryRun?: boolean } = {},
      ) {
        if (!EXPORT_FIELDS[className]) {
          throw ZenithErrors.validationFailed(
            `Clase '${className}' no soportada para importación.`,
          );
        }
        const rows = parseCSV(csvText);
        if (!rows.length) throw ZenithErrors.validationFailed("El CSV no contiene datos válidos.");

        const required = REQUIRED_FIELDS[className] ?? [];
        const errors: Array<{ row: number; field: string; message: string }> = [];
        const valid: Record<string, any>[] = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          let rowValid = true;
          for (const field of required) {
            if (!row[field]) {
              errors.push({ row: i + 2, field, message: `Campo '${field}' es requerido.` });
              rowValid = false;
            }
          }
          if (rowValid) valid.push(row);
        }

        if (options.dryRun) {
          return { dryRun: true, totalRows: rows.length, valid: valid.length, errors };
        }

        // Inserción por lotes
        const batchSize = options.batchSize ?? 50;
        let inserted = 0;
        for (let i = 0; i < valid.length; i += batchSize) {
          const batch = valid.slice(i, i + batchSize);
          await Promise.all(
            batch.map((row) =>
              db.create(className, { ...row, createdAt: now(), updatedAt: now() })
            ),
          );
          inserted += batch.length;
        }

        return { totalRows: rows.length, inserted, skipped: rows.length - valid.length, errors };
      },

      async exportCSV(className: string, filter?: string, fields?: string[]): Promise<Response> {
        const exportFields = fields?.length ? fields : (EXPORT_FIELDS[className] ?? []);
        if (!EXPORT_FIELDS[className]) {
          throw ZenithErrors.validationFailed(
            `Clase '${className}' no soportada para exportación.`,
          );
        }

        const all = await db.find(className, {});
        const filterGroup = parseFilterParam(filter ?? undefined);
        const rows = filterGroup ? all.filter((r: any) => applyFilter(r, filterGroup)) : all;

        const csv = toCSV(rows, exportFields);
        const filename = `${className.toLowerCase()}_export_${
          new Date().toISOString().slice(0, 10)
        }.csv`;

        return new Response(csv, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${filename}"`,
            "x-total-records": String(rows.length),
          },
        });
      },

      /** Lista las clases disponibles con sus campos exportables */
      schema() {
        return {
          classes: Object.entries(EXPORT_FIELDS).map(([name, fields]) => ({
            name,
            fields,
            required: REQUIRED_FIELDS[name] ?? [],
          })),
        };
      },
    };

    const csv_routes = [
      {
        method: "POST" as const,
        path: "/zen/csv/import/:className",
        _openapi: {
          summary: "Importar registros desde CSV (multipart/form-data)",
          tags: ["CSV"],
          parameters: [
            {
              name: "className",
              in: "path",
              required: true,
              schema: { type: "string", enum: Object.keys(EXPORT_FIELDS) },
            },
            {
              name: "dryRun",
              in: "query",
              schema: { type: "boolean" },
              description: "Validar sin insertar",
            },
            {
              name: "batchSize",
              in: "query",
              schema: { type: "integer" },
              description: "Registros por lote (default 50)",
            },
          ],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/csv/import/:className", req.url)!;
            const url = new URL(req.url);
            const dryRun = url.searchParams.get("dryRun") === "true";
            const batchSize = parseInt(url.searchParams.get("batchSize") ?? "50", 10);

            const contentType = req.headers.get("content-type") ?? "";

            let csvText = "";
            if (contentType.includes("multipart/form-data")) {
              const form = await req.formData();
              const file = form.get("file") as File | null;
              if (!file) throw ZenithErrors.validationFailed("Campo 'file' requerido en el form.");
              csvText = await file.text();
            } else {
              csvText = await req.text();
            }

            return jsonRes(await api.importCSV(p.className, csvText, { dryRun, batchSize }), 200);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/csv/export/:className",
        _openapi: {
          summary: "Exportar registros como CSV (download)",
          tags: ["CSV"],
          parameters: [
            {
              name: "className",
              in: "path",
              required: true,
              schema: { type: "string", enum: Object.keys(EXPORT_FIELDS) },
            },
            {
              name: "filter",
              in: "query",
              schema: { type: "string" },
              description: "FilterGroup JSON",
            },
            {
              name: "fields",
              in: "query",
              schema: { type: "string" },
              description: "Columnas a incluir (comma-separated)",
            },
          ],
        },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/csv/export/:className", req.url)!;
            const url = new URL(req.url);
            const filter = url.searchParams.get("filter") ?? undefined;
            const fields = url.searchParams.get("fields")?.split(",").map((f) => f.trim()).filter(
              Boolean,
            );
            return await api.exportCSV(p.className, filter, fields);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/csv/schema",
        _openapi: { summary: "Clases y campos disponibles para CSV Import/Export", tags: ["CSV"] },
        handler: async (_req: Request, _ctx: any) => jsonRes(api.schema()),
      },
    ];

    return { csv_routes, csvManager: api };
  },
});
