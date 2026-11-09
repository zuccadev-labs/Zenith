// deno-lint-ignore-file no-unused-vars
/**
 * Views Trait — Persistencia de vistas (Kanban, Table, Calendar, List).
 *
 * Cada vista almacena: tipo, filtros activos, campos visibles/ocultos,
 * sorts y posición de columnas Kanban. Permite a cualquier frontend
 * reconstruir el estado exacto de una vista guardada sin lógica propia.
 *
 * @barrits-trait
 * @barrits-summary ZenithViews
 * @barrits-provides views_routes, views
 * @barrits-consumes cloud, db
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { jsonRes, errRes, NO_CONTENT, pathParams, ptr, now } from "../../core/trait-utils.ts";

const VIEWS_SCHEMAS = {
  ZenithView: {
    name:            { type: "String", required: true },
    objectType:      { type: "String", required: true }, // "Contact" | "Deal" | "Lead" | ...
    type:            { type: "String", defaultValue: "table" }, // table|kanban|calendar|list|board
    icon:            { type: "String" },
    isDefault:       { type: "Boolean", defaultValue: false },
    isShared:        { type: "Boolean", defaultValue: false },
    owner:           { type: "Pointer", targetClass: "_User" },
    workspaceId:     { type: "String" },
    kanbanFieldName: { type: "String" }, // Campo usado para agrupar columnas Kanban
    position:        { type: "Number", defaultValue: 0 },
  },
  ZenithViewFilter: {
    view:          { type: "Pointer", targetClass: "ZenithView", required: true },
    fieldName:     { type: "String", required: true },
    operator:      { type: "String", required: true }, // eq|neq|gt|lt|in|like|ilike|is|startsWith
    value:         { type: "String" }, // Serializado como string (el cliente deserializa)
    displayValue:  { type: "String" }, // Valor legible para mostrar en UI
    isActive:      { type: "Boolean", defaultValue: true },
    position:      { type: "Number", defaultValue: 0 },
  },
  ZenithViewSort: {
    view:          { type: "Pointer", targetClass: "ZenithView", required: true },
    fieldName:     { type: "String", required: true },
    direction:     { type: "String", defaultValue: "asc" }, // asc|desc
    position:      { type: "Number", defaultValue: 0 },
  },
  ZenithViewField: {
    view:          { type: "Pointer", targetClass: "ZenithView", required: true },
    fieldName:     { type: "String", required: true },
    isVisible:     { type: "Boolean", defaultValue: true },
    width:         { type: "Number", defaultValue: 160 }, // px para columnas tabla
    position:      { type: "Number", defaultValue: 0 },
  },
} as const;

export const ViewsTrait = createTraitDescriptor({
  name: "ZenithViews",
  provides: ["views_routes", "views"],
  consumes: ["cloud", "db"],
  state: [],
  runtimes: ["deno"],

  summary: "Saved Views (Kanban/Table/Calendar/List) with persistent Filters, Sorts and Field visibility per user.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    if (deps.traits["cloud"]?.defineSchema) {
      for (const [name, fields] of Object.entries(VIEWS_SCHEMAS)) {
        deps.traits["cloud"].defineSchema(name, fields, {});
      }
    }

    // Helper: carga una vista con sus filters, sorts y fields en una sola respuesta
    async function hydrateView(view: any) {
      const [filters, sorts, fields] = await Promise.all([
        db.find("ZenithViewFilter", { "view.objectId": view.objectId }),
        db.find("ZenithViewSort",   { "view.objectId": view.objectId }),
        db.find("ZenithViewField",  { "view.objectId": view.objectId }),
      ]);
      return {
        ...view,
        filters: filters.sort((a: any, b: any) => a.position - b.position),
        sorts:   sorts.sort((a: any, b: any) => a.position - b.position),
        fields:  fields.sort((a: any, b: any) => a.position - b.position),
      };
    }

    const api = {
      async listViews(objectType: string, userId?: string) {
        const where: Record<string, any> = { objectType };
        // Retorna vistas del usuario + vistas compartidas
        const results = await db.find("ZenithView", where);
        const visible = results.filter((v: any) =>
          v.isShared || !userId || v.owner?.objectId === userId
        );
        return { results: visible.sort((a: any, b: any) => a.position - b.position) };
      },

      async getView(objectId: string) {
        const view = await db.read("ZenithView", objectId);
        if (!view) throw ZenithErrors.notFound("ZenithView", objectId);
        return hydrateView(view);
      },

      async createView(data: Record<string, any>, ctx: any) {
        if (!data.name || !data.objectType) throw ZenithErrors.validationFailed("name y objectType son obligatorios.");
        const view = await db.create("ZenithView", {
          ...data,
          owner: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          position: data.position ?? Date.now(),
          createdAt: now(), updatedAt: now(),
        });
        // Crear filters/sorts/fields en paralelo si se pasan
        const tasks: Promise<any>[] = [];
        if (data.filters) for (const f of data.filters) tasks.push(db.create("ZenithViewFilter", { ...f, view: ptr("ZenithView", view.objectId), createdAt: now() }));
        if (data.sorts)   for (const s of data.sorts)   tasks.push(db.create("ZenithViewSort",   { ...s, view: ptr("ZenithView", view.objectId), createdAt: now() }));
        if (data.fields)  for (const f of data.fields)  tasks.push(db.create("ZenithViewField",  { ...f, view: ptr("ZenithView", view.objectId), createdAt: now() }));
        if (tasks.length) await Promise.all(tasks);
        return hydrateView(view);
      },

      async updateView(objectId: string, data: Record<string, any>, ctx: any) {
        const existing = await db.read("ZenithView", objectId);
        if (!existing) throw ZenithErrors.notFound("ZenithView", objectId);
        const { filters, sorts, fields, ...viewData } = data;
        const updated = await db.update("ZenithView", { objectId }, { ...viewData, updatedAt: now() });

        // Sincronización de filters/sorts/fields: elimina existentes y recrea
        const syncSubCollection = async (className: string, items?: any[]) => {
          if (!items) return;
          const existing = await db.find(className, { "view.objectId": objectId });
          await Promise.all(existing.map((e: any) => db.delete(className, { objectId: e.objectId })));
          await Promise.all(items.map((item, i) => db.create(className, { ...item, view: ptr("ZenithView", objectId), position: item.position ?? i, createdAt: now() })));
        };
        await Promise.all([
          syncSubCollection("ZenithViewFilter", filters),
          syncSubCollection("ZenithViewSort",   sorts),
          syncSubCollection("ZenithViewField",  fields),
        ]);
        return hydrateView(updated ?? existing);
      },

      async deleteView(objectId: string, ctx: any) {
        const existing = await db.read("ZenithView", objectId);
        if (!existing) throw ZenithErrors.notFound("ZenithView", objectId);
        // Cascade delete sub-colecciones en paralelo
        await Promise.all(["ZenithViewFilter", "ZenithViewSort", "ZenithViewField"].map(async (cls) => {
          const items = await db.find(cls, { "view.objectId": objectId });
          await Promise.all(items.map((i: any) => db.delete(cls, { objectId: i.objectId })));
        }));
        await db.delete("ZenithView", { objectId });
        return { success: true };
      },
    };

    const views_routes = [
      { method: "GET"    as const, path: "/zen/views",                _openapi: { summary: "Listar Vistas por objectType",           tags: ["Views"] }, handler: async (req: Request, ctx: any) => { try { const q = new URL(req.url).searchParams; return jsonRes(await api.listViews(q.get("objectType") ?? "", ctx.user?.objectId)); } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/views/:objectId",      _openapi: { summary: "Obtener Vista con filtros/sorts/fields",  tags: ["Views"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/views/:objectId", req.url)!; return jsonRes(await api.getView(p.objectId)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/views",                _openapi: { summary: "Crear Vista con configuración completa",  tags: ["Views"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await api.createView(await req.json(), ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/views/:objectId",      _openapi: { summary: "Actualizar Vista (sync filters/sorts)",   tags: ["Views"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/views/:objectId", req.url)!; return jsonRes(await api.updateView(p.objectId, await req.json(), ctx)); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/views/:objectId",      _openapi: { summary: "Eliminar Vista (cascade)",               tags: ["Views"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/views/:objectId", req.url)!; await api.deleteView(p.objectId, ctx); return NO_CONTENT; } catch(e) { return errRes(e); } } },
    ];

    return { views_routes, views: api };
  },
});
