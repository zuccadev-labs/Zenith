/**
 * @module @zenith/cli/commands/agent
 *
 * Los agentes ADK del backend (`/zen/agents`), desde la terminal.
 *
 *   zen agent list
 *   zen agent get <agentId>
 *   zen agent run <agentId> --input "texto"     [--session <id>]
 *   zen agent chat <agentId>                     conversación con sesión (Ctrl-D para salir)
 *
 * Antes este comando era una copia de un CLI antiguo con respuestas simuladas (una lista de plugins
 * inventada, un REPL que no ejecutaba nada) y el dispatcher llamaba a funciones que no existían.
 */
import { parseArgs } from "@std/cli/parse-args";
import { TextLineStream } from "@std/streams/text-line-stream";
import { loadZenConfig, printJson, printTable, zenApiCall } from "./_utils.ts";

const HELP = `
zen agent — Agentes ADK del backend

  list                       Agentes disponibles
  get <agentId>              Definición de un agente
  run <agentId> --input "…"  Ejecuta una vez (opcional --session <id>)
  chat <agentId>             Conversación con sesión; Ctrl-D para salir
`;

const id = (v: unknown) => {
  if (typeof v !== "string" || !v) throw new Error("Falta <agentId>.");
  return encodeURIComponent(v);
};

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    string: ["input", "session"],
    boolean: ["help", "json"],
    alias: { help: "h" },
  });
  const [sub, agent] = args._.map(String);
  if (!sub || args.help) return void console.log(HELP);
  const cfg = await loadZenConfig();

  switch (sub) {
    case "list": {
      const { agents } = await zenApiCall(cfg, "GET", "/zen/agents");
      if (args.json) return printJson(agents);
      return printTable(agents, ["id", "name", "description", "model"]);
    }
    case "get":
      return printJson(await zenApiCall(cfg, "GET", `/zen/agents/${id(agent)}`));
    case "run": {
      if (!args.input) throw new Error("--input es obligatorio.");
      const res = await zenApiCall(cfg, "POST", `/zen/agents/${id(agent)}/run`, {
        input: args.input,
        sessionId: args.session,
      });
      if (args.json) return printJson(res);
      return void console.log(res.finalAnswer ?? JSON.stringify(res));
    }
    case "chat": {
      const session = await zenApiCall(cfg, "POST", `/zen/agents/${id(agent)}/sessions`);
      console.log(
        `💬 Sesión ${session.objectId} con ${agent}. Escribe y pulsa Enter; Ctrl-D para salir.`,
      );
      const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).pipeThrough(
        new TextLineStream(),
      );
      await Deno.stdout.write(new TextEncoder().encode("> "));
      for await (const line of lines) {
        if (line.trim()) {
          const res = await zenApiCall(cfg, "POST", `/zen/agents/${id(agent)}/run`, {
            input: line,
            sessionId: session.objectId,
          });
          console.log(res.finalAnswer ?? JSON.stringify(res));
        }
        await Deno.stdout.write(new TextEncoder().encode("> "));
      }
      return void console.log();
    }
    default:
      throw new Error(`Subcomando desconocido: ${sub}. Usa: zen agent --help`);
  }
}
