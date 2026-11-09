// deno-lint-ignore-file no-unused-vars
/**
 * AI agent layer: multi-provider LLM access (Anthropic, OpenAI, Ollama), tool-calling registry, ReAct loop, conversation memory, prompt templates, cost tracking.
 *
 * @barrits-trait
 * @barrits-summary ZenithAI
 * @barrits-provides ai-routes, ai, aiProvider
 * @barrits-consumes db
 * @barrits-tags uses:vectordb
 * @barrits-state providers, tools
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const AITrait = createTraitDescriptor({
  name: "ZenithAI",
  provides: ["ai-routes", "ai", "aiProvider"],
  consumes: ["db"],
  tags: ["uses:vectordb"],
  state: ["providers", "tools"],
  runtimes: ["deno"],
  summary: "AI agent layer: multi-provider LLM access (Anthropic, OpenAI, Ollama), tool-calling registry, ReAct loop, conversation memory, prompt templates, cost tracking.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const vectordb = deps.traits["vectordb"];

    const traitApi: any = {
      providers: new Map<string, { type: string; apiKey?: string; endpoint?: string; model: string }>(),
      tools: new Map<string, { definition: any; handler: (params: any, ctx: any) => Promise<any> }>(),

      registerProvider: (name: string, type: "anthropic" | "openai" | "ollama" | "custom", config: { apiKey?: string; endpoint?: string; model: string }) => {
        traitApi.providers.set(name, { type, ...config });
      },

      registerTool: (name: string, definition: any, handler: (params: any, ctx: any) => Promise<any>) => {
        traitApi.tools.set(name, { definition, handler });
      },

      chat: async (providerName: string, messages: Array<{ role: string; content: string }>, options: { temperature?: number; maxTokens?: number; tools?: string[] } = {}) => {
        const provider = traitApi.providers.get(providerName);
        if (!provider) throw new Error(`provider not registered: ${providerName}`);
        if (provider.type === "anthropic") {
          const anthropic = await import("@anthropic-ai/sdk");
          const client = new (anthropic as any).default({ apiKey: provider.apiKey });
          const tools = (options.tools || []).map((t) => traitApi.tools.get(t)?.definition).filter(Boolean);
          const res = await client.messages.create({ model: provider.model, max_tokens: options.maxTokens || 1024, temperature: options.temperature, messages: messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content })) as any, tools: tools as any });
          return { content: res.content, usage: res.usage, stop_reason: res.stop_reason };
        }
        if (provider.type === "openai") {
          const openai = await import("openai");
          const client = new (openai as any).OpenAI({ apiKey: provider.apiKey });
          const tools = (options.tools || []).map((t) => traitApi.tools.get(t)?.definition).filter(Boolean).map((d: any) => ({ type: "function", function: d }));
          const res = await client.chat.completions.create({ model: provider.model, messages: messages as any, temperature: options.temperature, max_tokens: options.maxTokens, tools });
          return res;
        }
        if (provider.type === "ollama") {
          const res = await fetch(`${provider.endpoint || "http://localhost:11434"}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: provider.model, messages, stream: false }) });
          return await res.json();
        }
        throw new Error(`unsupported provider type: ${provider.type}`);
      },

      rag: async (providerName: string, query: string, options: { collection?: string; topK?: number } = {}) => {
        if (!vectordb) throw new Error("vectordb dependency not available");
        const results = await vectordb.search(options.collection || "default", query, options.topK || 5);
        const context = results.map((r: any) => r.text || r.content).join("\n\n");
        const messages = [
          { role: "system", content: `You are a helpful assistant. Use the following context to answer the user's question.\n\nContext:\n${context}` },
          { role: "user", content: query },
        ];
        return await traitApi.chat(providerName, messages);
      },
    };

    const ai_routes = [
      {
        method: "POST" as const,
        path: "/ai/chat",
        _openapi: { summary: "Send a chat completion request" },
        handler: async (req: Request) => {
          const body = await req.json() as { provider: string; messages: any[]; options?: any };
          const result = await traitApi.chat(body.provider, body.messages, body.options);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/ai/rag",
        _openapi: { summary: "Retrieval-Augmented Generation" },
        handler: async (req: Request) => {
          const body = await req.json() as { provider: string; query: string; collection?: string };
          const result = await traitApi.rag(body.provider, body.query, { collection: body.collection });
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "ai-routes": ai_routes,
      "ai": traitApi,
      "aiProvider": traitApi,
    };
  },
});
