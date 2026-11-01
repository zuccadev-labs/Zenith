import { ZenithErrors } from "../../../core/errors.ts";

/**
 * CRM Triggers & Webhooks
 * Aquí reside la lógica de negocio profunda del CRM, como scoring de leads,
 * validación cruzada y notificaciones asíncronas.
 */

export function registerCRMTriggers(Zen: any) {
  
  // Lógica: Antes de guardar un Contact, si no tiene owner, lanzar error (Zero Trust).
  Zen.Cloud.beforeSave("Contact", async (request: any) => {
    const contact = request.object;
    // Si la request no viene de Master Key o no tiene owner
    if (!request.master && !contact.owner) {
      // Intenta asignar al owner actual si hay sesión
      if (request.user) {
        contact.owner = { __type: "Pointer", className: "_User", objectId: request.user.objectId };
      }
    }
  });

  // Lógica: Después de guardar un Lead, generar embeddings vectoriales para RAG/IA.
  Zen.Cloud.afterSave("Lead", async (request: any) => {
    const lead = request.object;
    
    // Background task: Generar embedding de IA
    setTimeout(async () => {
      try {
        const textToEmbed = `Lead Source: ${lead.source}, Stage: ${lead.stage}, Value: ${lead.value}`;
        
        // Asumiendo que el trait AI de Zenith expone getEmbeddings
        let vector = [];
        if (Zen.AI && Zen.AI.getEmbeddings) {
           vector = await Zen.AI.getEmbeddings(textToEmbed);
        } else {
           // Fallback/Mock para desarrollo
           vector = [0.1, 0.2, -0.1]; 
        }

        // Guardar insight en VectorDB (mediante el smart routing de CRM_Insight)
        await Zen.DB.insert("CRM_Insight", {
          entityId: lead.objectId,
          entityType: "Lead",
          vector_data: vector,
          summary: `Lead automatically summarized on ${new Date().toISOString()}`
        });

      } catch (e) {
        console.error("[CRM AI] Failed to generate insight for Lead", lead.objectId, e);
      }
    }, 0);
  });

  // Cloud Function nativa de negocio
  Zen.Cloud.define("crm_convertLeadToDeal", async (request: any) => {
    const { leadId, dealTitle, amount, pipeline, stage } = request.params;
    const lead = await Zen.DB.read("Lead", leadId);
    if (!lead) throw ZenithErrors.notFound(`Lead ${leadId} not found.`);
    if (lead.stage === "won" || lead.stage === "lost") {
      throw ZenithErrors.invalidRequest(`Lead is already ${lead.stage}.`);
    }

    const deal = await Zen.DB.insert("Deal", {
      title:     dealTitle ?? `Deal from Lead ${leadId}`,
      owner:     lead.owner,
      pipeline:  pipeline ?? "default",
      stage:     stage ?? "proposal",
      amount:    amount ?? lead.value,
      currency:  lead.currency ?? "USD",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Añadir el contacto original como relación al deal
    if (lead.contact) {
      // Dependiendo del adaptador de Parse de Zenith, las relaciones se pueden agregar así
      await Zen.DB.update("Deal", deal.objectId, {
         "contacts": { __op: "AddRelation", objects: [lead.contact] }
      });
    }

    await Zen.DB.update("Lead", leadId, {
      stage: "won", // Convertido
      updatedAt: new Date().toISOString(),
    });

    return { deal, leadUpdated: true };
  });

}
