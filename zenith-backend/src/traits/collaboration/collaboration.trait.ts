// deno-lint-ignore-file no-unused-vars
/**
 * Collaboration Trait — Notes, Tasks, Comments, Attachments.
 *
 * Patrón Target polimórfico (igual que Twenty CRM):
 *   Una Note/Task/Comment/Attachment puede estar vinculada a CUALQUIER
 *   clase de datos (Contact, Deal, Lead, Product, etc.) mediante un
 *   campo `targetClassName + targetId` en lugar de un Pointer tipado.
 *
 * Smart DB Routing:
 *   - Note, Task, Attachment → MongoDB
 *   - Comment               → MongoDB (con TTL opcional para cleanup)
 *
 * @barrits-trait
 * @barrits-summary ZenithCollaboration
 * @barrits-provides collaboration_routes, collaboration
 * @barrits-consumes db, acl, cloud, storage, events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { jsonRes, errRes, NO_CONTENT, pathParams, queryParams, parsePage, sortResults, ptr, now } from "../../core/trait-utils.ts";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const COLLAB_SCHEMAS = {
  Note: {
    title:           { type: "String" },
    body:            { type: "Object" },  // Block editor JSON (Notion-style / Tiptap)
    bodyText:        { type: "String" },  // Texto plano para full-text search
    targetClassName: { type: "String", required: true }, // "Contact"|"Deal"|"Lead"|...
    targetId:        { type: "String", required: true },
    author:          { type: "Pointer", targetClass: "_User" },
    isPinned:        { type: "Boolean", defaultValue: false },
  },
  Task: {
    title:           { type: "String", required: true },
    body:            { type: "String" },
    status:          { type: "String", defaultValue: "todo" }, // todo|in_progress|done
    priority:        { type: "String", defaultValue: "medium" }, // low|medium|high|urgent
    dueAt:           { type: "Date" },
    completedAt:     { type: "Date" },
    assignee:        { type: "Pointer", targetClass: "_User" },
    author:          { type: "Pointer", targetClass: "_User" },
    targetClassName: { type: "String" },
    targetId:        { type: "String" },
    position:        { type: "Number", defaultValue: 0 }, // Para kanban drag & drop
  },
  Comment: {
    body:            { type: "String", required: true },
    author:          { type: "Pointer", targetClass: "_User", required: true },
    targetClassName: { type: "String", required: true },
    targetId:        { type: "String", required: true },
    mentions:        { type: "Array",  defaultValue: [] }, // [{objectId, username}]
    editedAt:        { type: "Date" },
  },
  Attachment: {
    name:            { type: "String", required: true },
    mimeType:        { type: "String" },
    size:            { type: "Number" },
    url:             { type: "String", required: true }, // URL del archivo en el StorageTrait
    fileId:          { type: "String" }, // objectId en _File
    targetClassName: { type: "String", required: true },
    targetId:        { type: "String", required: true },
    author:          { type: "Pointer", targetClass: "_User" },
  },
} as const;

export const CollaborationTrait = createTraitDescriptor({
  name: "ZenithCollaboration",
  provides: ["collaboration_routes", "collaboration"],
  consumes: ["db", "acl", "cloud", "storage", "events"],
  state: [],
  runtimes: ["deno"],

  summary: "Notes (rich text), Tasks (with kanban position), Comments (@mentions), Attachments — all linked to any record via polymorphic Target pattern.",

  create: (deps: Record<string, any>) => {
    const db     = deps["db"];
    const cloud  = deps["cloud"];
    const events = deps["events"];
    const fileStore = deps["storage"] ?? deps["fileStore"];

    // Registrar schemas
    if (cloud?.defineSchema) {
      for (const [name, fields] of Object.entries(COLLAB_SCHEMAS)) {
        cloud.defineSchema(name, fields, {});
      }
    }

    // ── traitApi ──────────────────────────────────────────────────────────────

    const api = {
      // ── Notes ────────────────────────────────────────────────────────────────

      async listNotes(targetClassName: string, targetId: string) {
        const results = await db.find("Note", { targetClassName, targetId });
        return { results: sortResults(results, "-createdAt") };
      },
      async createNote(data: Record<string, any>, ctx: any) {
        if (!data.targetClassName || !data.targetId) throw ZenithErrors.validationFailed("targetClassName y targetId son obligatorios.");
        const body = { ...data, author: ctx.user ? ptr("_User", ctx.user.objectId) : null, createdAt: now(), updatedAt: now() };
        const note = await db.create("Note", body);
        if (events) events.emit("Note.created", note);
        return note;
      },
      async updateNote(objectId: string, data: Record<string, any>, ctx: any) {
        const existing = await db.read("Note", objectId);
        if (!existing) throw ZenithErrors.notFound("Note", objectId);
        const updated = await db.update("Note", { objectId }, { ...data, updatedAt: now() });
        return updated;
      },
      async deleteNote(objectId: string, ctx: any) {
        const existing = await db.read("Note", objectId);
        if (!existing) throw ZenithErrors.notFound("Note", objectId);
        await db.delete("Note", { objectId });
        return { success: true };
      },

      // ── Tasks ─────────────────────────────────────────────────────────────────

      async listTasks(query: Record<string, any>, ctx: any) {
        const where: Record<string, any> = {};
        if (query.targetClassName) where.targetClassName = query.targetClassName;
        if (query.targetId)        where.targetId        = query.targetId;
        if (query.status)          where.status          = query.status;
        if (query.assigneeId)      where["assignee.objectId"] = query.assigneeId;
        const results = await db.find("Task", where);
        return { results: sortResults(results, query.order ?? "position") };
      },
      async createTask(data: Record<string, any>, ctx: any) {
        if (!data.title) throw ZenithErrors.validationFailed("title es obligatorio para crear una Task.");
        const { assigneeId, ...rest } = data as Record<string, any>;
        const body: Record<string, any> = {
          ...rest,
          author:   ctx.user ? ptr("_User", ctx.user.objectId) : null,
          assignee: assigneeId ? ptr("_User", assigneeId) : (ctx.user ? ptr("_User", ctx.user.objectId) : null),
          status:   data.status ?? "todo",
          priority: data.priority ?? "medium",
          position: data.position ?? Date.now(),
          createdAt: now(), updatedAt: now(),
        };
        const task = await db.create("Task", body);
        if (events) events.emit("Task.created", task);
        return task;
      },

      async updateTask(objectId: string, data: Record<string, any>, ctx: any) {
        const existing = await db.read("Task", objectId);
        if (!existing) throw ZenithErrors.notFound("Task", objectId);
        const patch: Record<string, any> = { ...data, updatedAt: now() };
        if (data.status === "done" && existing.status !== "done") patch.completedAt = now();
        const updated = await db.update("Task", { objectId }, patch);
        if (events) events.emit("Task.updated", updated);
        return updated;
      },
      async deleteTask(objectId: string, ctx: any) {
        const existing = await db.read("Task", objectId);
        if (!existing) throw ZenithErrors.notFound("Task", objectId);
        await db.delete("Task", { objectId });
        return { success: true };
      },

      // ── Comments ──────────────────────────────────────────────────────────────

      async listComments(targetClassName: string, targetId: string) {
        const results = await db.find("Comment", { targetClassName, targetId });
        return { results: sortResults(results, "createdAt") };
      },
      async createComment(data: Record<string, any>, ctx: any) {
        if (!data.body || !data.targetClassName || !data.targetId) throw ZenithErrors.validationFailed("body, targetClassName y targetId son obligatorios.");
        if (!ctx.user && !ctx.master) throw ZenithErrors.unauthorized();
        const comment = await db.create("Comment", {
          ...data,
          author: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          mentions: data.mentions ?? [],
          createdAt: now(), updatedAt: now(),
        });
        if (events) events.emit("Comment.created", comment);
        return comment;
      },
      async updateComment(objectId: string, data: Record<string, any>, ctx: any) {
        const existing = await db.read("Comment", objectId);
        if (!existing) throw ZenithErrors.notFound("Comment", objectId);
        if (!ctx.master && existing.author?.objectId !== ctx.user?.objectId) throw ZenithErrors.forbidden("Solo el autor puede editar un comentario.");
        return db.update("Comment", { objectId }, { body: data.body, editedAt: now(), updatedAt: now() });
      },
      async deleteComment(objectId: string, ctx: any) {
        const existing = await db.read("Comment", objectId);
        if (!existing) throw ZenithErrors.notFound("Comment", objectId);
        if (!ctx.master && existing.author?.objectId !== ctx.user?.objectId) throw ZenithErrors.forbidden();
        await db.delete("Comment", { objectId });
        return { success: true };
      },

      // ── Attachments ───────────────────────────────────────────────────────────

      async listAttachments(targetClassName: string, targetId: string) {
        const results = await db.find("Attachment", { targetClassName, targetId });
        return { results: sortResults(results, "-createdAt") };
      },
      async uploadAttachment(req: Request, ctx: any): Promise<any> {
        const url = new URL(req.url);
        const targetClassName = url.searchParams.get("targetClassName");
        const targetId        = url.searchParams.get("targetId");
        if (!targetClassName || !targetId) throw ZenithErrors.validationFailed("targetClassName y targetId son requeridos como query params.");
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file) throw ZenithErrors.validationFailed("Campo 'file' requerido en el form.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const stored = fileStore ? await fileStore.upload(file.name, bytes, { metadata: { userId: ctx.user?.objectId } })
                                 : { url: `/files/${crypto.randomUUID()}/${file.name}`, objectId: crypto.randomUUID() };
        const attachment = await db.create("Attachment", {
          name: file.name, mimeType: file.type, size: file.size,
          url: stored.url, fileId: stored.objectId,
          targetClassName, targetId,
          author: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(), updatedAt: now(),
        });
        if (events) events.emit("Attachment.created", attachment);
        return attachment;
      },
      async deleteAttachment(objectId: string, ctx: any) {
        const existing = await db.read("Attachment", objectId);
        if (!existing) throw ZenithErrors.notFound("Attachment", objectId);
        if (!ctx.master && !fileStore) throw ZenithErrors.forbidden();
        await db.delete("Attachment", { objectId });
        return { success: true };
      },
    };

    // ── Rutas ─────────────────────────────────────────────────────────────────

    const collaboration_routes = [
      // Notes
      { method: "GET"    as const, path: "/zen/notes/:targetClassName/:targetId", _openapi: { summary: "Listar Notas de un record", tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/notes/:targetClassName/:targetId", req.url)!; return jsonRes(await api.listNotes(p.targetClassName, p.targetId)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/notes",                            _openapi: { summary: "Crear Nota",             tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await api.createNote(await req.json(), ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/notes/:objectId",                  _openapi: { summary: "Actualizar Nota",         tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/notes/:objectId", req.url)!; return jsonRes(await api.updateNote(p.objectId, await req.json(), ctx)); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/notes/:objectId",                  _openapi: { summary: "Eliminar Nota",           tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/notes/:objectId", req.url)!; await api.deleteNote(p.objectId, ctx); return NO_CONTENT; } catch(e) { return errRes(e); } } },
      // Tasks
      { method: "GET"    as const, path: "/zen/tasks",                            _openapi: { summary: "Listar Tareas",           tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await api.listTasks(queryParams(new URL(req.url)), ctx)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/tasks",                            _openapi: { summary: "Crear Tarea",             tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await api.createTask(await req.json(), ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/tasks/:objectId",                  _openapi: { summary: "Actualizar Tarea",         tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/tasks/:objectId", req.url)!; return jsonRes(await api.updateTask(p.objectId, await req.json(), ctx)); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/tasks/:objectId",                  _openapi: { summary: "Eliminar Tarea",           tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/tasks/:objectId", req.url)!; await api.deleteTask(p.objectId, ctx); return NO_CONTENT; } catch(e) { return errRes(e); } } },
      // Comments
      { method: "GET"    as const, path: "/zen/comments/:targetClassName/:targetId", _openapi: { summary: "Listar Comentarios",  tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/comments/:targetClassName/:targetId", req.url)!; return jsonRes(await api.listComments(p.targetClassName, p.targetId)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/comments",                            _openapi: { summary: "Crear Comentario",    tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await api.createComment(await req.json(), ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/comments/:objectId",                  _openapi: { summary: "Editar Comentario",   tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/comments/:objectId", req.url)!; return jsonRes(await api.updateComment(p.objectId, await req.json(), ctx)); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/comments/:objectId",                  _openapi: { summary: "Eliminar Comentario", tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/comments/:objectId", req.url)!; await api.deleteComment(p.objectId, ctx); return NO_CONTENT; } catch(e) { return errRes(e); } } },
      // Attachments
      { method: "GET"    as const, path: "/zen/attachments/:targetClassName/:targetId", _openapi: { summary: "Listar Adjuntos",  tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/attachments/:targetClassName/:targetId", req.url)!; return jsonRes(await api.listAttachments(p.targetClassName, p.targetId)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/attachments",                           _openapi: { summary: "Subir Adjunto (multipart)", tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await api.uploadAttachment(req, ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/attachments/:objectId",                 _openapi: { summary: "Eliminar Adjunto",  tags: ["Collaboration"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/attachments/:objectId", req.url)!; await api.deleteAttachment(p.objectId, ctx); return NO_CONTENT; } catch(e) { return errRes(e); } } },
    ];

    return { collaboration_routes, collaboration: api };
  },
});
