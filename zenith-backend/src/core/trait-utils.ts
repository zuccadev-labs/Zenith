/**
 * @module @zenith/core/trait-utils
 *
 * Utilidades compartidas para todos los Traits de Zenith.
 * Fuente de verdad única — elimina duplicación entre traits.
 *
 * Principio: Ningún Trait debe re-implementar parseo de URLs,
 * serialización de respuestas ni lógica de paginación.
 */

// ─── Respuestas HTTP estandarizadas (Parse Server compat) ─────────────────────

/** 200/201/204 con JSON body */
export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Error serializado estilo Parse-Server */
export function errRes(err: any): Response {
  const status = typeof err?.httpStatus === "number" ? err.httpStatus : 500;
  return new Response(
    JSON.stringify({ code: err?.code ?? 1, error: err?.message ?? "Internal Server Error" }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** 204 No Content (para DELETE) */
export const NO_CONTENT = new Response(null, { status: 204 });

// ─── URL / Path ───────────────────────────────────────────────────────────────

/** Extrae path params de una URL usando URLPattern */
export function pathParams(pattern: string, url: string): Record<string, string> | null {
  const m = new URLPattern({ pathname: pattern }).exec(url);
  return m ? (m.pathname.groups as Record<string, string>) : null;
}

/** Parsea querystring; el param `where` se deserializa como JSON */
export function queryParams(url: URL): Record<string, any> {
  const q: Record<string, any> = {};
  url.searchParams.forEach((v, k) => {
    try {
      q[k] = k === "where" ? JSON.parse(v) : v;
    } catch {
      q[k] = v;
    }
  });
  return q;
}

// ─── Paginación ───────────────────────────────────────────────────────────────

export interface PageOpts {
  limit: number;
  skip: number;
  order?: string;
  count: boolean;
}

export function parsePage(q: Record<string, any>): PageOpts {
  return {
    limit: Math.min(parseInt(q.limit ?? "100", 10), 1000),
    skip: parseInt(q.skip ?? "0", 10),
    order: q.order,
    count: q.count === "1",
  };
}

// ─── Filter Engine Avanzado ───────────────────────────────────────────────────
// Operadores soportados: eq, neq, gt, gte, lt, lte, in, notIn, like, ilike,
//                        is (null check), startsWith, endsWith

type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "notIn"
  | "like"
  | "ilike"
  | "is"
  | "isNot"
  | "startsWith"
  | "endsWith";

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value: unknown;
}

export interface FilterGroup {
  and?: Array<FilterCondition | FilterGroup>;
  or?: Array<FilterCondition | FilterGroup>;
}

/**
 * Evalúa un FilterGroup contra un objeto de datos en memoria.
 * Para DBs reales, convertir a la query nativa del adaptador.
 */
export function applyFilter(
  item: Record<string, any>,
  filter: FilterGroup | FilterCondition,
): boolean {
  if ("and" in filter && filter.and) return filter.and.every((f) => applyFilter(item, f));
  if ("or" in filter && filter.or) return filter.or.some((f) => applyFilter(item, f));
  const { field, op, value } = filter as FilterCondition;
  const v = item[field];
  switch (op) {
    case "eq":
      return v === value;
    case "neq":
      return v !== value;
    case "gt":
      return v > (value as any);
    case "gte":
      return v >= (value as any);
    case "lt":
      return v < (value as any);
    case "lte":
      return v <= (value as any);
    case "in":
      return Array.isArray(value) && value.includes(v);
    case "notIn":
      return Array.isArray(value) && !value.includes(v);
    case "like":
      return typeof v === "string" && typeof value === "string" && v.includes(value);
    case "ilike":
      return typeof v === "string" && typeof value === "string" &&
        v.toLowerCase().includes((value as string).toLowerCase());
    case "is":
      return v === null || v === undefined;
    case "isNot":
      return v !== null && v !== undefined;
    case "startsWith":
      return typeof v === "string" && v.startsWith(value as string);
    case "endsWith":
      return typeof v === "string" && v.endsWith(value as string);
    default:
      return true;
  }
}

/**
 * Parsea el querystring `filter` (JSON) en un FilterGroup.
 * Ejemplo: filter={"and":[{"field":"stage","op":"eq","value":"won"}]}
 */
export function parseFilterParam(raw?: string): FilterGroup | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FilterGroup;
  } catch {
    return null;
  }
}

// ─── Ordenamiento ─────────────────────────────────────────────────────────────

/** Ordena un array según el param `order` (ej. "-createdAt" desc, "name" asc) */
export function sortResults(results: any[], order?: string): any[] {
  if (!order) return results;
  const key = order.replace(/^-/, "");
  const desc = order.startsWith("-");
  return [...results].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === bv) return 0;
    return desc ? (av < bv ? 1 : -1) : (av < bv ? -1 : 1);
  });
}

// ─── Parse Pointer ─────────────────────────────────────────────────────────────

/** Construye un Parse Pointer estándar */
export function ptr(className: string, objectId: string): Record<string, string> {
  return { __type: "Pointer", className, objectId };
}

/** Construye un puntero polimórfico Target (para Note/Task/Attachment) */
export function targetPtr(className: string, objectId: string) {
  return { targetClassName: className, target: ptr(className, objectId) };
}

// ─── Audit helper ─────────────────────────────────────────────────────────────

/** Fire-and-forget: escribe en ERP_Audit (ScyllaDB) sin bloquear la respuesta */
export function fireAudit(
  db: any,
  action: string,
  refClass: string,
  refId: string,
  user: any,
  prev?: unknown,
  next?: unknown,
): void {
  db.create("ERP_Audit", {
    action,
    referenceClass: refClass,
    referenceId: refId,
    user: user ? ptr("_User", user.objectId) : null,
    timestamp: new Date().toISOString(),
    previous_state: prev ?? null,
    new_state: next ?? null,
  }).catch(() => {/* silent - audit never breaks the main flow */});
}

// ─── Now helper ───────────────────────────────────────────────────────────────
export const now = (): string => new Date().toISOString();
