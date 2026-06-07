/**
 * @plugin @zenith/crm-core (Open Source)
 *
 * CRM Core Plugin para Zenith Universal Business Backend.
 * Instala: Contacts, Leads, Deals, Pipeline, Activities, Campaigns.
 *
 * Uso:
 *   import { installCRMPlugin } from "./plugins/crm.plugin.ts";
 *   installCRMPlugin(Zen);
 */
import { ZenithErrors } from "../core/errors.ts";

export function installCRMPlugin(Zen: any) {
  console.log("[CRM Plugin] 💼 Installing CRM Core plugin...");

  // ─── 1. Schemas ────────────────────────────────────────────────────────

  Zen.Cloud.defineSchema?.("Contact", {
    name:    { type: "String", required: true },
    email:   { type: "String", required: true },
    phone:   { type: "String" },
    company: { type: "String" },
    title:   { type: "String" },
    tags:    { type: "Array",  defaultValue: [] },
    source:  { type: "String", defaultValue: "manual" }, // manual|web|import|referral|campaign
    score:   { type: "Number", defaultValue: 0 },
    notes:   { type: "String" },
  });

  Zen.Cloud.defineSchema?.("Lead", {
    contact:    { type: "Pointer", targetClass: "Contact", required: true },
    owner:      { type: "Pointer", targetClass: "_User",   required: true },
    stage:      { type: "String",  defaultValue: "new" }, // new|contacted|qualified|proposal|negotiation|won|lost
    value:      { type: "Number",  defaultValue: 0 },
    currency:   { type: "String",  defaultValue: "USD" },
    probability:{ type: "Number",  defaultValue: 10 }, // 0-100%
    closeDate:  { type: "Date" },
    lostReason: { type: "String" },
  });

  Zen.Cloud.defineSchema?.("Deal", {
    title:     { type: "String",  required: true },
    contacts:  { type: "Array" },                           // [Pointer<Contact>]
    owner:     { type: "Pointer", targetClass: "_User",    required: true },
    pipeline:  { type: "String",  defaultValue: "default" },
    stage:     { type: "String",  required: true },
    amount:    { type: "Number",  defaultValue: 0 },
    currency:  { type: "String",  defaultValue: "USD" },
    closeDate: { type: "Date" },
    wonAt:     { type: "Date" },
    lostAt:    { type: "Date" },
  });

  Zen.Cloud.defineSchema?.("Activity", {
    type:        { type: "String", required: true }, // call|email|meeting|task|note
    contact:     { type: "Pointer", targetClass: "Contact" },
    lead:        { type: "Pointer", targetClass: "Lead" },
    deal:        { type: "Pointer", targetClass: "Deal" },
    owner:       { type: "Pointer", targetClass: "_User", required: true },
    dueAt:       { type: "Date" },
    completedAt: { type: "Date" },
    notes:       { type: "String", defaultValue: "" },
    outcome:     { type: "String" }, // completed|no_answer|deal_won|deal_lost
  });

  Zen.Cloud.defineSchema?.("Pipeline", {
    name:      { type: "String", required: true },
    stages:    { type: "Array" }, // [{name, probability, order}]
    isDefault: { type: "Boolean", defaultValue: false },
  });

  Zen.Cloud.defineSchema?.("Campaign", {
    name:      { type: "String", required: true },
    type:      { type: "String", defaultValue: "email" }, // email|sms|push|social
    status:    { type: "String", defaultValue: "draft" }, // draft|active|paused|completed
    audience:  { type: "Array", defaultValue: [] },        // [contactId]
    startDate: { type: "Date" },
    endDate:   { type: "Date" },
    metrics:   { type: "Object", defaultValue: { sent: 0, opened: 0, clicked: 0, converted: 0 } },
  });

  // ─── 2. Cloud Functions ────────────────────────────────────────────────

  /**
   * Califica un Lead basado en actividades, valor y etapa actual.
   * Fórmula: (activityScore * 0.4) + (valueScore * 0.4) + (stageScore * 0.2)
   */
  Zen.Cloud.define("crm_qualifyLead", async (request: any) => {
    const { leadId } = request.params;
    const lead = await Zen.DB.findOne("Lead", { where: { objectId: leadId } });
    if (!lead) throw ZenithErrors.notFound(`Lead ${leadId} not found.`);

    // Score por actividades en los últimos 30 días
    const activities = await Zen.DB.find("Activity", {
      where: { "lead.objectId": leadId },
      order: "-createdAt",
      limit: 20,
    });
    const activityScore = Math.min(activities.length * 10, 100);

    // Score por valor del deal (normalizado a 100K USD = 100 puntos)
    const valueScore = Math.min((lead.value / 100_000) * 100, 100);

    // Score por etapa
    const stageScores: Record<string, number> = {
      new: 10, contacted: 25, qualified: 50, proposal: 70, negotiation: 85, won: 100, lost: 0
    };
    const stageScore = stageScores[lead.stage] ?? 0;

    const finalScore = Math.round(activityScore * 0.4 + valueScore * 0.4 + stageScore * 0.2);

    await Zen.DB.update("Lead", leadId, { score: finalScore, updatedAt: new Date().toISOString() });

    // Actualizar también el Contact score
    if (lead.contact?.objectId) {
      await Zen.DB.update("Contact", lead.contact.objectId, {
        score: finalScore, updatedAt: new Date().toISOString()
      });
    }

    return { leadId, score: finalScore, breakdown: { activityScore, valueScore, stageScore } };
  });

  /**
   * Convierte un Lead calificado en un Deal.
   */
  Zen.Cloud.define("crm_convertLeadToDeal", async (request: any) => {
    const { leadId, dealTitle, amount, pipeline, stage, closeDate } = request.params;
    const lead = await Zen.DB.findOne("Lead", { where: { objectId: leadId } });
    if (!lead) throw ZenithErrors.notFound(`Lead ${leadId} not found.`);
    if (lead.stage === "won" || lead.stage === "lost") {
      throw ZenithErrors.invalidRequest(`Lead ${leadId} is already ${lead.stage}.`);
    }

    const deal = await Zen.DB.insert("Deal", {
      title:     dealTitle ?? `Deal from Lead ${leadId}`,
      contacts:  lead.contact ? [lead.contact] : [],
      owner:     lead.owner,
      pipeline:  pipeline ?? "default",
      stage:     stage ?? "proposal",
      amount:    amount ?? lead.value,
      currency:  lead.currency ?? "USD",
      closeDate: closeDate ?? lead.closeDate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await Zen.DB.update("Lead", leadId, {
      stage: "qualified",
      updatedAt: new Date().toISOString(),
    });

    return { deal, leadUpdated: true };
  });

  /**
   * Resumen del pipeline: deals agrupados por stage con totales.
   */
  Zen.Cloud.define("crm_pipelineSummary", async (request: any) => {
    const { pipelineId } = request.params;
    const where: any = {};
    if (pipelineId) where.pipeline = pipelineId;

    const deals = await Zen.DB.find("Deal", { where });
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

  /**
   * Reporte de actividades por tipo y resultado.
   */
  Zen.Cloud.define("crm_activityReport", async (request: any) => {
    const { ownerId, from, to } = request.params;
    const where: any = {};
    if (ownerId) where["owner.objectId"] = ownerId;
    if (from) where.createdAt = { $gte: from };
    if (to) where.createdAt = { ...(where.createdAt ?? {}), $lte: to };

    const activities = await Zen.DB.find("Activity", { where });
    const byType: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};

    for (const a of activities) {
      byType[a.type] = (byType[a.type] ?? 0) + 1;
      if (a.outcome) byOutcome[a.outcome] = (byOutcome[a.outcome] ?? 0) + 1;
    }

    return { total: activities.length, byType, byOutcome };
  });

  /**
   * Contactos sin actividad en los últimos 30 días (en riesgo de churn).
   */
  Zen.Cloud.define("crm_contactsAtRisk", async (_request: any) => {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const contacts = await Zen.DB.find("Contact", { where: {} });

    const atRisk = [];
    for (const contact of contacts) {
      const recent = await Zen.DB.find("Activity", {
        where: {
          "contact.objectId": contact.objectId,
          createdAt: { $gte: cutoff },
        },
        limit: 1,
      });
      if (recent.length === 0) atRisk.push({ objectId: contact.objectId, name: contact.name, email: contact.email, score: contact.score, lastActivity: contact.updatedAt });
    }

    return { atRisk, count: atRisk.length };
  });

  // ─── 3. Triggers ──────────────────────────────────────────────────────

  /** Normalizar email a lowercase antes de guardar */
  Zen.Cloud.beforeSave("Contact", async (request: any) => {
    const obj = request.object;
    if (obj.email) obj.email = String(obj.email).toLowerCase().trim();
  });

  /** Crear Activity automática cuando un Lead se gana */
  Zen.Cloud.afterSave("Lead", async (request: any) => {
    const obj      = request.object;
    const original = request.original;

    if (obj.stage === "won" && original?.stage !== "won") {
      await Zen.DB.insert("Activity", {
        type:        "note",
        lead:        { __type: "Pointer", className: "Lead", objectId: obj.objectId },
        contact:     obj.contact,
        owner:       obj.owner,
        completedAt: new Date().toISOString(),
        notes:       `🎉 Lead marked as WON. Value: ${obj.value} ${obj.currency}`,
        outcome:     "deal_won",
        createdAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
      });
    }
  });

  // Crear Pipeline por defecto si no existe
  (async () => {
    try {
      const existing = await Zen.DB.findOne?.("Pipeline", { where: { isDefault: true } });
      if (!existing) {
        await Zen.DB.insert("Pipeline", {
          name: "Sales Pipeline",
          isDefault: true,
          stages: [
            { name: "New",         probability: 10,  order: 1 },
            { name: "Contacted",   probability: 25,  order: 2 },
            { name: "Qualified",   probability: 50,  order: 3 },
            { name: "Proposal",    probability: 70,  order: 4 },
            { name: "Negotiation", probability: 85,  order: 5 },
            { name: "Won",         probability: 100, order: 6 },
            { name: "Lost",        probability: 0,   order: 7 },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        console.log("[CRM Plugin] ✅ Default Sales Pipeline created.");
      }
    } catch (_e) { /* noop: plugin init isolation */ }
  })();

  console.log("[CRM Plugin] ✅ CRM Core installed: 6 schemas, 5 functions, 2 triggers.");
}
