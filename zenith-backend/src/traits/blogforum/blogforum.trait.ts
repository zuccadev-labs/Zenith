// deno-lint-ignore-file no-unused-vars
/**
 * Blog & Forum Trait — Contenido monetizable y comunidad.
 *
 * Blog: posts con rich-text, tags, SEO, draft/published, author, monetización (paywall).
 * Forum: categorías, hilos, respuestas, votos, resolución de respuesta.
 * Ambos usan el patrón polimórfico del CollaborationTrait para
 * Comments y Attachments — no duplica lógica.
 *
 * @barrits-trait
 * @barrits-summary ZenithBlogForum
 * @barrits-provides blogforum_routes, blog, forum
 * @barrits-consumes cloud, db
 * @barrits-tags uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import {
  errRes,
  jsonRes,
  NO_CONTENT,
  now,
  parsePage,
  pathParams,
  ptr,
  queryParams,
  sortResults,
} from "../../core/trait-utils.ts";

const CONTENT_SCHEMAS = {
  BlogPost: {
    title: { type: "String", required: true },
    slug: { type: "String", required: true }, // URL-friendly, único
    excerpt: { type: "String" },
    body: { type: "Object" }, // Rich-text JSON (Tiptap/Lexical)
    bodyText: { type: "String" }, // Texto plano para search
    coverImage: { type: "String" }, // URL
    tags: { type: "Array", defaultValue: [] },
    author: { type: "Pointer", targetClass: "_User" },
    status: { type: "String", defaultValue: "draft" }, // draft|published|archived
    isPremium: { type: "Boolean", defaultValue: false }, // Requiere suscripción
    readingTime: { type: "Number" }, // minutos estimados
    viewCount: { type: "Number", defaultValue: 0 },
    likeCount: { type: "Number", defaultValue: 0 },
    seoTitle: { type: "String" },
    seoDesc: { type: "String" },
    canonicalUrl: { type: "String" },
    publishedAt: { type: "Date" },
  },
  ForumCategory: {
    name: { type: "String", required: true },
    slug: { type: "String", required: true },
    description: { type: "String" },
    icon: { type: "String" },
    position: { type: "Number", defaultValue: 0 },
    postCount: { type: "Number", defaultValue: 0 },
    isPrivate: { type: "Boolean", defaultValue: false },
  },
  ForumThread: {
    title: { type: "String", required: true },
    body: { type: "Object" }, // Rich-text JSON
    bodyText: { type: "String" },
    category: { type: "Pointer", targetClass: "ForumCategory", required: true },
    author: { type: "Pointer", targetClass: "_User" },
    status: { type: "String", defaultValue: "open" }, // open|closed|pinned|solved
    tags: { type: "Array", defaultValue: [] },
    viewCount: { type: "Number", defaultValue: 0 },
    replyCount: { type: "Number", defaultValue: 0 },
    voteCount: { type: "Number", defaultValue: 0 },
    solvedReply: { type: "Pointer", targetClass: "ForumReply" }, // Respuesta aceptada
    lastReplyAt: { type: "Date" },
    isPinned: { type: "Boolean", defaultValue: false },
    isPremium: { type: "Boolean", defaultValue: false },
  },
  ForumReply: {
    body: { type: "Object" }, // Rich-text JSON
    bodyText: { type: "String" },
    thread: { type: "Pointer", targetClass: "ForumThread", required: true },
    author: { type: "Pointer", targetClass: "_User" },
    voteCount: { type: "Number", defaultValue: 0 },
    isAccepted: { type: "Boolean", defaultValue: false },
    editedAt: { type: "Date" },
    parent: { type: "Pointer", targetClass: "ForumReply" }, // Para respuestas anidadas
  },
  ContentVote: {
    targetClassName: { type: "String", required: true }, // "BlogPost"|"ForumThread"|"ForumReply"
    targetId: { type: "String", required: true },
    user: { type: "Pointer", targetClass: "_User", required: true },
    value: { type: "Number", defaultValue: 1 }, // 1 (upvote) | -1 (downvote)
  },
} as const;

/** Genera slug URL-safe desde un título */
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

/** Estima minutos de lectura (promedio 200 palabras/min) */
function readingTime(bodyText?: string): number {
  return Math.max(1, Math.round((bodyText ?? "").split(/\s+/).length / 200));
}

/**
 * Blog and forum trait: blog posts (drafts, tags, SEO, paywall) and forum categories, threads,
 * replies, votes and accepted answers, under `/zen/blog/*`, `/zen/forum/*` and `/zen/content/vote`.
 */
export const BlogForumTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithBlogForum",
  provides: ["blogforum_routes", "blog", "forum"],
  consumes: ["cloud", "db"],
  tags: ["uses:events"],
  state: [],
  runtimes: ["deno"],

  summary:
    "Monetizable Blog (draft/publish/premium paywall, SEO, rich-text) and Community Forum (categories, threads, replies, votes, accepted answer). Uses CollaborationTrait for comments/attachments.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const events = deps.traits["events"];

    if (deps.traits["cloud"]?.defineSchema) {
      for (const [name, fields] of Object.entries(CONTENT_SCHEMAS)) {
        deps.traits["cloud"].defineSchema(name, fields, {});
      }
    }

    // ─── Blog API ──────────────────────────────────────────────────────────────

    const blog = {
      async list(q: Record<string, any>, ctx: any) {
        const where: Record<string, any> = {};
        if (q.status) where.status = q.status;
        // Usuarios no admin solo ven posts publicados
        if (!ctx?.master && !ctx?.user) where.status = "published";
        if (q.tag) where.tags = q.tag;
        const { limit, skip, order } = parsePage(q);
        let results = await db.find("BlogPost", where);
        if (q.tag) {
          results = results.filter((p: any) => Array.isArray(p.tags) && p.tags.includes(q.tag));
        }
        return { results: sortResults(results, order ?? "-publishedAt").slice(skip, skip + limit) };
      },

      async getBySlug(slug: string) {
        const posts = await db.find("BlogPost", { slug });
        if (!posts.length) throw ZenithErrors.notFound("BlogPost", slug);
        const post = posts[0];
        await db.update("BlogPost", { objectId: post.objectId }, {
          viewCount: (post.viewCount ?? 0) + 1,
        }).catch(() => {});
        return post;
      },

      async create(data: Record<string, any>, ctx: any) {
        if (!data.title) throw ZenithErrors.validationFailed("title es obligatorio.");
        const slug = data.slug ?? slugify(data.title);
        const body = {
          ...data,
          slug,
          status: data.status ?? "draft",
          readingTime: readingTime(data.bodyText),
          author: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          publishedAt: data.status === "published" ? now() : null,
          viewCount: 0,
          likeCount: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        const post = await db.create("BlogPost", body);
        if (events && post.status === "published") events.emit("Blog.published", post);
        return post;
      },

      async update(objectId: string, data: Record<string, any>, ctx: any) {
        const existing = await db.read("BlogPost", objectId);
        if (!existing) throw ZenithErrors.notFound("BlogPost", objectId);
        const patch: Record<string, any> = { ...data, updatedAt: now() };
        if (patch.bodyText) patch.readingTime = readingTime(patch.bodyText);
        if (patch.status === "published" && existing.status !== "published") {
          patch.publishedAt = now();
        }
        const updated = await db.update("BlogPost", { objectId }, patch);
        if (events && patch.status === "published") {
          events.emit("Blog.published", updated ?? existing);
        }
        return updated;
      },

      async delete(objectId: string) {
        const existing = await db.read("BlogPost", objectId);
        if (!existing) throw ZenithErrors.notFound("BlogPost", objectId);
        await db.delete("BlogPost", { objectId });
        return { success: true };
      },
    };

    // ─── Forum API ─────────────────────────────────────────────────────────────

    const forum = {
      async listCategories() {
        const results = await db.find("ForumCategory", {});
        return { results: sortResults(results, "position") };
      },

      async createCategory(data: Record<string, any>) {
        if (!data.name) throw ZenithErrors.validationFailed("name es obligatorio.");
        const slug = data.slug ?? slugify(data.name);
        return db.create("ForumCategory", {
          ...data,
          slug,
          postCount: 0,
          createdAt: now(),
          updatedAt: now(),
        });
      },

      async listThreads(q: Record<string, any>) {
        const where: Record<string, any> = {};
        if (q.categoryId) where["category.objectId"] = q.categoryId;
        if (q.status) where.status = q.status;
        const { limit, skip, order } = parsePage(q);
        const all = await db.find("ForumThread", where);
        return { results: sortResults(all, order ?? "-lastReplyAt").slice(skip, skip + limit) };
      },

      async createThread(data: Record<string, any>, ctx: any) {
        if (!data.title || !data.categoryId) {
          throw ZenithErrors.validationFailed("title y categoryId son obligatorios.");
        }
        const thread = await db.create("ForumThread", {
          ...data,
          category: ptr("ForumCategory", data.categoryId),
          author: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          status: "open",
          viewCount: 0,
          replyCount: 0,
          voteCount: 0,
          createdAt: now(),
          updatedAt: now(),
          lastReplyAt: now(),
        });
        // Incrementar postCount de la categoría
        const cat = await db.read("ForumCategory", data.categoryId);
        if (cat) {
          await db.update("ForumCategory", { objectId: data.categoryId }, {
            postCount: (cat.postCount ?? 0) + 1,
          });
        }
        if (events) events.emit("Forum.threadCreated", thread);
        return thread;
      },

      async replyThread(threadId: string, data: Record<string, any>, ctx: any) {
        if (!data.body) throw ZenithErrors.validationFailed("body es obligatorio para responder.");
        const thread = await db.read("ForumThread", threadId);
        if (!thread) throw ZenithErrors.notFound("ForumThread", threadId);
        if (thread.status === "closed") throw ZenithErrors.forbidden("El hilo está cerrado.");
        const reply = await db.create("ForumReply", {
          ...data,
          thread: ptr("ForumThread", threadId),
          author: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          voteCount: 0,
          isAccepted: false,
          createdAt: now(),
          updatedAt: now(),
        });
        await db.update("ForumThread", { objectId: threadId }, {
          replyCount: (thread.replyCount ?? 0) + 1,
          lastReplyAt: now(),
          updatedAt: now(),
        });
        if (events) events.emit("Forum.replied", { thread, reply });
        return reply;
      },

      async acceptReply(replyId: string, ctx: any) {
        const reply = await db.read("ForumReply", replyId);
        if (!reply) throw ZenithErrors.notFound("ForumReply", replyId);
        const thread = await db.read("ForumThread", reply.thread?.objectId);
        if (!thread) throw ZenithErrors.notFound("ForumThread");
        if (!ctx.master && thread.author?.objectId !== ctx.user?.objectId) {
          throw ZenithErrors.forbidden("Solo el autor del hilo puede aceptar una respuesta.");
        }
        await db.update("ForumReply", { objectId: replyId }, {
          isAccepted: true,
          updatedAt: now(),
        });
        await db.update("ForumThread", { objectId: thread.objectId }, {
          status: "solved",
          solvedReply: ptr("ForumReply", replyId),
          updatedAt: now(),
        });
        if (events) events.emit("Forum.solved", { threadId: thread.objectId, replyId });
        return { success: true };
      },

      async vote(targetClassName: string, targetId: string, value: 1 | -1, ctx: any) {
        if (!ctx.user) throw ZenithErrors.unauthorized();
        const existing = await db.find("ContentVote", {
          targetClassName,
          targetId,
          "user.objectId": ctx.user.objectId,
        });
        if (existing.length > 0) {
          await db.update("ContentVote", { objectId: existing[0].objectId }, {
            value,
            updatedAt: now(),
          });
        } else {
          await db.create("ContentVote", {
            targetClassName,
            targetId,
            value,
            user: ptr("_User", ctx.user.objectId),
            createdAt: now(),
          });
        }
        // Recalcular voteCount
        const allVotes = await db.find("ContentVote", { targetClassName, targetId });
        const voteCount = allVotes.reduce((sum: number, v: any) => sum + (v.value ?? 0), 0);
        await db.update(targetClassName, { objectId: targetId }, { voteCount, updatedAt: now() });
        return { voteCount };
      },
    };

    // ─── Rutas ────────────────────────────────────────────────────────────────

    const blogforum_routes = [
      // Blog
      {
        method: "GET" as const,
        path: "/zen/blog/posts",
        _openapi: { summary: "Listar Blog Posts", tags: ["Blog"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonRes(await blog.list(queryParams(new URL(req.url)), ctx));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/blog/posts/:slug",
        _openapi: { summary: "Obtener Post por slug", tags: ["Blog"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/blog/posts/:slug", req.url)!;
            return jsonRes(await blog.getBySlug(p.slug));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/blog/posts",
        _openapi: { summary: "Crear Blog Post", tags: ["Blog"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonRes(await blog.create(await req.json(), ctx), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "PUT" as const,
        path: "/zen/blog/posts/:objectId",
        _openapi: { summary: "Actualizar Blog Post", tags: ["Blog"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/blog/posts/:objectId", req.url)!;
            return jsonRes(await blog.update(p.objectId, await req.json(), ctx));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "DELETE" as const,
        path: "/zen/blog/posts/:objectId",
        _openapi: { summary: "Eliminar Blog Post", tags: ["Blog"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/blog/posts/:objectId", req.url)!;
            await blog.delete(p.objectId);
            return NO_CONTENT;
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Forum
      {
        method: "GET" as const,
        path: "/zen/forum/categories",
        _openapi: { summary: "Listar Categorías del Foro", tags: ["Forum"] },
        handler: async (_req: Request, _ctx: any) => {
          try {
            return jsonRes(await forum.listCategories());
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/forum/categories",
        _openapi: { summary: "Crear Categoría", tags: ["Forum"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonRes(await forum.createCategory(await req.json()), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/forum/threads",
        _openapi: { summary: "Listar Hilos", tags: ["Forum"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonRes(await forum.listThreads(queryParams(new URL(req.url))));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/forum/threads",
        _openapi: { summary: "Crear Hilo", tags: ["Forum"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonRes(await forum.createThread(await req.json(), ctx), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/forum/threads/:threadId/replies",
        _openapi: { summary: "Responder Hilo", tags: ["Forum"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/forum/threads/:threadId/replies", req.url)!;
            return jsonRes(await forum.replyThread(p.threadId, await req.json(), ctx), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/forum/replies/:replyId/accept",
        _openapi: { summary: "Aceptar Respuesta (marcar como solución)", tags: ["Forum"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/forum/replies/:replyId/accept", req.url)!;
            return jsonRes(await forum.acceptReply(p.replyId, ctx));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Votes (Blog + Forum)
      {
        method: "POST" as const,
        path: "/zen/content/vote",
        _openapi: { summary: "Votar (Blog Post / Forum Thread / Reply)", tags: ["Blog", "Forum"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const b = await req.json();
            return jsonRes(await forum.vote(b.targetClassName, b.targetId, b.value, ctx));
          } catch (e) {
            return errRes(e);
          }
        },
      },
    ];

    return { blogforum_routes, blog, forum };
  },
});
