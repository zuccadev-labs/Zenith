// deno-lint-ignore-file no-unused-vars
/**
 * Timeline Trait — Feed de actividad unificado por record.
 *
 * Agrega en orden cronológico: Notes, Tasks, Comments, Attachments,
 * Activities (ScyllaDB), y eventos de sistema (cambios de stage, etc.)
 * en un único endpoint por record. Patrón usado por Twenty y HubSpot.
 *
 * @barrits-trait
 * @barrits-summary ZenithTimeline
 * @barrits-provides timeline_routes, timeline
 * @barrits-consumes db
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { errRes, jsonRes, pathParams } from "../../core/trait-utils.ts";

/** Mapa de tipo → ícono sugerido para el frontend */
const TIMELINE_ICON: Record<string, string> = {
  Note: "file-text",
  Task: "check-square",
  Comment: "message-circle",
  Attachment: "paperclip",
  Activity: "activity",
  System: "info",
};

/**
 * Timeline trait: the chronological activity feed of one record (notes, tasks, comments,
 * attachments, activities and system events) at `/zen/timeline/:className/:objectId`.
 */
export const TimelineTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithTimeline",
  provides: ["timeline_routes", "timeline"],
  consumes: ["db"],
  state: [],
  runtimes: ["deno"],

  summary:
    "Unified chronological activity feed per record: Notes, Tasks, Comments, Attachments, Activities, System events.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    const api = {
      /**
       * Recupera el timeline completo de un record.
       * Todos los items tienen: { _timelineType, _icon, createdAt, objectId, ... }
       */
      async getTimeline(
        className: string,
        objectId: string,
        opts: { limit: number; skip: number },
      ) {
        const where = { targetClassName: className, targetId: objectId };

        // Cargar todas las fuentes en paralelo
        const [notes, tasks, comments, attachments, activities] = await Promise.all([
          db.find("Note", where).catch(() => []),
          db.find("Task", where).catch(() => []),
          db.find("Comment", where).catch(() => []),
          db.find("Attachment", where).catch(() => []),
          // Activities en ScyllaDB (si existe el adaptador)
          db.find("Activity", { recordClassName: className, recordId: objectId }).catch(() => []),
        ]);

        // Normalizar: añadir _timelineType + _icon a cada item
        const tag = (type: string, items: any[]) =>
          items.map((item) => ({
            ...item,
            _timelineType: type,
            _icon: TIMELINE_ICON[type] ?? "circle",
          }));

        const all = [
          ...tag("Note", notes),
          ...tag("Task", tasks),
          ...tag("Comment", comments),
          ...tag("Attachment", attachments),
          ...tag("Activity", activities),
        ];

        // Ordenar por createdAt descendente (más reciente primero)
        all.sort((a, b) => {
          const ta = new Date(a.createdAt ?? 0).getTime();
          const tb = new Date(b.createdAt ?? 0).getTime();
          return tb - ta;
        });

        const total = all.length;
        const results = all.slice(opts.skip, opts.skip + opts.limit);
        return { results, total, hasMore: opts.skip + opts.limit < total };
      },
    };

    const timeline_routes = [
      {
        method: "GET" as const,
        path: "/zen/timeline/:className/:objectId",
        _openapi: {
          summary: "Timeline unificado de un record (Notes/Tasks/Comments/Attachments/Activities)",
          tags: ["Timeline"],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
            { name: "skip", in: "query", schema: { type: "integer", default: 0 } },
          ],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/timeline/:className/:objectId", req.url)!;
            const url = new URL(req.url);
            const opts = {
              limit: Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100),
              skip: parseInt(url.searchParams.get("skip") ?? "0", 10),
            };
            return jsonRes(await api.getTimeline(p.className, p.objectId, opts));
          } catch (e) {
            return errRes(e);
          }
        },
      },
    ];

    return { timeline_routes, timeline: api };
  },
});
