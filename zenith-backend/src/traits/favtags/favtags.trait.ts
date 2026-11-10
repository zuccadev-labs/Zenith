// deno-lint-ignore-file no-unused-vars
/**
 * Favorites & Tags Trait — Favoritos + Etiquetas transversales.
 *
 * Favorites: cualquier usuario puede marcar cualquier record como favorito.
 * Tags: etiquetas globales de colores, aplicables a cualquier record vía
 *       TagAssignment (mismo patrón Target polimórfico que Collaboration).
 *
 * @barrits-trait
 * @barrits-summary ZenithFavoritesTags
 * @barrits-provides favtags_routes, favorites, tags
 * @barrits-consumes cloud, db
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor, type AnyTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { jsonRes, errRes, NO_CONTENT, pathParams, queryParams, parsePage, sortResults, ptr, now } from "../../core/trait-utils.ts";

const FAVTAGS_SCHEMAS = {
  Favorite: {
    user:            { type: "Pointer", targetClass: "_User", required: true },
    targetClassName: { type: "String", required: true },
    targetId:        { type: "String", required: true },
    position:        { type: "Number", defaultValue: 0 }, // Para reordenar favoritos
  },
  Tag: {
    name:            { type: "String", required: true },
    color:           { type: "String", defaultValue: "#6366f1" }, // Hex color
    icon:            { type: "String" },
    description:     { type: "String" },
    workspaceId:     { type: "String" },
    createdBy:       { type: "Pointer", targetClass: "_User" },
  },
  TagAssignment: {
    tag:             { type: "Pointer", targetClass: "Tag", required: true },
    targetClassName: { type: "String", required: true },
    targetId:        { type: "String", required: true },
    assignedBy:      { type: "Pointer", targetClass: "_User" },
  },
} as const;

export const FavoritesTagsTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithFavoritesTags",
  provides: ["favtags_routes", "favorites", "tags"],
  consumes: ["cloud", "db"],
  state: [],
  runtimes: ["deno"],
  summary: "Favorites (any record, per-user, reorderable) and transversal Tags (color-coded, assignable to any record via TagAssignment).",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    if (deps.traits["cloud"]?.defineSchema) {
      for (const [name, fields] of Object.entries(FAVTAGS_SCHEMAS)) {
        deps.traits["cloud"].defineSchema(name, fields, {});
      }
    }

    // ── Favorites ─────────────────────────────────────────────────────────────

    const favApi = {
      async list(userId: string) {
        const results = await db.find("Favorite", { "user.objectId": userId });
        return { results: sortResults(results, "position") };
      },

      async toggle(userId: string, targetClassName: string, targetId: string): Promise<{ added: boolean; favorite?: any }> {
        const existing = await db.find("Favorite", {
          "user.objectId": userId, targetClassName, targetId,
        });
        if (existing.length > 0) {
          await db.delete("Favorite", { objectId: existing[0].objectId });
          return { added: false };
        }
        const allFavs = await db.find("Favorite", { "user.objectId": userId });
        const favorite = await db.create("Favorite", {
          user: ptr("_User", userId), targetClassName, targetId,
          position: allFavs.length,
          createdAt: now(), updatedAt: now(),
        });
        return { added: true, favorite };
      },

      async reorder(userId: string, orderedIds: string[]) {
        await Promise.all(orderedIds.map((objectId, i) =>
          db.update("Favorite", { objectId }, { position: i, updatedAt: now() })
        ));
        return { success: true };
      },
    };

    // ── Tags ──────────────────────────────────────────────────────────────────

    const tagApi = {
      async list(workspaceId?: string) {
        const where = workspaceId ? { workspaceId } : {};
        const results = await db.find("Tag", where);
        return { results: sortResults(results, "name") };
      },

      async create(data: Record<string, any>, ctx: any) {
        if (!data.name) throw ZenithErrors.validationFailed("name es obligatorio.");
        return db.create("Tag", {
          ...data,
          createdBy: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(), updatedAt: now(),
        });
      },

      async update(objectId: string, data: Record<string, any>) {
        const existing = await db.read("Tag", objectId);
        if (!existing) throw ZenithErrors.notFound("Tag", objectId);
        return db.update("Tag", { objectId }, { ...data, updatedAt: now() });
      },

      async delete(objectId: string) {
        const existing = await db.read("Tag", objectId);
        if (!existing) throw ZenithErrors.notFound("Tag", objectId);
        // Cascade: eliminar todas las asignaciones de este tag
        const assignments = await db.find("TagAssignment", { "tag.objectId": objectId });
        await Promise.all(assignments.map((a: any) => db.delete("TagAssignment", { objectId: a.objectId })));
        await db.delete("Tag", { objectId });
        return { success: true, removedAssignments: assignments.length };
      },

      // ── Tag Assignments ────────────────────────────────────────────────────

      async assign(tagId: string, targetClassName: string, targetId: string, ctx: any) {
        const tag = await db.read("Tag", tagId);
        if (!tag) throw ZenithErrors.notFound("Tag", tagId);
        // Idempotente: no duplicar si ya está asignado
        const existing = await db.find("TagAssignment", { "tag.objectId": tagId, targetClassName, targetId });
        if (existing.length > 0) return existing[0];
        return db.create("TagAssignment", {
          tag: ptr("Tag", tagId), targetClassName, targetId,
          assignedBy: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(),
        });
      },

      async unassign(tagId: string, targetClassName: string, targetId: string) {
        const existing = await db.find("TagAssignment", { "tag.objectId": tagId, targetClassName, targetId });
        if (!existing.length) return { success: true };
        await db.delete("TagAssignment", { objectId: existing[0].objectId });
        return { success: true };
      },

      async getForRecord(targetClassName: string, targetId: string) {
        const assignments = await db.find("TagAssignment", { targetClassName, targetId });
        const tags = await Promise.all(
          assignments.map((a: any) => db.read("Tag", a.tag?.objectId).catch(() => null))
        );
        return { results: tags.filter(Boolean) };
      },

      async getByTag(tagId: string) {
        const assignments = await db.find("TagAssignment", { "tag.objectId": tagId });
        return { results: assignments };
      },
    };

    const favtags_routes = [
      // Favorites
      { method: "GET"  as const, path: "/zen/favorites",                                      _openapi: { summary: "Listar favoritos del usuario",              tags: ["Favorites"] }, handler: async (_req: Request, ctx: any) => { try { if (!ctx.user) return errRes(ZenithErrors.unauthorized()); return jsonRes(await favApi.list(ctx.user.objectId)); } catch(e) { return errRes(e); } } },
      { method: "POST" as const, path: "/zen/favorites/toggle",                               _openapi: { summary: "Agregar/quitar favorito (toggle idempotente)", tags: ["Favorites"] }, handler: async (req: Request, ctx: any) => { try { if (!ctx.user) return errRes(ZenithErrors.unauthorized()); const b = await req.json(); return jsonRes(await favApi.toggle(ctx.user.objectId, b.targetClassName, b.targetId)); } catch(e) { return errRes(e); } } },
      { method: "PUT"  as const, path: "/zen/favorites/reorder",                              _openapi: { summary: "Reordenar favoritos (drag & drop)",          tags: ["Favorites"] }, handler: async (req: Request, ctx: any) => { try { if (!ctx.user) return errRes(ZenithErrors.unauthorized()); const b = await req.json(); return jsonRes(await favApi.reorder(ctx.user.objectId, b.ids)); } catch(e) { return errRes(e); } } },
      // Tags CRUD
      { method: "GET"    as const, path: "/zen/tags",                                         _openapi: { summary: "Listar Tags del workspace",                  tags: ["Tags"] }, handler: async (req: Request, _ctx: any) => { try { const q = new URL(req.url).searchParams; return jsonRes(await tagApi.list(q.get("workspaceId") ?? undefined)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/tags",                                         _openapi: { summary: "Crear Tag",                                   tags: ["Tags"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await tagApi.create(await req.json(), ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/tags/:objectId",                               _openapi: { summary: "Actualizar Tag",                              tags: ["Tags"] }, handler: async (req: Request, _ctx: any) => { try { const p = pathParams("/zen/tags/:objectId", req.url)!; return jsonRes(await tagApi.update(p.objectId, await req.json())); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/tags/:objectId",                               _openapi: { summary: "Eliminar Tag (cascade)",                      tags: ["Tags"] }, handler: async (req: Request, _ctx: any) => { try { const p = pathParams("/zen/tags/:objectId", req.url)!; return jsonRes(await tagApi.delete(p.objectId)); } catch(e) { return errRes(e); } } },
      // Tag Assignments
      { method: "POST"   as const, path: "/zen/tags/:tagId/assign",                          _openapi: { summary: "Asignar Tag a un record",                    tags: ["Tags"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/tags/:tagId/assign", req.url)!; const b = await req.json(); return jsonRes(await tagApi.assign(p.tagId, b.targetClassName, b.targetId, ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/tags/:tagId/unassign",                        _openapi: { summary: "Quitar Tag de un record",                    tags: ["Tags"] }, handler: async (req: Request, _ctx: any) => { try { const p = pathParams("/zen/tags/:tagId/unassign", req.url)!; const b = await req.json(); return jsonRes(await tagApi.unassign(p.tagId, b.targetClassName, b.targetId)); } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/tags/record/:targetClassName/:targetId",       _openapi: { summary: "Obtener Tags de un record",                  tags: ["Tags"] }, handler: async (req: Request, _ctx: any) => { try { const p = pathParams("/zen/tags/record/:targetClassName/:targetId", req.url)!; return jsonRes(await tagApi.getForRecord(p.targetClassName, p.targetId)); } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/tags/:tagId/records",                         _openapi: { summary: "Obtener records con este Tag",               tags: ["Tags"] }, handler: async (req: Request, _ctx: any) => { try { const p = pathParams("/zen/tags/:tagId/records", req.url)!; return jsonRes(await tagApi.getByTag(p.tagId)); } catch(e) { return errRes(e); } } },
    ];

    return { favtags_routes, favorites: favApi, tags: tagApi };
  },
});
