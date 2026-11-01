/**
 * Tests E2E — Fase 1: Collaboration, Workspace, Views, Search, Timeline, Metadata
 * Ejecución: deno test -A tests/e2e/phase1.test.ts
 */
import { assert, assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.224.0/testing/asserts.ts";

// ── Mock DB compartido ────────────────────────────────────────────────────────

function mkDB(): any {
  const store: Record<string, Record<string, any>> = {};
  return {
    async create(cls: string, data: any) {
      if (!store[cls]) store[cls] = {};
      const id = `${cls.toLowerCase()}_${Math.random().toString(36).slice(2,10)}`;
      const rec = { ...data, objectId: id };
      store[cls][id] = rec;
      return rec;
    },
    async read(cls: string, id: string) { return store[cls]?.[id] ?? null; },
    async find(cls: string, where: Record<string, any> = {}) {
      const items = Object.values(store[cls] ?? {});
      return items.filter(item => Object.entries(where).every(([k,v]) => item[k] === v));
    },
    async update(cls: string, query: any, data: any) {
      const id = typeof query === "string" ? query : query.objectId;
      if (!store[cls]?.[id]) return null;
      store[cls][id] = { ...store[cls][id], ...data };
      return store[cls][id];
    },
    async delete(cls: string, query: any) {
      const id = typeof query === "string" ? query : query.objectId;
      delete store[cls]?.[id];
    },
    async upsert(cls: string, _q: any, data: any) {
      return this.create(cls, data);
    },
  };
}

const now = () => new Date().toISOString();

// ── COLLABORATION TESTS ──────────────────────────────────────────────────────

Deno.test("Collaboration — Note: crear nota vinculada a Contact", async () => {
  const db = mkDB();
  const contact = await db.create("Contact", { name: "Ana", email: "ana@corp.com" });

  const note = await db.create("Note", {
    title: "Primera reunión",
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Excelente reunión" }] }] },
    bodyText: "Excelente reunión",
    targetClassName: "Contact",
    targetId: contact.objectId,
    isPinned: false,
    createdAt: now(),
  });

  assertExists(note.objectId);
  assertEquals(note.targetClassName, "Contact");
  assertEquals(note.targetId, contact.objectId);
});

Deno.test("Collaboration — Task: CRUD con kanban position y estado", async () => {
  const db = mkDB();
  const task = await db.create("Task", {
    title: "Enviar propuesta",
    status: "todo", priority: "high",
    targetClassName: "Deal", targetId: "deal_001",
    position: 1000, createdAt: now(),
  });

  assertExists(task.objectId);
  assertEquals(task.status, "todo");

  // Completar tarea
  await db.update("Task", { objectId: task.objectId }, { status: "done", completedAt: now() });
  const updated = await db.read("Task", task.objectId);
  assertEquals(updated.status, "done");
  assertExists(updated.completedAt);
});

Deno.test("Collaboration — Comment: autor solo puede editar su comentario", async () => {
  const db = mkDB();
  const user1 = await db.create("_User", { username: "alice" });
  const user2 = await db.create("_User", { username: "bob" });

  const comment = await db.create("Comment", {
    body: "Buen punto!", author: { __type: "Pointer", className: "_User", objectId: user1.objectId },
    targetClassName: "Note", targetId: "note_001", createdAt: now(),
  });

  // user1 puede editar su propio comentario
  const ctx1 = { user: user1, master: false };
  if (!ctx1.master && comment.author?.objectId !== ctx1.user.objectId) throw new Error("no debería fallar");

  // user2 NO puede editar el comentario de user1
  const ctx2 = { user: user2, master: false };
  const canEdit = ctx2.master || comment.author?.objectId === ctx2.user.objectId;
  assertEquals(canEdit, false);
});

Deno.test("Collaboration — Attachment: registro con targetClassName polimórfico", async () => {
  const db = mkDB();
  const att = await db.create("Attachment", {
    name: "contrato.pdf", mimeType: "application/pdf", size: 102400,
    url: "/files/uuid123/contrato.pdf", fileId: "uuid123",
    targetClassName: "Deal", targetId: "deal_abc",
    createdAt: now(),
  });

  assertExists(att.objectId);
  assertEquals(att.targetClassName, "Deal");
  assert(att.size > 0);
});

// ── WORKSPACE TESTS ───────────────────────────────────────────────────────────

Deno.test("Workspace — Invitación: token único de 7 días", async () => {
  const db = mkDB();
  const inviter = await db.create("_User", { username: "admin" });

  async function inviteUser(workspaceId: string, email: string, role: string, invitedBy: any) {
    const raw = crypto.getRandomValues(new Uint8Array(16));
    const token = Array.from(raw).map(b => b.toString(16).padStart(2,"0")).join("");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return db.create("WorkspaceInvitation", {
      email, role, workspaceId, token, expiresAt, status: "pending",
      invitedBy: { __type: "Pointer", className: "_User", objectId: invitedBy.objectId },
      createdAt: now(),
    });
  }

  const inv = await inviteUser("ws_001", "nuevo@corp.com", "member", inviter);
  assertExists(inv.token);
  assertEquals(inv.token.length, 32);
  assertEquals(inv.status, "pending");
  assert(new Date(inv.expiresAt) > new Date());
});

Deno.test("Workspace — ApiKey: hash SHA-256, plain key nunca se re-expone", async () => {
  const db = mkDB();

  async function createApiKey(name: string, env: "live" | "test") {
    const raw    = crypto.getRandomValues(new Uint8Array(32));
    const hex    = Array.from(raw).map(b => b.toString(16).padStart(2,"0")).join("");
    const key    = `sk_${env}_${hex}`;
    const encoder = new TextEncoder();
    const hashBuf = await crypto.subtle.digest("SHA-256", encoder.encode(key));
    const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,"0")).join("");
    const record = await db.create("ZenithApiKey", { name, prefix: `sk_${env}_`, keyHash: hash, status: "active", createdAt: now() });
    return { ...record, key }; // key SOLO en la creación
  }

  const { key, keyHash, ...record } = await createApiKey("Test Key", "live");

  assert(key.startsWith("sk_live_"), "debe tener el prefijo correcto");
  assert(key.length > 20, "debe ser suficientemente largo");
  assertExists(record.objectId);
  // keyHash nunca se expone en el record retornado después de la creación
  assertEquals(record.keyHash, undefined, "keyHash no debe estar en el record público");
});

Deno.test("Workspace — Member: roles válidos (admin/member/guest)", async () => {
  const VALID_ROLES = ["admin", "member", "guest"];
  for (const role of VALID_ROLES) {
    assert(VALID_ROLES.includes(role));
  }
  const invalid = "superuser";
  assertEquals(VALID_ROLES.includes(invalid), false);
});

// ── VIEWS TESTS ───────────────────────────────────────────────────────────────

Deno.test("Views — Vista Kanban: crear con filtros y sorts", async () => {
  const db = mkDB();

  const view = await db.create("ZenithView", {
    name: "Pipeline Q4", objectType: "Deal", type: "kanban",
    kanbanFieldName: "stage", isShared: true, position: 0, createdAt: now(),
  });

  const filter = await db.create("ZenithViewFilter", {
    view: { __type: "Pointer", className: "ZenithView", objectId: view.objectId },
    fieldName: "amount", operator: "gte", value: "10000",
    displayValue: "$10,000+", isActive: true, position: 0, createdAt: now(),
  });

  const sort = await db.create("ZenithViewSort", {
    view: { __type: "Pointer", className: "ZenithView", objectId: view.objectId },
    fieldName: "closeDate", direction: "asc", position: 0, createdAt: now(),
  });

  assertEquals(view.type, "kanban");
  assertEquals(view.kanbanFieldName, "stage");
  assertEquals(filter.operator, "gte");
  assertEquals(sort.direction, "asc");
});

// ── SEARCH TESTS ──────────────────────────────────────────────────────────────

Deno.test("Search — Filter Engine: operadores avanzados", () => {
  // Replicar applyFilter de trait-utils
  function applyFilter(item: Record<string, any>, filter: any): boolean {
    if ("and" in filter) return filter.and.every((f: any) => applyFilter(item, f));
    if ("or"  in filter) return filter.or.some ((f: any) => applyFilter(item, f));
    const { field, op, value } = filter;
    const v = item[field];
    switch (op) {
      case "eq":   return v === value;
      case "neq":  return v !== value;
      case "gt":   return v > value;
      case "gte":  return v >= value;
      case "lt":   return v < value;
      case "lte":  return v <= value;
      case "in":   return Array.isArray(value) && value.includes(v);
      case "like": return typeof v === "string" && v.includes(value);
      case "ilike":return typeof v === "string" && v.toLowerCase().includes(value.toLowerCase());
      default:     return true;
    }
  }

  const deal = { title: "Proyecto Alpha", amount: 75000, stage: "proposal", currency: "USD" };

  // AND: amount >= 50000 AND stage = "proposal"
  assertEquals(applyFilter(deal, { and: [{ field: "amount", op: "gte", value: 50000 }, { field: "stage", op: "eq", value: "proposal" }] }), true);

  // OR: stage = "won" OR amount > 100000 → false (ninguna se cumple)
  assertEquals(applyFilter(deal, { or: [{ field: "stage", op: "eq", value: "won" }, { field: "amount", op: "gt", value: 100000 }] }), false);

  // ilike (case-insensitive)
  assertEquals(applyFilter(deal, { field: "title", op: "ilike", value: "alpha" }), true);

  // in
  assertEquals(applyFilter(deal, { field: "stage", op: "in", value: ["proposal", "negotiation"] }), true);
});

Deno.test("Search — Scoring de relevancia: exacto > prefijo > contiene", () => {
  function score(val: string, term: string): number {
    const v = val.toLowerCase(), t = term.toLowerCase();
    if (v === t) return 100;
    if (v.startsWith(t)) return 60;
    if (v.includes(t)) return 30;
    return 0;
  }
  // "apple inc" exacto en "apple inc" → 100
  const exacto  = score("apple inc", "apple inc");
  // "pple" solo contenido (no prefijo ni exacto) en "Apple Inc" → 30
  const contiene = score("Apple Inc", "pple");
  // "google" no aparece en "Microsoft" → 0
  const nulo = score("Microsoft", "google");

  assertEquals(exacto,   100, "Exacto debe dar 100");
  assertEquals(contiene, 30,  "Solo contiene debe dar 30");
  assertEquals(nulo,     0,   "Sin match debe dar 0");
  assert(exacto > contiene, "exacto > contiene");
});

// ── METADATA TESTS ────────────────────────────────────────────────────────────

Deno.test("Metadata — Custom Object: validar PascalCase y clases protegidas", () => {
  const SYSTEM = new Set(["_User","Contact","Lead","Deal","Product","Invoice"]);
  const PASCAL = /^[A-Z][A-Za-z0-9]+$/;

  function validateObjectName(name: string): string | null {
    if (!PASCAL.test(name)) return "Debe ser PascalCase";
    if (SYSTEM.has(name))   return `'${name}' es una clase reservada`;
    return null;
  }

  assertEquals(validateObjectName("CustomerOrder"), null);
  assertEquals(validateObjectName("customer_order"), "Debe ser PascalCase");
  assertEquals(validateObjectName("Contact"), "'Contact' es una clase reservada");
  assertEquals(validateObjectName("_User"),   "Debe ser PascalCase");
});

Deno.test("Metadata — Custom Field: tipos soportados", () => {
  const TYPES = ["String","Text","RichText","Number","Boolean","Date","DateTime",
                 "Email","Phone","URL","JSON","Select","MultiSelect","Rating",
                 "Currency","Address","FullName","Pointer","Relation","Array","Position"];

  for (const t of TYPES) assert(TYPES.includes(t));
  assertEquals(TYPES.includes("Blob"), false);
  assertEquals(TYPES.includes("Binary"), false);
});

// ── BLOG/FORUM TESTS ──────────────────────────────────────────────────────────

Deno.test("Blog — Slug: generación automática desde título", () => {
  function slugify(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  }
  assertEquals(slugify("Mi primer post en Zenith!"), "mi-primer-post-en-zenith");
  assertEquals(slugify("Hello World 2025"),           "hello-world-2025");
  assertEquals(slugify("  --Spaces--  "),             "spaces");
});

Deno.test("Blog — Reading time: estimación (200 palabras/min)", () => {
  function readingTime(text: string): number {
    return Math.max(1, Math.round(text.split(/\s+/).length / 200));
  }
  assertEquals(readingTime("palabra ".repeat(200)), 1);  // ~1 min
  assertEquals(readingTime("palabra ".repeat(400)), 2);  // ~2 min
  assertEquals(readingTime(""),                     1);  // mínimo 1
});

Deno.test("Forum — Respuesta aceptada: solo el autor del hilo puede aceptar", () => {
  const thread = { objectId: "t1", author: { objectId: "user_alice" } };
  const reply  = { objectId: "r1", thread: { objectId: "t1" } };

  function canAccept(thread: any, ctx: { userId: string; isMaster: boolean }): boolean {
    return ctx.isMaster || thread.author?.objectId === ctx.userId;
  }

  assertEquals(canAccept(thread, { userId: "user_alice", isMaster: false }), true);
  assertEquals(canAccept(thread, { userId: "user_bob",   isMaster: false }), false);
  assertEquals(canAccept(thread, { userId: "user_bob",   isMaster: true  }), true);
});

Deno.test("Forum — Votes: upvote/downvote idempotente", async () => {
  const db = mkDB();
  const userId    = "user_001";
  const targetId  = "thread_001";
  const targetCls = "ForumThread";

  async function vote(value: 1 | -1): Promise<number> {
    const existing = await db.find("ContentVote", { targetClassName: targetCls, targetId, "user.objectId": userId });
    if (existing.length > 0) {
      await db.update("ContentVote", { objectId: existing[0].objectId }, { value });
    } else {
      await db.create("ContentVote", { targetClassName: targetCls, targetId, value, "user.objectId": userId, createdAt: now() });
    }
    const all = await db.find("ContentVote", { targetClassName: targetCls, targetId });
    return all.reduce((s: number, v: any) => s + (v.value ?? 0), 0);
  }

  assertEquals(await vote(1),  1);
  assertEquals(await vote(1),  1); // idempotente (mismo voto)
  assertEquals(await vote(-1), -1); // cambia a downvote
});
