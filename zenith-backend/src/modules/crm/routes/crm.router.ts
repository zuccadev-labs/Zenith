import { ZenithErrors } from "../../../core/errors.ts";

/**
 * Enterprise CRM Router
 * Expone endpoints RESTful nativos (/zen/crm/*) que mapean a la lógica subyacente de Zenith.
 * Enrutamiento inteligente y desacoplado de Parse, usando la API nativa HTTP.
 */
export function createCRMRouter(Zen: any) {
  const routes = [
    {
      method: "POST",
      path: "/zen/crm/contacts",
      handler: async (req: Request, _ctx: any) => {
        try {
          const body = await req.json();
          // Smart Routing: Validar campos corporativos
          if (!body.email || !body.name) {
             throw ZenithErrors.invalidRequest("El nombre y correo electrónico son obligatorios para crear un contacto corporativo.");
          }
          
          // Lógica de creación (aprovechando Parse Engine de fondo)
          const contact = await Zen.DB.insert("Contact", {
             ...body,
             createdAt: new Date().toISOString(),
             updatedAt: new Date().toISOString()
          });

          // Registrar en ScyllaDB (Activity stream) de manera asíncrona
          Zen.DB.insert("Activity", {
            type: "system_creation",
            subject: `Contacto creado: ${contact.name}`,
            contact: { __type: "Pointer", className: "Contact", objectId: contact.objectId },
            date: new Date().toISOString()
          }).catch((e: Error) => console.error("[CRM] Activity Stream fail (Scylla):", e));

          return new Response(JSON.stringify(contact), { status: 201, headers: { "Content-Type": "application/json" } });
        } catch (error: any) {
          return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      }
    },
    {
      method: "GET",
      path: "/zen/crm/contacts",
      handler: async (req: Request, _ctx: any) => {
        const url = new URL(req.url);
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const contacts = await Zen.DB.find("Contact", { limit, order: "-createdAt" });
        return new Response(JSON.stringify({ results: contacts }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    },
    {
      method: "POST",
      path: "/zen/crm/leads",
      handler: async (req: Request, _ctx: any) => {
        try {
          const body = await req.json();
          if (!body.contactId) throw ZenithErrors.invalidRequest("contactId es obligatorio para un Lead.");
          
          const lead = await Zen.DB.insert("Lead", {
             ...body,
             contact: { __type: "Pointer", className: "Contact", objectId: body.contactId },
             createdAt: new Date().toISOString(),
             updatedAt: new Date().toISOString()
          });
          return new Response(JSON.stringify(lead), { status: 201, headers: { "Content-Type": "application/json" } });
        } catch (error: any) {
          return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      }
    },
    {
      method: "POST",
      path: "/zen/crm/leads/:leadId/convert",
      handler: async (req: Request, _ctx: any) => {
         try {
           const urlPattern = new URLPattern({ pathname: "/zen/crm/leads/:leadId/convert" });
           const match = urlPattern.exec(req.url);
           const leadId = match?.pathname.groups.leadId;
           const body = await req.json();

           // Llamar a la lógica de negocio modularizada que ya existe en cloud
           const result = await Zen.Cloud.run("crm_convertLeadToDeal", { leadId, ...body }, { master: true });
           
           return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
         } catch (error: any) {
           return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { "Content-Type": "application/json" } });
         }
      }
    }
  ];

  return routes;
}
