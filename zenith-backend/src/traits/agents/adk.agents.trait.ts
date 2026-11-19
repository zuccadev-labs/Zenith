// deno-lint-ignore-file no-unused-vars
/**
 * Google ADK Agents Trait — Agentes AI para CRM, Marketing, Segmentación.
 *
 * Patrón adaptador: el núcleo registra agentes CRM/Marketing preconstruidos.
 * Proyectos externos pueden agregar sus propios agentes vía `registerAgent`.
 * Soporta: Google ADK, OpenAI Assistants, Anthropic Agents, Ollama local.
 *
 * Sesiones (ADR-019): con la capacidad `cells`, cada sesión es una celda `ZenithAgentSession`
 * (binding `AGENT_SESSIONS`, nombre = `sessionId`). La celda guarda el historial en su SQLite, el
 * modelo lo recibe en cada turno y los turnos de una sesión van de uno en uno. `run(agentId, input,
 * ctx, sessionId)` usa ese camino; sin `cells`, el de antes (solo `ADKSession` en la base de datos,
 * sin historial previo). `ADKSession.messages` se sigue escribiendo como espejo de la conversación.
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
 * @barrits-tags uses:ai, uses:events, uses:vectordb, uses:cells
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { errRes, jsonRes, now, pathParams, ptr } from "../../core/trait-utils.ts";
import {
  type AgentMessage,
  type AgentRuntime,
  AgentSessionCell,
  type AgentTurnOutput,
} from "../cells/agent-cell.ts";
import type { CellsApi } from "../cells/api.ts";

/** Clase y binding de las celdas de sesión de agentes. */
export const AGENT_SESSION_CELL = { className: "ZenithAgentSession", binding: "AGENT_SESSIONS" };

/** Definition of an ADK agent, built-in or registered with `adkAgents.registerAgent()`. */
export interface ADKAgentDef {
  /** Unique id used to run the agent (`POST /zen/agents/:agentId/run`). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What the agent is for, shown when listing agents. */
  description: string;
  /** System prompt that opens every conversation with the agent. */
  systemPrompt: string;
  /** Tools the agent may call during its reasoning loop. */
  tools: ADKTool[];
  /** Model id passed to the `ai` capability's `chat()`. */
  model: string;
  /** Provider family the agent was designed for. */
  provider: "google-adk" | "openai" | "anthropic" | "gemini" | "ollama" | "custom";
  /** Sampling temperature; defaults to 0.5. */
  temperature?: number;
  /** Maximum tokens per model response; defaults to 1024. */
  maxTokens?: number;
  /** True for the agents shipped with Zenith (CRM assistant, lead scorer, etc.). */
  isBuiltin: boolean;
}

/** A tool an agent can invoke; registered globally with `adkAgents.registerTool()`. */
export interface ADKTool {
  /** Unique tool name the model refers to in a `tool_use` block. */
  name: string;
  /** What the tool does, for the model. */
  description: string;
  /** JSON-schema-like description of each input parameter. */
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  /** Runs the tool with the model-supplied input and the request context; its result is fed back to the model. */
  handler: (params: any, ctx: any) => Promise<any>;
}

/** A persisted conversation with an agent, stored in the `ADKSession` collection. */
export interface ADKSession {
  /** Unique id of the session. */
  sessionId: string;
  /** Id of the agent the session talks to. */
  agentId: string;
  /** Conversation history, oldest first. */
  messages: Array<{ role: string; content: string; timestamp: string }>;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of the last message. */
  updatedAt: string;
}

/** Registro global de agentes y sesiones (en memoria, sincronizado con DB) */
const AGENT_REGISTRY = new Map<string, ADKAgentDef>();
const TOOL_REGISTRY = new Map<string, ADKTool>();

/**
 * AI agents trait (`ZenithADKAgents`). Provides `adkAgents` (list, register and run agents and
 * tools, create sessions) and `adk_routes` (`/zen/agents...`). Agents run a ReAct loop of up to
 * 8 model calls through the `ai` capability, executing registered tools between calls. Ships
 * built-in CRM/marketing agents: `crm_assistant`, `lead_scorer`, `marketing_writer`,
 * `segment_analyzer` and `support_agent`. Consumes `db`; uses `ai`, `events` and `vectordb`
 * when present (without `ai`, runs return a placeholder answer).
 */
export const ADKAgentsTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithADKAgents",
  provides: ["adk_routes", "adkAgents"],
  consumes: ["db"],
  tags: ["uses:ai", "uses:events", "uses:vectordb", "uses:cells"],
  state: [],
  runtimes: ["deno"],

  summary:
    "Google ADK-compatible AI Agents: CRM Assistant, Lead Scorer, Marketing Writer, Segment Analyzer, Support Agent. Adapter pattern for custom agents.",

  create: (deps: Record<string, any>) => {
    const ai = deps.traits["ai"];
    const vectordb = deps.traits["vectordb"];
    const db = deps.traits["db"];
    const events = deps.traits["events"];
    const cells = deps.traits["cells"] as CellsApi | undefined;

    // ─── Herramientas CRM compartidas ─────────────────────────────────────────

    const crmTools: ADKTool[] = [
      {
        name: "search_contacts",
        description: "Busca contactos CRM por nombre, email o empresa.",
        parameters: { q: { type: "string", description: "Término de búsqueda", required: true } },
        handler: async ({ q }: any) =>
          db.find("Contact", {}).then((r: any[]) =>
            r.filter((c) => JSON.stringify(c).toLowerCase().includes(q.toLowerCase())).slice(0, 5)
          ),
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
          title: { type: "string", description: "Título de la tarea", required: true },
          targetClassName: {
            type: "string",
            description: "Clase del record (Contact/Deal/...)",
            required: true,
          },
          targetId: { type: "string", description: "objectId del record", required: true },
          dueAt: { type: "string", description: "Fecha límite ISO 8601" },
          priority: { type: "string", description: "low|medium|high|urgent" },
        },
        handler: async ({ title, targetClassName, targetId, dueAt, priority }: any, ctx: any) =>
          db.create("Task", {
            title,
            targetClassName,
            targetId,
            dueAt,
            priority: priority ?? "medium",
            status: "todo",
            createdAt: now(),
            updatedAt: now(),
          }),
      },
      {
        name: "send_notification",
        description: "Envía una notificación in-app a un usuario.",
        parameters: {
          userId: { type: "string", description: "objectId del usuario", required: true },
          message: { type: "string", description: "Cuerpo del mensaje", required: true },
          type: { type: "string", description: "info|warning|success|error" },
        },
        handler: async ({ userId, message, type }: any) => {
          if (events) {
            events.emit("Notification.create", {
              userId,
              message,
              type: type ?? "info",
              source: "agent",
            });
          }
          return { sent: true };
        },
      },
      {
        name: "segment_users",
        description:
          "Segmenta usuarios por criterios (score, stage, tags) usando VectorDB si está disponible.",
        parameters: {
          criteria: {
            type: "string",
            description: "Descripción en lenguaje natural de la segmentación",
            required: true,
          },
        },
        handler: async ({ criteria }: any) => {
          if (vectordb) {
            return vectordb.search("crm_insights", criteria, { topK: 20 }).catch(() => ({
              results: [],
            }));
          }
          const contacts = await db.find("Contact", {});
          return {
            results: contacts.slice(0, 10),
            note: "VectorDB no configurado, retornando sample.",
          };
        },
      },
    ];

    // ─── Registrar herramientas compartidas ───────────────────────────────────

    for (const tool of crmTools) TOOL_REGISTRY.set(tool.name, tool);

    // ─── Agentes preconstruidos ───────────────────────────────────────────────

    const BUILTIN_AGENTS: ADKAgentDef[] = [
      {
        id: "crm_assistant",
        name: "CRM Assistant",
        isBuiltin: true,
        provider: "gemini",
        model: "gemini-2.0-flash",
        description: "Asistente conversacional para consultar y actuar sobre datos CRM.",
        systemPrompt:
          `Eres el asistente CRM de Zenith. Ayudas al equipo de ventas a consultar contactos, deals y leads.
Puedes crear tareas, buscar contactos y revisar el pipeline.
Sé conciso, profesional y orientado a acciones concretas.
Siempre confirma antes de crear o modificar datos.`,
        tools: crmTools.map((t) => t.name as any),
        temperature: 0.3,
      },
      {
        id: "lead_scorer",
        name: "Lead Scorer AI",
        isBuiltin: true,
        provider: "gemini",
        model: "gemini-2.0-flash",
        description: "Analiza leads y propone un score de calificación con justificación.",
        systemPrompt: `Eres un especialista en calificación de leads B2B.
Analiza el historial de actividades, valor del deal, stage actual e industria para generar un score 0-100.
Justifica cada puntuación con datos específicos. Recomienda las siguientes acciones concretas.`,
        tools: ["search_contacts", "get_deal_pipeline"],
        temperature: 0.1,
      },
      {
        id: "marketing_writer",
        name: "Marketing Writer",
        isBuiltin: true,
        provider: "gemini",
        model: "gemini-2.0-flash",
        description:
          "Genera emails, posts de blog, campañas y contenido marketing desde contexto CRM.",
        systemPrompt: `Eres un redactor de marketing B2B especializado en contenido personalizado.
Usa los datos del CRM para personalizar mensajes. Escribe en español a menos que se especifique otro idioma.
Mantén un tono profesional pero cercano. Incluye CTAs claros y medibles.`,
        tools: ["search_contacts", "segment_users"],
        temperature: 0.7,
      },
      {
        id: "segment_analyzer",
        name: "Segment Analyzer",
        isBuiltin: true,
        provider: "gemini",
        model: "gemini-2.0-flash",
        description:
          "Segmenta la base de usuarios/contactos por comportamiento usando VectorDB RAG.",
        systemPrompt: `Eres un analista de datos especializado en segmentación de clientes.
Usa búsqueda semántica sobre el historial de interacciones para identificar patrones.
Propón segmentos accionables con nombres descriptivos y criterios claros de membresía.`,
        tools: ["segment_users", "search_contacts"],
        temperature: 0.2,
      },
      {
        id: "support_agent",
        name: "Support Agent",
        isBuiltin: true,
        provider: "gemini",
        model: "gemini-2.0-flash",
        description:
          "Responde tickets de soporte usando la base de conocimiento del foro y notas CRM.",
        systemPrompt: `Eres un agente de soporte al cliente de nivel 1 para Zenith.
Busca en la base de conocimiento (foro, notas, documentación) antes de responder.
Si no tienes la respuesta, escala al equipo humano. Sé empático y claro.`,
        tools: ["search_contacts", "send_notification"],
        temperature: 0.4,
      },
    ];

    for (const agent of BUILTIN_AGENTS) AGENT_REGISTRY.set(agent.id, agent);

    // ─── ReAct Loop (Reasoning + Acting) ────────────────────────────────────

    /** Un turno ReAct sobre `history` (mensajes anteriores) + `input`. */
    async function react(
      agent: ADKAgentDef,
      history: AgentMessage[],
      input: string,
      ctx: any,
    ): Promise<AgentTurnOutput & { messages: Array<{ role: string; content: string }> }> {
      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: agent.systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: input },
      ];
      const iterations: any[] = [];
      let finalAnswer = "";

      for (let i = 0; i < 8; i++) {
        const response = await ai.chat?.(agent.model, messages, {
          temperature: agent.temperature ?? 0.5,
          maxTokens: agent.maxTokens ?? 1024,
        }).catch(() => ({ content: [{ type: "text", text: input }] }));

        const text = response?.content?.[0]?.text ?? response?.choices?.[0]?.message?.content ?? "";
        const toolUse = response?.content?.find?.((c: any) => c.type === "tool_use");

        iterations.push({
          thought: text,
          action: toolUse ? { tool: toolUse.name, input: toolUse.input } : undefined,
        });

        if (!toolUse) {
          finalAnswer = text;
          break;
        }

        const tool = TOOL_REGISTRY.get(toolUse.name);
        const observation = tool
          ? await tool.handler(toolUse.input ?? {}, ctx).catch((e) => ({ error: e.message }))
          : { error: `Tool '${toolUse.name}' no encontrada.` };

        iterations[iterations.length - 1].observation = observation;
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: `Tool result: ${JSON.stringify(observation)}` });
      }
      return { finalAnswer, iterations, messages };
    }

    // ─── Sesiones como celdas ─────────────────────────────────────────────────

    /** El contexto de la petición no cruza la celda (RPC copia los argumentos): viaja una referencia. */
    const contexts = new Map<string, any>();
    const runtime: AgentRuntime = {
      async turn(agentId, history, input, contextRef) {
        const agent = AGENT_REGISTRY.get(agentId);
        if (!agent) throw ZenithErrors.notFound("ADKAgent", agentId);
        const ctx = contextRef ? contexts.get(contextRef) ?? {} : {};
        if (!ai) {
          return { finalAnswer: `[AI no configurado] Input recibido: ${input}`, iterations: [] };
        }
        const { finalAnswer, iterations } = await react(agent, history, input, ctx);
        return { finalAnswer, iterations };
      },
    };
    const sessions = cells?.define(AGENT_SESSION_CELL.className, AgentSessionCell, {
      binding: AGENT_SESSION_CELL.binding,
      env: { AGENT_RUNTIME: runtime },
    });
    const sessionCell = (sessionId: string) => sessions!.getByName(sessionId);

    async function runInSession(agentId: string, input: string, ctx: any, sessionId: string) {
      if (!AGENT_REGISTRY.has(agentId)) throw ZenithErrors.notFound("ADKAgent", agentId);
      const ref = crypto.randomUUID();
      contexts.set(ref, ctx);
      try {
        const cell = sessionCell(sessionId);
        const r = await cell.turn(agentId, String(input ?? ""), { contextRef: ref });
        const result = {
          agentId,
          sessionId,
          finalAnswer: r.finalAnswer,
          iterations: r.iterations,
          durationMs: r.durationMs,
          turn: r.turn,
          backend: "cells" as const,
        };
        // Espejo en ADKSession (la API anterior lo lee de ahí).
        const history = await cell.history();
        await db.update("ADKSession", { objectId: sessionId }, {
          messages: history,
          updatedAt: now(),
        }).catch(() => {});
        if (events) events.emit("ADK.agentCompleted", result);
        return result;
      } finally {
        contexts.delete(ref);
      }
    }

    async function executeAgent(
      agentId: string,
      input: string,
      ctx: any,
      sessionId?: string,
    ): Promise<any> {
      const agent = AGENT_REGISTRY.get(agentId);
      if (!agent) throw ZenithErrors.notFound("ADKAgent", agentId);

      if (sessionId && sessions) return runInSession(agentId, input, ctx, sessionId);

      if (!ai) {
        return {
          agentId,
          finalAnswer: `[AI no configurado] Input recibido: ${input}`,
          iterations: [],
          durationMs: 0,
        };
      }

      const start = Date.now();
      const { finalAnswer, iterations, messages } = await react(agent, [], input, ctx);

      const result = {
        agentId,
        sessionId,
        finalAnswer,
        iterations,
        durationMs: Date.now() - start,
      };

      // Persistir sesión en DB
      if (sessionId) {
        await db.update("ADKSession", { objectId: sessionId }, {
          messages: [...messages, { role: "assistant", content: finalAnswer, timestamp: now() }],
          updatedAt: now(),
        }).catch(() => {});
      }

      if (events) events.emit("ADK.agentCompleted", result);
      return result;
    }

    const api = {
      listAgents: () => ({
        agents: Array.from(AGENT_REGISTRY.values()).map(({ tools: _, ...a }) => a),
      }),
      getAgent: (id: string) => {
        const a = AGENT_REGISTRY.get(id);
        if (!a) throw ZenithErrors.notFound("ADKAgent", id);
        return a;
      },
      registerAgent: (agent: ADKAgentDef) => {
        AGENT_REGISTRY.set(agent.id, agent);
        return agent;
      },
      registerTool: (tool: ADKTool) => {
        TOOL_REGISTRY.set(tool.name, tool);
        return tool;
      },
      run: executeAgent,

      /** Dónde viven las sesiones: `cells` (celda por sesión) o `db` (sin historial previo). */
      sessionBackend: (sessions ? "cells" : "db") as "cells" | "db",

      /** El historial de una sesión (celdas) o `ADKSession.messages` (base de datos). */
      async history(agentId: string, sessionId: string) {
        if (sessions) {
          const cell = sessionCell(sessionId);
          const info = await cell.info();
          if (info.agentId !== null && info.agentId !== agentId) {
            throw ZenithErrors.notFound("ADKSession", sessionId);
          }
          return { sessionId, ...info, agentId, history: await cell.history() };
        }
        const row = await db.read?.("ADKSession", sessionId).catch(() => null);
        return { sessionId, agentId, history: row?.messages ?? [] };
      },

      async createSession(agentId: string, ctx: any) {
        return db.create("ADKSession", {
          agentId,
          messages: [],
          userId: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          createdAt: now(),
          updatedAt: now(),
        });
      },
    };

    const adk_routes = [
      {
        method: "GET" as const,
        path: "/zen/agents",
        _openapi: { summary: "Listar Agentes ADK disponibles", tags: ["Agents"] },
        handler: (_req: Request, _ctx: any) => jsonRes(api.listAgents()),
      },
      {
        method: "GET" as const,
        path: "/zen/agents/:agentId",
        _openapi: { summary: "Obtener definición de un Agente", tags: ["Agents"] },
        handler: (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/agents/:agentId", req.url)!;
            return jsonRes(api.getAgent(p.agentId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/agents/:agentId/run",
        _openapi: { summary: "Ejecutar Agente con un input", tags: ["Agents"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/agents/:agentId/run", req.url)!;
            const b = await req.json();
            return jsonRes(await api.run(p.agentId, b.input, ctx, b.sessionId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/agents/:agentId/sessions",
        _openapi: { summary: "Crear sesión de conversación con Agente", tags: ["Agents"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/agents/:agentId/sessions", req.url)!;
            return jsonRes(await api.createSession(p.agentId, ctx), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/agents/:agentId/sessions/:sessionId/messages",
        _openapi: { summary: "Historial de una sesión de conversación", tags: ["Agents"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/agents/:agentId/sessions/:sessionId/messages", req.url)!;
            return jsonRes(await api.history(p.agentId, p.sessionId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/agents/:agentId/sessions/:sessionId/messages",
        _openapi: {
          summary: "Un turno de la sesión (uno a la vez por sesión, con su historial)",
          tags: ["Agents"],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = pathParams("/zen/agents/:agentId/sessions/:sessionId/messages", req.url)!;
            const b = await req.json();
            return jsonRes(await api.run(p.agentId, b.input, ctx, p.sessionId));
          } catch (e) {
            return errRes(e);
          }
        },
      },
    ];

    return { adk_routes, adkAgents: api };
  },
});
