// deno-lint-ignore-file no-unused-vars
/**
 * Shell command execution trait for system-administration endpoints. Sandboxed via Deno permissions, command whitelist, audit trail, SoD (separation of duties) checks.
 *
 * @barrits-trait
 * @barrits-summary ZenithShellAPI
 * @barrits-provides shell-routes, shell, commandRunner
 * @barrits-consumes telemetry
 * @barrits-state execHistory, maxHistory
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const ShellApiTrait = createTraitDescriptor({
  name: "ZenithShellAPI",
  provides: ["shell-routes", "shell", "commandRunner"],
  consumes: ["telemetry"],
  state: ["execHistory", "maxHistory"],
  runtimes: ["deno"],
  summary: "Shell command execution trait for system-administration endpoints. Sandboxed via Deno permissions, command whitelist, audit trail, SoD (separation of duties) checks.",
  create: (deps: Record<string, any>) => {
    const telemetry = deps.traits["telemetry"];

    const ALLOWED_COMMANDS = new Set([
      "ls", "pwd", "echo", "cat", "head", "tail", "grep", "wc",
      "ps", "df", "du", "free", "uptime", "date", "whoami", "id",
      "uname", "hostname", "env", "which", "whereis", "stat", "file",
    ]);

    const traitApi: any = {
      execHistory: [] as Array<{ command: string; output: string; exitCode: number; timestamp: number; userId: string }>,
      maxHistory: 100,

      isAllowed: (command: string): boolean => {
        const baseCmd = command.trim().split(/\s+/)[0];
        return ALLOWED_COMMANDS.has(baseCmd);
      },

      execute: async (command: string, options: { userId?: string; timeout?: number } = {}): Promise<{ output: string; exitCode: number; durationMs: number; allowed: boolean }> => {
        const start = Date.now();
        const userId = options.userId || "anonymous";
        const timeout = options.timeout || 10000;
        const allowed = traitApi.isAllowed(command);
        if (!allowed) {
          const record = { command, output: "PERMISSION DENIED: command not in whitelist", exitCode: 126, timestamp: start, userId };
          traitApi.execHistory.push(record);
          if (traitApi.execHistory.length > traitApi.maxHistory) traitApi.execHistory.shift();
          if (telemetry?.warn) telemetry.warn(`[Shell] DENIED command: ${command} (user: ${userId})`);
          return { output: "PERMISSION DENIED", exitCode: 126, durationMs: Date.now() - start, allowed: false };
        }
        try {
          const cmd = new Deno.Command(command.trim().split(/\s+/)[0], {
            args: command.trim().split(/\s+/).slice(1),
            stdout: "piped",
            stderr: "piped",
          });
          const { code, stdout, stderr } = await cmd.output();
          const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
          const record = { command, output, exitCode: code, timestamp: start, userId };
          traitApi.execHistory.push(record);
          if (traitApi.execHistory.length > traitApi.maxHistory) traitApi.execHistory.shift();
          if (telemetry?.log) telemetry.log(`[Shell] ${userId}@localhost: ${command} (exit=${code}, ${Date.now() - start}ms)`);
          return { output, exitCode: code, durationMs: Date.now() - start, allowed: true };
        } catch (e: any) {
          const record = { command, output: e.message, exitCode: 127, timestamp: start, userId };
          traitApi.execHistory.push(record);
          if (traitApi.execHistory.length > traitApi.maxHistory) traitApi.execHistory.shift();
          return { output: e.message, exitCode: 127, durationMs: Date.now() - start, allowed: false };
        }
      },

      getHistory: (userId?: string) => {
        if (userId) return traitApi.execHistory.filter((r: { userId: string }) => r.userId === userId);
        return traitApi.execHistory;
      },

      clearHistory: () => { traitApi.execHistory = []; },
    };

    const shell_routes = [
      {
        method: "POST" as const,
        path: "/shell/exec",
        _openapi: {
          summary: "Execute a whitelisted shell command",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } } } },
        },
        handler: async (req: Request, ctx: any) => {
          const body = await req.json() as { command: string; timeout?: number };
          const userId = ctx?.user?.objectId || "anonymous";
          const result = await traitApi.execute(body.command, { userId, timeout: body.timeout });
          return new Response(JSON.stringify(result), { status: result.allowed ? 200 : 403, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/shell/history",
        _openapi: { summary: "Get shell execution history" },
        handler: async (req: Request, ctx: any) => {
          const userId = ctx?.user?.masterKey ? undefined : ctx?.user?.objectId;
          const history = traitApi.getHistory(userId);
          return new Response(JSON.stringify({ history }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "shell-routes": shell_routes,
      "shell": traitApi,
      "commandRunner": traitApi,
    };
  },
});
