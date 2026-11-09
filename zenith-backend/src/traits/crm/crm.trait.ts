// deno-lint-ignore-file no-unused-vars
/**
 * Enterprise CRM Trait — CRUD completo para los módulos de negocio CRM.
 *
 * Patrón: idéntico a RestCrudTrait. Define una `traitApi` interna que encapsula
 * toda la lógica de negocio (Smart DB Routing, Pointers, ACL, Cloud hooks),
 * y luego las rutas HTTP consumen esa API sin duplicar lógica.
 *
 * Smart DB Routing:
 *   - Contact, Lead, Deal, Account, Pipeline, Campaign → MongoDB (documentos)
 *   - Activity                                         → ScyllaDB (stream de eventos)
 *   - CRM_Insight                                      → VectorDB (embeddings IA / RAG)
 *
 * @barrits-trait
 * @barrits-summary ZenithCRMTrait
 * @barrits-provides crm_routes, crm
 * @barrits-consumes acl, cloud, db, telemetry
 * @barrits-tags uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";

// ─── Schemas CRM (fuente de verdad única, registrados al crear el Trait) ───────

/** Definición completa de schemas CRM con Smart DB Routing hints */
const CRM_SCHEMAS = {
  Contact: {
    fields: {
      name:    { type: "String", required: true },
      email:   { type: "String", required: true },
      phone:   { type: "String" },
      company: { type: "String" },
      title:   { type: "String" },
      tags:    { type: "Array",  defaultValue: [] },
      source:  { type: "String", defaultValue: "manual" }, // manual|web|import|referral|campaign
      score:   { type: "Number", defaultValue: 0 },
      notes:   { type: "String" },
      owner:   { type: "Pointer", targetClass: "_User" },
    },
    options: {} // MongoDB (default)
  },
  Lead: {
    fields: {
      contact:    { type: "Pointer", targetClass: "Contact", required: true },
      owner:      { type: "Pointer", targetClass: "_User",   required: true },
      stage:      { type: "String",  defaultValue: "new" },   // new|contacted|qualified|proposal|negotiation|won|lost
      value:      { type: "Number",  defaultValue: 0 },
      currency:   { type: "String",  defaultValue: "USD" },
      probability:{ type: "Number",  defaultValue: 10 },       // 0-100
      closeDate:  { type: "Date" },
      lostReason: { type: "String" },
      score:      { type: "Number",  defaultValue: 0 },
    },
    options: {}
  },
  Deal: {
    fields: {
      title:     { type: "String",   required: true },
      contacts:  { type: "Relation", targetClass: "Contact" },
      owner:     { type: "Pointer",  targetClass: "_User",    required: true },
      pipeline:  { type: "String",   defaultValue: "default" },
      stage:     { type: "String",   required: true },
      amount:    { type: "Number",   defaultValue: 0 },
      currency:  { type: "String",   defaultValue: "USD" },
      closeDate: { type: "Date" },
      wonAt:     { type: "Date" },
      lostAt:    { type: "Date" },
    },
    options: {}
  },
  Account: {
    fields: {
      name:     { type: "String", required: true },
      industry: { type: "String" },
      size:     { type: "Number" },
      revenue:  { type: "Number" },
      website:  { type: "String" },
      contacts: { type: "Relation", targetClass: "Contact" },
      owner:    { type: "Pointer",  targetClass: "_User" },
    },
    options: {}
  },
  Pipeline: {
    fields: {
      name:      { type: "String",  required: true },
      stages:    { type: "Array" }, // [{name, probability, order}]
      isDefault: { type: "Boolean", defaultValue: false },
      owner:     { type: "Pointer", targetClass: "_User" },
    },
    options: {}
  },
  Campaign: {
    fields: {
      name:      { type: "String", required: true },
      type:      { type: "String", defaultValue: "email" }, // email|sms|push|social
      status:    { type: "String", defaultValue: "draft" }, // draft|active|paused|completed
      audience:  { type: "Array",  defaultValue: [] },
      startDate: { type: "Date" },
      endDate:   { type: "Date" },
      metrics:   { type: "Object", defaultValue: { sent: 0, opened: 0, clicked: 0, converted: 0 } },
    },
    options: {}
  },
  // ── Stream de Eventos → ScyllaDB (Time-Series) ──────────────────────────────
  Activity: {
    fields: {
      type:        { type: "String",  required: true }, // call|email|meeting|task|note|system
      subject:     { type: "String",  required: true },
      contact:     { type: "Pointer", targetClass: "Contact" },
      lead:        { type: "Pointer", targetClass: "Lead" },
      deal:        { type: "Pointer", targetClass: "Deal" },
      owner:       { type: "Pointer", targetClass: "_User" },
      dueAt:       { type: "Date" },
      completedAt: { type: "Date" },
      notes:       { type: "String",  defaultValue: "" },
      outcome:     { type: "String" }, // completed|no_answer|deal_won|deal_lost
    },
    options: { "x-database": "scylla" } // Smart Routing → ScyllaDB
  },
  // ── Embeddings IA → VectorDB (Qdrant/Milvus) ────────────────────────────────
  CRM_Insight: {
    fields: {
      entityId:    { type: "String", required: true },
      entityType:  { type: "String", required: true }, // Contact|Lead|Deal
      vector_data: { type: "Array",  required: true },
      sentiment:   { type: "String" },
      summary:     { type: "String" },
    },
    options: { "x-database": "vector" } // Smart Routing → VectorDB
  },
} as const;

// ─── Helper: parsear querystring con soporte `where` JSON ─────────────────────
function parseQueryParams(url: URL): Record<string, any> {
  const query: Record<string, any> = {};
  url.searchParams.forEach((v, k) => {
    try { query[k] = k === "where" ? JSON.parse(v) : v; } catch { query[k] = v; }
  });
  return query;
}

// ─── Helper: extraer pathParams de una URL con patrón ─────────────────────────
function matchPath(pattern: string, url: string): Record<string, string> | null {
  const result = new URLPattern({ pathname: pattern }).exec(url);
  return result ? (result.pathname.groups as Record<string, string>) : null;
}

// ─── Helper: respuesta JSON estandarizada (Parse Server compat) ───────────────
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(err: any): Response {
  const status = typeof err?.httpStatus === "number" ? err.httpStatus : 500;
  return new Response(
    JSON.stringify({ code: err?.code ?? 1, error: err?.message ?? "Internal Server Error" }),
    { status, headers: { "content-type": "application/json" } },
  );
}

// ─── Trait Principal ──────────────────────────────────────────────────────────

export const CRMTrait = createTraitDescriptor({
  name: "ZenithCRMTrait",
  provides: ["crm_routes", "crm"],
  consumes: ["acl", "cloud", "db", "telemetry"],
  tags: ["uses:events"],
  state: [],
  runtimes: ["deno"],

  summary: "Enterprise CRM: CRUD completo (Contact, Lead, Deal, Account, Pipeline, Campaign), Smart DB Routing (Mongo/Scylla/VectorDB), AI Insights, y Cloud Code hooks.",

  create: (deps: Record<string, any>) => {
    const db      = deps.traits["db"];
    const acl     = deps.traits["acl"];
    const cloud   = deps.traits["cloud"];
    const events  = deps.traits["events"];
    const obs     = deps.traits["telemetry"];

    // 1. Registrar schemas al inicializar el Trait (fuente de verdad única)
    if (cloud?.defineSchema) {
      for (const [className, def] of Object.entries(CRM_SCHEMAS)) {
        cloud.defineSchema(className, (def as any).fields, (def as any).options);
      }
      obs?.log?.("[CRMTrait] ✅ Schemas CRM registrados (Contact, Lead, Deal, Account, Pipeline, Campaign, Activity, CRM_Insight).");
    }

    // 2. Registrar Cloud Functions de negocio
    if (cloud?.define) {
      /**
       * Lead Scoring: calcula score basado en actividades, valor y stage.
       * Fórmula corporativa: (activityScore * 0.4) + (valueScore * 0.4) + (stageScore * 0.2)
       */
      cloud.define("crm_qualifyLead", async (request: any) => {
        const { leadId } = request.params;
        const lead = await db.read("Lead", leadId);
        if (!lead) throw ZenithErrors.notFound("Lead", leadId);

        const activities = await db.find("Activity", { "lead.objectId": leadId });
        const activityScore = Math.min(activities.length * 10, 100);
        const valueScore    = Math.min(((lead.value ?? 0) / 100_000) * 100, 100);
        const stageMap: Record<string, number> = {
          new: 10, contacted: 25, qualified: 50, proposal: 70, negotiation: 85, won: 100, lost: 0,
        };
        const stageScore = stageMap[lead.stage] ?? 0;
        const finalScore = Math.round(activityScore * 0.4 + valueScore * 0.4 + stageScore * 0.2);

        await db.update("Lead", { objectId: leadId }, { score: finalScore, updatedAt: new Date().toISOString() });
        if (lead.contact?.objectId) {
          await db.update("Contact", { objectId: lead.contact.objectId }, { score: finalScore });
        }
        return { leadId, score: finalScore, breakdown: { activityScore, valueScore, stageScore } };
      });

      /**
       * Convierte un Lead cualificado en un Deal.
       * Atomicidad: si falla el insert del Deal, el Lead no cambia de stage.
       */
      cloud.define("crm_convertLeadToDeal", async (request: any) => {
        const { leadId, dealTitle, amount, pipeline, stage, closeDate } = request.params;
        const lead = await db.read("Lead", leadId);
        if (!lead) throw ZenithErrors.notFound("Lead", leadId);
        if (lead.stage === "won" || lead.stage === "lost") {
          throw ZenithErrors.invalidRequest(`Lead ${leadId} ya está en estado '${lead.stage}'.`);
        }

        const deal = await db.create("Deal", {
          title:     dealTitle ?? `Deal de Lead ${leadId}`,
          owner:     lead.owner,
          pipeline:  pipeline ?? "default",
          stage:     stage ?? "proposal",
          amount:    amount ?? lead.value,
          currency:  lead.currency ?? "USD",
          closeDate: closeDate ?? lead.closeDate,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // Relacionar el contacto del Lead al Deal (Parse Relation)
        if (lead.contact?.objectId) {
          await db.update("Deal", { objectId: deal.objectId }, {
            contacts: { __op: "AddRelation", objects: [lead.contact] },
          });
        }

        // Marcar Lead como ganado solo si el Deal se creó exitosamente
        await db.update("Lead", { objectId: leadId }, { stage: "won", updatedAt: new Date().toISOString() });

        if (events) events.emit("CRM.leadConverted", { leadId, dealId: deal.objectId });
        return { deal, leadId, converted: true };
      });

      /**
       * Pipeline Summary: deals agrupados por stage con totales financieros.
       */
      cloud.define("crm_pipelineSummary", async (request: any) => {
        const { pipelineId } = request.params;
        const where: Record<string, any> = {};
        if (pipelineId) where.pipeline = pipelineId;

        const deals = await db.find("Deal", where);
        const summary: Record<string, { count: number; totalAmount: number; deals: any[] }> = {};
        for (const deal of deals) {
          if (!summary[deal.stage]) summary[deal.stage] = { count: 0, totalAmount: 0, deals: [] };
          summary[deal.stage].count++;
          summary[deal.stage].totalAmount += deal.amount ?? 0;
          summary[deal.stage].deals.push({ objectId: deal.objectId, title: deal.title, amount: deal.amount });
        }
        const stages = Object.entries(summary).map(([stage, data]) => ({
          stage,
          count: data.count,
          totalAmount: parseFloat(data.totalAmount.toFixed(2)),
          deals: data.deals,
        }));
        const grandTotal = stages.reduce((s, st) => s + st.totalAmount, 0);
        return { stages, totalDeals: deals.length, grandTotal: parseFloat(grandTotal.toFixed(2)) };
      });
    }

    // 3. Registrar Cloud Triggers
    if (cloud?.beforeSave) {
      // Zero Trust: auto-asignar owner si viene de sesión autenticada
      cloud.beforeSave("Contact", async (request: any) => {
        if (!request.master && !request.object.owner && request.user?.objectId) {
          request.object.owner = { __type: "Pointer", className: "_User", objectId: request.user.objectId };
        }
      });

      // AI Embeddings: generar insights vectoriales para RAG tras crear/actualizar Lead
      cloud.afterSave("Lead", (request: any) => {
        const lead = request.object;
        // Fire-and-forget: no bloquea la respuesta HTTP
        setTimeout(async () => {
          try {
            const text = `Stage:${lead.stage} Value:${lead.value} Source:${lead.source ?? "unknown"}`;
            const vector = cloud.getEmbeddings
              ? await cloud.getEmbeddings(text)
              : [0.1, 0.2, -0.1]; // mock dev fallback

            await db.create("CRM_Insight", {
              entityId:   lead.objectId,
              entityType: "Lead",
              vector_data: vector,
              summary: `Auto-insight ${new Date().toISOString()}`,
            });
          } catch (e) {
            obs?.warn?.(`[CRMTrait] AI Insight failed for Lead ${lead.objectId}: ${(e as Error).message}`);
          }
        }, 0);
      });
    }

    // ─── 4. traitApi interno (patrón RestCrudTrait) ────────────────────────────
    //
    // Toda lógica de negocio vive aquí. Las rutas HTTP son thin wrappers
    // que parsean la request, llaman a traitApi, y serialzan la respuesta.
    // Esto permite reutilizar la lógica desde Cloud Functions, batch ops, etc.

    const traitApi = {

      // ── Contact ──────────────────────────────────────────────────────────────

      listContacts: async (query: Record<string, any>, ctx: any) => {
        await cloud?.runBeforeFind?.("Contact", { query, user: ctx.user, master: ctx.master });
        const where = query.where ?? {};
        const limit = Math.min(parseInt(query.limit ?? "100", 10), 1000);
        const skip  = parseInt(query.skip  ?? "0",   10);
        let results = await db.find("Contact", where);
        if (query.order) {
          const key  = query.order.replace(/^-/, "");
          const desc = query.order.startsWith("-");
          results.sort((a: any, b: any) => desc ? (a[key] < b[key] ? 1 : -1) : (a[key] < b[key] ? -1 : 1));
        }
        const count = query.count === "1" ? results.length : undefined;
        results = results.slice(skip, skip + limit);
        await cloud?.runAfterFind?.("Contact", { results, user: ctx.user, master: ctx.master });
        const resp: any = { results };
        if (count !== undefined) resp.count = count;
        return resp;
      },

      getContact: async (objectId: string, ctx: any) => {
        await cloud?.runBeforeFind?.("Contact", { objectId, user: ctx.user, master: ctx.master });
        const obj = await db.read("Contact", objectId);
        if (!obj) throw ZenithErrors.notFound("Contact", objectId);
        if (!ctx.master && obj.ACL && !acl?.checkRead(obj.ACL, ctx.user)) throw ZenithErrors.forbidden();
        await cloud?.runAfterFind?.("Contact", { object: obj, user: ctx.user, master: ctx.master });
        return obj;
      },

      createContact: async (data: Record<string, any>, ctx: any) => {
        if (!data.name || !data.email) throw ZenithErrors.validationFailed("name y email son obligatorios.");
        // Autocleanup: assignar owner si viene de sesión
        if (!data.owner && ctx.user?.objectId) {
          data.owner = { __type: "Pointer", className: "_User", objectId: ctx.user.objectId };
        }
        await cloud?.runBeforeSave?.("Contact", { object: data, user: ctx.user, master: ctx.master });
        const created = await db.create("Contact", { ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        // Registrar activity en ScyllaDB (fire-and-forget)
        db.create("Activity", {
          type: "system", subject: `Contacto creado: ${created.name}`,
          contact: { __type: "Pointer", className: "Contact", objectId: created.objectId },
          date: new Date().toISOString(),
        }).catch((e: Error) => obs?.warn?.(`[CRMTrait] Activity stream failed: ${e.message}`));
        await cloud?.runAfterSave?.("Contact", { object: created, user: ctx.user, master: ctx.master });
        if (events) events.emit("CRM.contactCreated", created);
        return created;
      },

      updateContact: async (objectId: string, data: Record<string, any>, ctx: any) => {
        const existing = await db.read("Contact", objectId);
        if (!existing) throw ZenithErrors.notFound("Contact", objectId);
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        await cloud?.runBeforeSave?.("Contact", { object: { ...existing, ...data }, original: existing, user: ctx.user, master: ctx.master });
        const updated = await db.update("Contact", { objectId }, { ...data, updatedAt: new Date().toISOString() });
        await cloud?.runAfterSave?.("Contact", { object: updated, original: existing, user: ctx.user, master: ctx.master });
        if (events) events.emit("CRM.contactUpdated", updated);
        return updated;
      },

      deleteContact: async (objectId: string, ctx: any) => {
        const existing = await db.read("Contact", objectId);
        if (!existing) throw ZenithErrors.notFound("Contact", objectId);
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        await cloud?.runBeforeDelete?.("Contact", { object: existing, user: ctx.user, master: ctx.master });
        await db.delete("Contact", { objectId });
        await cloud?.runAfterDelete?.("Contact", { object: existing, user: ctx.user, master: ctx.master });
        if (events) events.emit("CRM.contactDeleted", { objectId });
        return { success: true };
      },

      // ── Lead ─────────────────────────────────────────────────────────────────

      listLeads: async (query: Record<string, any>, ctx: any) => {
        await cloud?.runBeforeFind?.("Lead", { query, user: ctx.user, master: ctx.master });
        const where = query.where ?? {};
        const limit = Math.min(parseInt(query.limit ?? "100", 10), 1000);
        const skip  = parseInt(query.skip ?? "0", 10);
        let results = await db.find("Lead", where);
        if (query.order) {
          const key = query.order.replace(/^-/, "");
          const desc = query.order.startsWith("-");
          results.sort((a: any, b: any) => desc ? (a[key] < b[key] ? 1 : -1) : (a[key] < b[key] ? -1 : 1));
        }
        results = results.slice(skip, skip + limit);
        await cloud?.runAfterFind?.("Lead", { results, user: ctx.user, master: ctx.master });
        return { results };
      },

      getLead: async (objectId: string, ctx: any) => {
        const obj = await db.read("Lead", objectId);
        if (!obj) throw ZenithErrors.notFound("Lead", objectId);
        if (!ctx.master && obj.ACL && !acl?.checkRead(obj.ACL, ctx.user)) throw ZenithErrors.forbidden();
        return obj;
      },

      createLead: async (data: Record<string, any>, ctx: any) => {
        if (!data.contactId && !data.contact) throw ZenithErrors.validationFailed("contactId es obligatorio para crear un Lead.");
        // Normalizar Pointer
        const contact = data.contact ?? { __type: "Pointer", className: "Contact", objectId: data.contactId };
        const owner   = data.owner ?? (ctx.user ? { __type: "Pointer", className: "_User", objectId: ctx.user.objectId } : undefined);
        if (!owner) throw ZenithErrors.validationFailed("owner es obligatorio en un Lead.");
        delete data.contactId; // no persistir campo auxiliar
        await cloud?.runBeforeSave?.("Lead", { object: { ...data, contact, owner }, user: ctx.user, master: ctx.master });
        const created = await db.create("Lead", {
          ...data, contact, owner,
          stage: data.stage ?? "new",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await cloud?.runAfterSave?.("Lead", { object: created, user: ctx.user, master: ctx.master });
        if (events) events.emit("CRM.leadCreated", created);
        return created;
      },

      updateLead: async (objectId: string, data: Record<string, any>, ctx: any) => {
        const existing = await db.read("Lead", objectId);
        if (!existing) throw ZenithErrors.notFound("Lead", objectId);
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        await cloud?.runBeforeSave?.("Lead", { object: { ...existing, ...data }, original: existing, user: ctx.user, master: ctx.master });
        const updated = await db.update("Lead", { objectId }, { ...data, updatedAt: new Date().toISOString() });
        await cloud?.runAfterSave?.("Lead", { object: updated, original: existing, user: ctx.user, master: ctx.master });
        if (events) events.emit("CRM.leadUpdated", updated);
        return updated;
      },

      deleteLead: async (objectId: string, ctx: any) => {
        const existing = await db.read("Lead", objectId);
        if (!existing) throw ZenithErrors.notFound("Lead", objectId);
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        await cloud?.runBeforeDelete?.("Lead", { object: existing, user: ctx.user, master: ctx.master });
        await db.delete("Lead", { objectId });
        await cloud?.runAfterDelete?.("Lead", { object: existing, user: ctx.user, master: ctx.master });
        if (events) events.emit("CRM.leadDeleted", { objectId });
        return { success: true };
      },

      // ── Deal ─────────────────────────────────────────────────────────────────

      listDeals: async (query: Record<string, any>, ctx: any) => {
        const where = query.where ?? {};
        const limit = Math.min(parseInt(query.limit ?? "100", 10), 1000);
        const skip  = parseInt(query.skip ?? "0", 10);
        let results = await db.find("Deal", where);
        if (query.order) {
          const key = query.order.replace(/^-/, "");
          const desc = query.order.startsWith("-");
          results.sort((a: any, b: any) => desc ? (a[key] < b[key] ? 1 : -1) : (a[key] < b[key] ? -1 : 1));
        }
        results = results.slice(skip, skip + limit);
        return { results };
      },

      getDeal: async (objectId: string, ctx: any) => {
        const obj = await db.read("Deal", objectId);
        if (!obj) throw ZenithErrors.notFound("Deal", objectId);
        return obj;
      },

      createDeal: async (data: Record<string, any>, ctx: any) => {
        if (!data.title || !data.stage) throw ZenithErrors.validationFailed("title y stage son obligatorios para crear un Deal.");
        const owner = data.owner ?? (ctx.user ? { __type: "Pointer", className: "_User", objectId: ctx.user.objectId } : undefined);
        if (!owner) throw ZenithErrors.validationFailed("owner es obligatorio en un Deal.");
        await cloud?.runBeforeSave?.("Deal", { object: { ...data, owner }, user: ctx.user, master: ctx.master });
        const created = await db.create("Deal", { ...data, owner, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        await cloud?.runAfterSave?.("Deal", { object: created, user: ctx.user, master: ctx.master });
        if (events) events.emit("CRM.dealCreated", created);
        return created;
      },

      updateDeal: async (objectId: string, data: Record<string, any>, ctx: any) => {
        const existing = await db.read("Deal", objectId);
        if (!existing) throw ZenithErrors.notFound("Deal", objectId);
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        const updated = await db.update("Deal", { objectId }, { ...data, updatedAt: new Date().toISOString() });
        if (events) events.emit("CRM.dealUpdated", { objectId, changes: data });
        return updated;
      },

      deleteDeal: async (objectId: string, ctx: any) => {
        const existing = await db.read("Deal", objectId);
        if (!existing) throw ZenithErrors.notFound("Deal", objectId);
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        await db.delete("Deal", { objectId });
        if (events) events.emit("CRM.dealDeleted", { objectId });
        return { success: true };
      },
    };

    // ─── 5. Rutas HTTP (thin wrappers sobre traitApi) ──────────────────────────
    //   Descubiertas automáticamente por buildDynamicRouter ya que la key
    //   termina en "_routes" y es un Array con { method, path, handler }.

    const crm_routes = [

      // ── Contacts ────────────────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/crm/contacts",
        _openapi: {
          summary: "Listar Contactos CRM",
          description: "Retorna todos los contactos. Soporta: limit, skip, order, where (JSON), count=1.",
          tags: ["CRM"],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
            { name: "skip",  in: "query", schema: { type: "integer", default: 0 } },
            { name: "order", in: "query", schema: { type: "string"  } },
            { name: "where", in: "query", schema: { type: "string", description: "JSON de filtros" } },
            { name: "count", in: "query", schema: { type: "string", enum: ["1"] } },
          ],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const result = await traitApi.listContacts(parseQueryParams(new URL(req.url)), ctx);
            return jsonResponse(result);
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "GET" as const,
        path: "/zen/crm/contacts/:objectId",
        _openapi: {
          summary: "Obtener Contacto por ID",
          tags: ["CRM"],
          parameters: [{ name: "objectId", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/contacts/:objectId", req.url);
            if (!params?.objectId) return errorResponse(ZenithErrors.invalidRequest("objectId requerido."));
            const result = await traitApi.getContact(params.objectId, ctx);
            return jsonResponse(result);
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/crm/contacts",
        _openapi: {
          summary: "Crear Contacto CRM",
          description: "Crea un contacto. Requiere: name, email.",
          tags: ["CRM"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "email"], properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" } } } } } },
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const body = await req.json();
            const created = await traitApi.createContact(body, ctx);
            return jsonResponse(created, 201);
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "PUT" as const,
        path: "/zen/crm/contacts/:objectId",
        _openapi: {
          summary: "Actualizar Contacto CRM",
          tags: ["CRM"],
          parameters: [{ name: "objectId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/contacts/:objectId", req.url);
            if (!params?.objectId) return errorResponse(ZenithErrors.invalidRequest("objectId requerido."));
            const body = await req.json();
            const updated = await traitApi.updateContact(params.objectId, body, ctx);
            return jsonResponse(updated);
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "DELETE" as const,
        path: "/zen/crm/contacts/:objectId",
        _openapi: {
          summary: "Eliminar Contacto CRM",
          tags: ["CRM"],
          parameters: [{ name: "objectId", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/contacts/:objectId", req.url);
            if (!params?.objectId) return errorResponse(ZenithErrors.invalidRequest("objectId requerido."));
            await traitApi.deleteContact(params.objectId, ctx);
            return new Response(null, { status: 204 });
          } catch (e) { return errorResponse(e); }
        },
      },

      // ── Leads ────────────────────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/crm/leads",
        _openapi: { summary: "Listar Leads CRM", tags: ["CRM"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(await traitApi.listLeads(parseQueryParams(new URL(req.url)), ctx));
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "GET" as const,
        path: "/zen/crm/leads/:objectId",
        _openapi: { summary: "Obtener Lead por ID", tags: ["CRM"], parameters: [{ name: "objectId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/leads/:objectId", req.url);
            return jsonResponse(await traitApi.getLead(params!.objectId, ctx));
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/crm/leads",
        _openapi: {
          summary: "Crear Lead CRM",
          description: "Requiere: contactId, owner (o sesión activa).",
          tags: ["CRM"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["contactId"], properties: { contactId: { type: "string" }, value: { type: "number" }, stage: { type: "string" } } } } } },
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const body = await req.json();
            return jsonResponse(await traitApi.createLead(body, ctx), 201);
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "PUT" as const,
        path: "/zen/crm/leads/:objectId",
        _openapi: { summary: "Actualizar Lead CRM", tags: ["CRM"], parameters: [{ name: "objectId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/leads/:objectId", req.url);
            const body = await req.json();
            return jsonResponse(await traitApi.updateLead(params!.objectId, body, ctx));
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "DELETE" as const,
        path: "/zen/crm/leads/:objectId",
        _openapi: { summary: "Eliminar Lead CRM", tags: ["CRM"], parameters: [{ name: "objectId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/leads/:objectId", req.url);
            await traitApi.deleteLead(params!.objectId, ctx);
            return new Response(null, { status: 204 });
          } catch (e) { return errorResponse(e); }
        },
      },

      // ── Lead Actions ─────────────────────────────────────────────────────────

      {
        method: "POST" as const,
        path: "/zen/crm/leads/:leadId/qualify",
        _openapi: { summary: "Calificar Lead (Lead Scoring)", tags: ["CRM"], parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/leads/:leadId/qualify", req.url);
            const result = await cloud?.run?.("crm_qualifyLead", { leadId: params!.leadId }, { master: ctx.master, user: ctx.user });
            return jsonResponse(result);
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/crm/leads/:leadId/convert",
        _openapi: {
          summary: "Convertir Lead a Deal",
          description: "Convierte un Lead cualificado en un Deal. El Lead pasa a stage 'won'.",
          tags: ["CRM"],
          parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { dealTitle: { type: "string" }, amount: { type: "number" }, pipeline: { type: "string" } } } } } },
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/leads/:leadId/convert", req.url);
            const body = await req.json();
            const result = await cloud?.run?.("crm_convertLeadToDeal", { leadId: params!.leadId, ...body }, { master: true, user: ctx.user });
            return jsonResponse(result);
          } catch (e) { return errorResponse(e); }
        },
      },

      // ── Deals ────────────────────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/crm/deals",
        _openapi: { summary: "Listar Deals CRM", tags: ["CRM"] },
        handler: async (req: Request, ctx: any) => {
          try { return jsonResponse(await traitApi.listDeals(parseQueryParams(new URL(req.url)), ctx)); }
          catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "GET" as const,
        path: "/zen/crm/deals/:objectId",
        _openapi: { summary: "Obtener Deal por ID", tags: ["CRM"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/deals/:objectId", req.url);
            return jsonResponse(await traitApi.getDeal(params!.objectId, ctx));
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/crm/deals",
        _openapi: { summary: "Crear Deal CRM", tags: ["CRM"], requestBody: { content: { "application/json": { schema: { type: "object", required: ["title", "stage"], properties: { title: { type: "string" }, stage: { type: "string" }, amount: { type: "number" } } } } } } },
        handler: async (req: Request, ctx: any) => {
          try { return jsonResponse(await traitApi.createDeal(await req.json(), ctx), 201); }
          catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "PUT" as const,
        path: "/zen/crm/deals/:objectId",
        _openapi: { summary: "Actualizar Deal CRM", tags: ["CRM"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/deals/:objectId", req.url);
            return jsonResponse(await traitApi.updateDeal(params!.objectId, await req.json(), ctx));
          } catch (e) { return errorResponse(e); }
        },
      },

      {
        method: "DELETE" as const,
        path: "/zen/crm/deals/:objectId",
        _openapi: { summary: "Eliminar Deal CRM", tags: ["CRM"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const params = matchPath("/zen/crm/deals/:objectId", req.url);
            await traitApi.deleteDeal(params!.objectId, ctx);
            return new Response(null, { status: 204 });
          } catch (e) { return errorResponse(e); }
        },
      },

      // ── Pipeline Analytics ───────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/crm/pipeline/summary",
        _openapi: { summary: "Resumen del Pipeline (Kanban)", description: "Retorna deals agrupados por stage con totales financieros.", tags: ["CRM"] },
        handler: async (_req: Request, ctx: any) => {
          try {
            const result = await cloud?.run?.("crm_pipelineSummary", {}, { master: ctx.master, user: ctx.user });
            return jsonResponse(result);
          } catch (e) { return errorResponse(e); }
        },
      },
    ];

    return {
      "crm_routes": crm_routes,
      "crm":        traitApi,
    };
  },
});
