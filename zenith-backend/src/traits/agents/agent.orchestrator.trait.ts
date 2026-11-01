/**
 * Agent orchestrator: define agents with system prompts and tools, execute ReAct loop (Thought → Action → Observation), persist conversation history, support multi-agent handoff.
 *
 * @barrits-trait
 * @barrits-summary ZenithAgentOrchestrator
 * @barrits-provides agent-orchestrator-routes, agent-orchestrator, agents
 * @barrits-consumes ai, vectordb, db, telemetry
 * @barrits-state agents, tools
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model: string;
  temperature?: number;
  maxIterations?: number;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  handler: (params: any, ctx: any) => Promise<any>;
}

export interface AgentRunResult {
  agentName: string;
  iterations: Array<{ thought: string; action?: { tool: string; input: any }; observation?: any }>;
  finalAnswer: string;
  durationMs: number;
}

export const AgentOrchestratorTrait = createTraitDescriptor({
  name: "ZenithAgentOrchestrator",
  provides: ["agent-orchestrator-routes", "agent-orchestrator", "agents"],
  consumes: ["ai", "vectordb", "db", "telemetry"],
  state: ["agents", "tools"],
  runtimes: ["deno"],
  summary: "Agent orchestrator: define agents with system prompts and tools, execute ReAct loop (Thought → Action → Observation), persist conversation history, support multi-agent handoff.",
  create: (deps: Record<string, any>) => {
    const ai = deps["ai"];

    const traitApi: any = {
      agents: new Map<string, AgentDefinition>(),
      tools: new Map<string, AgentTool>(),

      registerAgent: (agent: AgentDefinition) => {
        traitApi.agents.set(agent.name, agent);
      },

      registerTool: (tool: AgentTool) => {
        traitApi.tools.set(tool.name, tool);
      },

      runAgent: async (agentName: string, input: string, options: { maxIterations?: number; context?: any } = {}): Promise<AgentRunResult> => {
        const agent = traitApi.agents.get(agentName);
        if (!agent) throw new Error(`agent not found: ${agentName}`);
        const maxIter = options.maxIterations || agent.maxIterations || 10;
        const start = Date.now();
        const iterations: any[] = [];
        const messages: any[] = [
          { role: "system", content: `${agent.systemPrompt}\n\nYou have access to these tools: ${agent.tools.map((t: string) => traitApi.tools.get(t)?.name).filter(Boolean).join(", ")}` },
          { role: "user", content: input },
        ];
        let finalAnswer = "";
        for (let i = 0; i < maxIter; i++) {
          const response: any = await ai.chat("default", messages, { tools: agent.tools, temperature: agent.temperature });
          const content = response.content?.[0]?.text || response.choices?.[0]?.message?.content || "";
          const toolUse = response.content?.find?.((c: any) => c.type === "tool_use") || response.choices?.[0]?.message?.tool_calls?.[0];
          iterations.push({ thought: content, action: toolUse ? { tool: toolUse.name, input: toolUse.input || JSON.parse(toolUse.function?.arguments || "{}") } : undefined });
          if (!toolUse) {
            finalAnswer = content;
            break;
          }
          const tool = traitApi.tools.get(toolUse.name);
          if (!tool) {
            iterations[iterations.length - 1].observation = { error: `tool not found: ${toolUse.name}` };
            break;
          }
          const observation = await tool.handler(toolUse.input || {}, options.context || {});
          iterations[iterations.length - 1].observation = observation;
          messages.push({ role: "assistant", content });
          messages.push({ role: "user", content: `Tool result: ${JSON.stringify(observation)}` });
        }
        if (!finalAnswer) finalAnswer = "Max iterations reached without a final answer.";
        return { agentName, iterations, finalAnswer, durationMs: Date.now() - start };
      },
    };

    const agent_orchestrator_routes = [
      {
        method: "POST" as const,
        path: "/agents",
        _openapi: { summary: "Register a new agent" },
        handler: async (req: Request) => {
          const body = await req.json() as AgentDefinition;
          traitApi.registerAgent(body);
          return new Response(JSON.stringify({ registered: true, name: body.name }), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/agents/:name/run",
        _openapi: {
          summary: "Execute an agent run",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { input: { type: "string" }, maxIterations: { type: "integer" } }, required: ["input"] } } } },
        },
        handler: async (req: Request) => {
          const name = new URL(req.url).pathname.split("/")[2];
          const body = await req.json() as { input: string; maxIterations?: number };
          const result = await traitApi.runAgent(name, body.input, { maxIterations: body.maxIterations });
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/agents",
        _openapi: { summary: "List registered agents" },
        handler: async () => new Response(JSON.stringify({ agents: Array.from(traitApi.agents.keys()) }), { status: 200, headers: { "content-type": "application/json" } }),
      },
    ];

    return {
      "agent-orchestrator-routes": agent_orchestrator_routes,
      "agent-orchestrator": traitApi,
      "agents": traitApi,
    };
  },
});
