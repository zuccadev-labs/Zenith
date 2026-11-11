/**
 * Notifications Trait — Notificaciones in-app + push via SSE/WebSocket.
 *
 * Patrón: el servidor emite notificaciones; el frontend se suscribe via
 * Server-Sent Events (SSE) en `/zen/notifications/stream`.
 * Sin dependencia de WebSocket externo — SSE es suficiente para
 * notificaciones unidireccionales y funciona sobre HTTP/1.1 y HTTP/2.
 *
 * @barrits-trait
 * @barrits-summary ZenithNotifications
 * @barrits-provides notifications_routes, notifications
 * @barrits-consumes cloud, db
 * @barrits-tags uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor, type AnyTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { jsonRes, errRes, NO_CONTENT, pathParams, queryParams, parsePage, sortResults, now } from "../../core/trait-utils.ts";

const NOTIFICATION_SCHEMA = {
  Notification: {
    userId:      { type: "String", required: true }, // objectId del destinatario
    type:        { type: "String", defaultValue: "info" }, // info|success|warning|error|mention|task|comment
    title:       { type: "String" },
    body:        { type: "String", required: true },
    link:        { type: "String" },                 // URL o path a navegar al hacer click
    targetClassName: { type: "String" },              // Clase del record relacionado
    targetId:    { type: "String" },                  // objectId del record relacionado
    source:      { type: "String", defaultValue: "system" }, // system|agent|user|webhook
    isRead:      { type: "Boolean", defaultValue: false },
    readAt:      { type: "Date" },
  },
} as const;

/** Canal SSE por userId — Map<userId, ReadableStreamDefaultController[]> */
const SSE_CLIENTS = new Map<string, ReadableStreamDefaultController<string>[]>();

/** Emite un evento SSE a todos los canales del usuario */
function pushSSE(userId: string, payload: unknown): void {
  const controllers = SSE_CLIENTS.get(userId) ?? [];
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const ctrl of controllers) {
    try { ctrl.enqueue(data); } catch { /* canal cerrado */ }
  }
}

export const NotificationsTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithNotifications",
  provides: ["notifications_routes", "notifications"],
  consumes: ["cloud", "db"],
  tags: ["uses:events"],
  state: [],
  runtimes: ["deno"],
  summary: "In-app notifications with SSE push stream. Supports read/unread, batch mark-all-read, type filtering and real-time delivery.",

  create: (deps: Record<string, any>) => {
    const db     = deps.traits["db"];
    const events = deps.traits["events"];

    if (deps.traits["cloud"]?.defineSchema) {
      for (const [name, fields] of Object.entries(NOTIFICATION_SCHEMA)) {
        deps.traits["cloud"].defineSchema(name, fields, {});
      }
    }

    // Escuchar eventos del sistema y convertirlos en notificaciones
    if (events) {
      events.on?.("Notification.create", async (data: any) => {
        await api.create(data.userId, data);
      });
      // Propagar eventos de colaboración como notificaciones
      events.on?.("Comment.created", async (comment: any) => {
        for (const mention of comment.mentions ?? []) {
          if (mention.objectId) {
            await api.create(mention.objectId, {
              type: "mention", title: "Te mencionaron",
              body: comment.body?.slice?.(0, 120) ?? "Mención en un comentario",
              targetClassName: comment.targetClassName, targetId: comment.targetId,
              source: "user",
            });
          }
        }
      });
      events.on?.("Task.created", async (task: any) => {
        if (task.assignee?.objectId) {
          await api.create(task.assignee.objectId, {
            type: "task", title: "Nueva tarea asignada",
            body: task.title,
            targetClassName: "Task", targetId: task.objectId,
            source: "user",
          });
        }
      });
    }

    const api = {
      async create(userId: string, data: Partial<{ type: string; title: string; body: string; link: string; targetClassName: string; targetId: string; source: string }>) {
        if (!userId || !data.body) return null;
        const notification = await db.create("Notification", {
          userId, ...data,
          type: data.type ?? "info",
          source: data.source ?? "system",
          isRead: false,
          createdAt: now(), updatedAt: now(),
        });
        pushSSE(userId, { event: "notification", data: notification });
        return notification;
      },

      async list(userId: string, q: Record<string, any>) {
        const where: Record<string, any> = { userId };
        if (q.type)   where.type   = q.type;
        if (q.isRead !== undefined) where.isRead = q.isRead === "true";
        const { limit, skip } = parsePage(q);
        const all = await db.find("Notification", where);
        const unreadCount = all.filter((n: any) => !n.isRead).length;
        const results = sortResults(all, "-createdAt").slice(skip, skip + limit);
        return { results, unreadCount, total: all.length };
      },

      async markRead(objectId: string, userId: string) {
        const notif = await db.read("Notification", objectId);
        if (!notif) throw ZenithErrors.notFound("Notification", objectId);
        if (notif.userId !== userId) throw ZenithErrors.forbidden();
        return db.update("Notification", { objectId }, { isRead: true, readAt: now(), updatedAt: now() });
      },

      async markAllRead(userId: string) {
        const unread = await db.find("Notification", { userId, isRead: false });
        await Promise.all(unread.map((n: any) =>
          db.update("Notification", { objectId: n.objectId }, { isRead: true, readAt: now(), updatedAt: now() })
        ));
        return { markedRead: unread.length };
      },

      async delete(objectId: string, userId: string) {
        const notif = await db.read("Notification", objectId);
        if (!notif) throw ZenithErrors.notFound("Notification", objectId);
        if (notif.userId !== userId) throw ZenithErrors.forbidden();
        await db.delete("Notification", { objectId });
        return { success: true };
      },

      /** Crea un SSE stream para un usuario. El cliente hace GET /zen/notifications/stream */
      createStream(userId: string): Response {
        let controller: ReadableStreamDefaultController<string>;
        const stream = new ReadableStream<string>({
          start(ctrl) {
            controller = ctrl;
            const list = SSE_CLIENTS.get(userId) ?? [];
            list.push(ctrl);
            SSE_CLIENTS.set(userId, list);
            // Heartbeat cada 25s para mantener la conexión viva
            ctrl.enqueue(`: heartbeat\n\n`);
          },
          cancel() {
            const list = SSE_CLIENTS.get(userId) ?? [];
            SSE_CLIENTS.set(userId, list.filter(c => c !== controller));
          },
        });
        return new Response(stream.pipeThrough(new TextEncoderStream()), {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "x-accel-buffering": "no", // Nginx: deshabilitar buffering
          },
        });
      },
    };

    const notifications_routes = [
      { method: "GET"    as const, path: "/zen/notifications",                _openapi: { summary: "Listar notificaciones del usuario",       tags: ["Notifications"] }, handler: async (req: Request, ctx: any) => { try { const u = ctx.user?.objectId; if (!u) return errRes(ZenithErrors.unauthorized()); return jsonRes(await api.list(u, queryParams(new URL(req.url)))); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/notifications/:objectId/read", _openapi: { summary: "Marcar notificación como leída",          tags: ["Notifications"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/notifications/:objectId/read", req.url)!; return jsonRes(await api.markRead(p.objectId, ctx.user?.objectId)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/notifications/read-all",       _openapi: { summary: "Marcar todas las notificaciones como leídas", tags: ["Notifications"] }, handler: async (_req: Request, ctx: any) => { try { return jsonRes(await api.markAllRead(ctx.user?.objectId)); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/notifications/:objectId",      _openapi: { summary: "Eliminar notificación",                   tags: ["Notifications"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/notifications/:objectId", req.url)!; await api.delete(p.objectId, ctx.user?.objectId); return NO_CONTENT; } catch(e) { return errRes(e); } } },
      {
        method: "POST"   as const,
        path: "/zen/notifications",
        _openapi: { summary: "Crear notificación (admin/agent)", tags: ["Notifications"] },
        handler: async (req: Request, ctx: any) => {
          try {
            if (!ctx.master && !ctx.user) return errRes(ZenithErrors.unauthorized());
            const b = await req.json();
            return jsonRes(await api.create(b.userId, b), 201);
          } catch(e) { return errRes(e); }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/notifications/stream",
        _openapi: { summary: "SSE stream de notificaciones en tiempo real", tags: ["Notifications"] },
        handler: async (req: Request, ctx: any) => {
          const userId = ctx.user?.objectId ?? new URL(req.url).searchParams.get("userId");
          if (!userId) return errRes(ZenithErrors.unauthorized());
          return api.createStream(userId);
        },
      },
    ];

    return { notifications_routes, notifications: api };
  },
});
