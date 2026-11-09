// deno-lint-ignore-file no-unused-vars
/**
 * Google ADK Agents Trait — Agentes AI para CRM, Marketing, Segmentación.
 *
 * Patrón adaptador: el núcleo registra agentes CRM/Marketing preconstruidos.
 * Proyectos externos pueden agregar sus propios agentes vía `registerAgent`.
 * Soporta: Google ADK, OpenAI Assistants, Anthropic Agents, Ollama local.
 *
 * Agentes preconstruidos:
 *   - crm_assistant     : Consultas, resúmenes y acciones sobre CRM data
 *   - lead_scorer       : Califica leads con AI basada en historial
 *   - marketing_writer  : Genera emails, posts, campañas desde contexto CRM
 *   - segment_analyzer  : Segmenta usuarios por comportamiento (VectorDB RAG)
 *   - support_agent     : Responde tickets usando base de conocimiento del foro
 *
 * @barrits-trait
 * @barrits-summary ZenithADKAgents
 * @barrits-provides adk_routes, adkAgents
 * @barrits-consumes db
 * @barrits-tags uses:ai, uses:events, uses:vectordb
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { jsonRes, errRes, pathParams, ptr, now } from "../../core/trait-utils.ts";

/** Definición de un Agente ADK */
export interface ADKAgentDef {
  id:           string;
  name:         string;
  description:  string;
  systemPrompt: string;
  tools:        ADKTool[];
  model:        string;
  provider:     "google-adk" | "openai" | "anthropic" | "gemini" | "ollama" | "custom";
  temperature?: number;
  maxTokens?:   number;
  isBuiltin:    boolean;
}

export interface ADKTool {
  name:        string;
  description: string;
  parameters:  Record<string, { type: string; description: string; required?: boolean }>;
  handler:     (params: any, ctx: any) => Promise<any>;
}

export interface ADKSession {
  sessionId: string;
  agentId:   string;
  messages:  Array<{ role: string; content: string; timestamp: string }>;
  createdAt: string;
  updatedAt: string;
}

/** Registro global de agentes y sesiones (en memoria, sincronizado con DB) */
const AGENT_REGISTRY = new Map<string, ADKAgentDef>();
const TOOL_REGISTRY  = new Map<string, ADKTool>();

export const ADKAgentsTrait = createTraitDescriptor({
  name: "ZenithADKAgents",
  provides: ["adk_routes", "adkAgents"],
  consumes: ["db"],
  tags: ["uses:ai", "uses:events", "uses:vectordb"],
  state: [],
  runtimes: ["deno"],

  summary: "Google ADK-compatible AI Agents: CRM Assistant, Lead Scorer, Marketing Writer, Segment Analyzer, Support Agent. Adapter pattern for custom agents.",

  create: (deps: Record<string, any>) => {
    const ai       = deps.traits["ai"];
    const vectordb = deps.traits["vectordb"];
    const db       = deps.traits["db"];
    const events   = deps.traits["events"];

    // ─── Herramientas CRM compartidas ─────────────────────────────────────────

    const crmTools: ADKTool[] = [
      {
        name: "search_contacts",
        description: "Busca contactos CRM por nombre, email o empresa.",
        parameters: { q: { type: "string", description: "Término de búsqueda", required: true } },
        handler: async ({ q }: any) => db.find("Contact", {}).then((r: any[]) => r.filter(c => JSON.stringify(c).toLowerCase().includes(q.toLowerCase())).slice(0, 5)),
      },
      {
        name: "get_deal_pipeline",
        description: "Obtiene el resumen del pipeline de deals por stage.",
        parameters: {},
        handler: async () => {
          const deals = await db.find("Deal", {});
          const stages: Record<string, any> = {};
          for (const d of deals) {
            if (!stages[d.stage]) stages[d.stage] = { count: 0, total: 0 };
            stages[d.stage].count++;
            stages[d.stage].total += d.amount ?? 0;
          }
          return stages;
        },
      },
      {
        name: "create_task",
        description: "Crea una tarea asignada a un record del CRM.",
        parameters: {
          title:           { type: "string",  description: "Título de la tarea",                required: true },
          targetClassName: { type: "string",  description: "Clase del record (Contact/Deal/...)", required: true },
          targetId:        { type: "string",  description: "objectId del record",                required: true },
          dueAt:           { type: "string",  description: "Fecha límite ISO 8601" },
          priority:        { type: "string",  description: "low|medium|high|urgent" },
        },
        handler: async ({ title, targetClassName, targetId, dueAt, priority }: any, ctx: any) =>
          db.create("Task", { title, targetClassName, targetId, dueAt, priority: priority ?? "medium", status: "todo", createdAt: now(), updatedAt: now() }),
      },
      {
        name: "send_notification",
        description: "Envía una notificación in-app a un usuario.",
        parameters: {
          userId:  { type: "string", description: "objectId del usuario", required: true },
          message: { type: "string", description: "Cuerpo del mensaje",   required: true },
          type:    { type: "string", description: "info|warning|success|error" },
        },
        handler: async ({ userId, message, type }: any) => {
          if (events) events.emit("Notification.create", { userId, message, type: type ?? "info", source: "agent" });
          return { sent: true };
        },
      },
      {
        name: "segment_users",
        description: "Segmenta usuarios por criterios (score, stage, tags) usando VectorDB si está disponible.",
        parameters: {
          criteria: { type: "string", description: "Descripción en lenguaje natural de la segmentación", required: true },
        },
        handler: async ({ criteria }: any) => {
          if (vectordb) {
            return vectordb.search("crm_insights", criteria, { topK: 20 }).catch(() => ({ results: [] }));
          }
          const contacts = await db.find("Contact", {});
          return { results: contacts.slice(0, 10), note: "VectorDB no configurado, retornando sample." };
        },
      },
    ];

    // ─── Registrar herramientas compartidas ───────────────────────────────────

    for (const tool of crmTools) TOOL_REGISTRY.set(tool.name, tool);

    // ─── Agentes preconstruidos ───────────────────────────────────────────────

    const BUILTIN_AGENTS: ADKAgentDef[] = [
      {
        id: "crm_assistant", name: "CRM Assistant", isBuiltin: true,
        provider: "gemini", model: "gemini-2.0-flash",
        description: "Asistente conversacional para consultar y actuar sobre datos CRM.",
        systemPrompt: `Eres el asistente CRM de Zenith. Ayudas al equipo de ventas a consultar contactos, deals y leads.
Puedes crear tareas, buscar contactos y revisar el pipeline.
Sé conciso, profesional y orientado a acciones concretas.
Siempre confirma antes de crear o modificar datos.`,
        tools: crmTools.map(t => t.name as any),
        temperature: 0.3,
      },
      {
        id: "lead_scorer", name: "Lead Scorer AI", isBuiltin: true,
        provider: "gemini", model: "gemini-2.0-flash",
        description: "Analiza leads y propone un score de calificación con justificación.",
        systemPrompt: `Eres un especialista en calificación de leads B2B.
Analiza el historial de actividades, valor del deal, stage actual e industria para generar un score 0-100.
Justifica cada puntuación con datos específicos. Recomienda las siguientes acciones concretas.`,
        tools: ["search_contacts", "get_deal_pipeline"],
        temperature: 0.1,
      },
      {
        id: "marketing_writer", name: "Marketing Writer", isBuiltin: true,
        provider: "gemini", model: "gemini-2.0-flash",
        description: "Genera emails, posts de blog, campañas y contenido marketing desde contexto CRM.",
        systemPrompt: `Eres un redactor de marketing B2B especializado en contenido personalizado.
Usa los datos del CRM para personalizar mensajes. Escribe en español a menos que se especifique otro idioma.
Mantén un tono profesional pero cercano. Incluye CTAs claros y medibles.`,
        tools: ["search_contacts", "segment_users"],
        temperature: 0.7,
      },
      {
        id: "segment_analyzer", name: "Segment Analyzer", isBuiltin: true,
        provider: "gemini", model: "gemini-2.0-flash",
        description: "Segmenta la base de usuarios/contactos por comportamiento usando VectorDB RAG.",
        systemPrompt: `Eres un analista de datos especializado en segmentación de clientes.
Usa búsqueda semántica sobre el historial de interacciones para identificar patrones.
Propón segmentos accionables con nombres descriptivos y criterios claros de membresía.`,
        tools: ["segment_users", "search_contacts"],
        temperature: 0.2,
      },
      {
        id: "support_agent", name: "Support Agent", isBuiltin: true,
        provider: "gemini", model: "gemini-2.0-flash",
        description: "Responde tickets de soporte usando la base de conocimiento del foro y notas CRM.",
        systemPrompt: `Eres un agente de soporte al cliente de nivel 1 para Zenith.
Busca en la base de conocimiento (foro, notas, documentación) antes de responder.
Si no tienes la respuesta, escala al equipo humano. Sé empático y claro.`,
        tools: ["search_contacts", "send_notification"],
        temperature: 0.4,
      },
    ];

    for (const agent of BUILTIN_AGENTS) AGENT_REGISTRY.set(agent.id, agent);

    // ─── ReAct Loop (Reasoning + Acting) ────────────────────────────────────

    async function executeAgent(agentId: string, input: string, ctx: any, sessionId?: string): Promise<any> {
      const agent = AGENT_REGISTRY.get(agentId);
      if (!agent) throw ZenithErrors.notFound("ADKAgent", agentId);

      if (!ai) {
        return { agentId, finalAnswer: `[AI no configurado] Input recibido: ${input}`, iterations: [], durationMs: 0 };
      }

      const start    = Date.now();
      const messages = [
        { role: "system",  content: agent.systemPrompt },
        { role: "user",    content: input },
      ];
      const iterations: any[] = [];
      let finalAnswer = "";

      for (let i = 0; i < 8; i++) {
        const response = await ai.chat?.(agent.model, messages, {
          temperature: agent.temperature ?? 0.5,
          maxTokens:   agent.maxTokens ?? 1024,
        }).catch(() => ({ content: [{ type: "text", text: input }] }));

        const text    = response?.content?.[0]?.text ?? response?.choices?.[0]?.message?.content ?? "";
        const toolUse = response?.content?.find?.((c: any) => c.type === "tool_use");

        iterations.push({ thought: text, action: toolUse ? { tool: toolUse.name, input: toolUse.input } : undefined });

        if (!toolUse) { finalAnswer = text; break; }

        const tool = TOOL_REGISTRY.get(toolUse.name);
        const observation = tool ? await tool.handler(toolUse.input ?? {}, ctx).catch(e => ({ error: e.message }))
                                 : { error: `Tool '${toolUse.name}' no encontrada.` };

        iterations[iterations.length - 1].observation = observation;
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user",      content: `Tool result: ${JSON.stringify(observation)}` });
      }

      const result = { agentId, sessionId, finalAnswer, iterations, durationMs: Date.now() - start };

      // Persistir sesión en DB
      if (sessionId) {
        await db.update("ADKSession", { objectId: sessionId }, {
          messages: [...(messages), { role: "assistant", content: finalAnswer, timestamp: now() }],
          updatedAt: now(),
        }).catch(() => {});
      }

      if (events) events.emit("ADK.agentCompleted", result);
      return result;
    }

    const api = {
      listAgents: () => ({ agents: Array.from(AGENT_REGISTRY.values()).map(({ tools: _, ...a }) => a) }),
      getAgent:   (id: string) => { const a = AGENT_REGISTRY.get(id); if (!a) throw ZenithErrors.notFound("ADKAgent", id); return a; },
      registerAgent: (agent: ADKAgentDef) => { AGENT_REGISTRY.set(agent.id, agent); return agent; },
      registerTool:  (tool: ADKTool)      => { TOOL_REGISTRY.set(tool.name, tool); return tool; },
      run: executeAgent,

      async createSession(agentId: string, ctx: any) {
        return db.create("ADKSession", {
          agentId, messages: [],
          userId: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(), updatedAt: now(),
        });
      },
    };

    const adk_routes = [
      { method: "GET"  as const, path: "/zen/agents",                         _openapi: { summary: "Listar Agentes ADK disponibles",         tags: ["Agents"] }, handler: (_req: Request, _ctx: any) => jsonRes(api.listAgents()) },
      { method: "GET"  as const, path: "/zen/agents/:agentId",                _openapi: { summary: "Obtener definición de un Agente",        tags: ["Agents"] }, handler: (req: Request, _ctx: any) => { try { const p = pathParams("/zen/agents/:agentId", req.url)!; return jsonRes(api.getAgent(p.agentId)); } catch(e) { return errRes(e); } } },
      { method: "POST" as const, path: "/zen/agents/:agentId/run",            _openapi: { summary: "Ejecutar Agente con un input",           tags: ["Agents"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/agents/:agentId/run", req.url)!; const b = await req.json(); return jsonRes(await api.run(p.agentId, b.input, ctx, b.sessionId)); } catch(e) { return errRes(e); } } },
      { method: "POST" as const, path: "/zen/agents/:agentId/sessions",       _openapi: { summary: "Crear sesión de conversación con Agente", tags: ["Agents"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/agents/:agentId/sessions", req.url)!; return jsonRes(await api.createSession(p.agentId, ctx), 201); } catch(e) { return errRes(e); } } },
    ];

    return { adk_routes, adkAgents: api };
  },
});
