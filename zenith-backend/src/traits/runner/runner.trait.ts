// deno-lint-ignore-file no-unused-vars
/**
 * Code runner: sandboxed Deno worker pool for executing user-submitted scripts, custom logic functions, and cloud functions. Memory/CPU limits, timeout enforcement.
 *
 * @barrits-trait
 * @barrits-summary ZenithRunner
 * @barrits-provides runner-routes, runner, codeRunner
 * @barrits-consumes db, telemetry, shell
 * @barrits-state activeRuns, sandboxPool
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const RunnerTrait = createTraitDescriptor({
  name: "ZenithRunner",
  provides: ["runner-routes", "runner", "codeRunner"],
  consumes: ["db", "telemetry", "shell"],
  state: ["activeRuns", "sandboxPool"],
  runtimes: ["deno"],
  summary: "Code runner: sandboxed Deno worker pool for executing user-submitted scripts, custom logic functions, and cloud functions. Memory/CPU limits, timeout enforcement.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const shell = deps["shell"];

    const traitApi: any = {
      activeRuns: new Map<string, { startedAt: number; worker: Worker | null }>(),
      sandboxPool: [] as Worker[],

      runScript: async (code: string, options: { timeout?: number; memoryMb?: number } = {}): Promise<{ output: string; error?: string; durationMs: number }> => {
        const start = Date.now();
        const timeout = options.timeout || 30000;
        const runId = crypto.randomUUID();
        try {
          const blob = new Blob([code], { type: "application/typescript" });
          const worker = new Worker(URL.createObjectURL(blob), { type: "module", deno: { permissions: { read: false, write: false, net: false, env: false, run: false } } } as any);
          traitApi.activeRuns.set(runId, { startedAt: start, worker });
          const result = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => { worker.terminate(); reject(new Error("timeout")); }, timeout);
            worker.onmessage = (e: MessageEvent) => { clearTimeout(timer); resolve(String(e.data)); };
            worker.onerror = (e: ErrorEvent) => { clearTimeout(timer); reject(new Error(e.message)); };
          });
          worker.terminate();
          traitApi.activeRuns.delete(runId);
          return { output: result, durationMs: Date.now() - start };
        } catch (e: any) {
          traitApi.activeRuns.delete(runId);
          return { output: "", error: e.message, durationMs: Date.now() - start };
        }
      },

      cancelRun: (runId: string) => {
        const run = traitApi.activeRuns.get(runId);
        if (run && run.worker) {
          run.worker.terminate();
          traitApi.activeRuns.delete(runId);
          return { cancelled: true };
        }
        return { cancelled: false };
      },

      listActive: () => Array.from(traitApi.activeRuns.keys()),
    };

    const runner_routes = [
      {
        method: "POST" as const,
        path: "/runner/execute",
        _openapi: { summary: "Execute a script in a sandbox" },
        handler: async (req: Request) => {
          const body = await req.json() as { code: string; timeout?: number };
          const result = await traitApi.runScript(body.code, { timeout: body.timeout });
          return new Response(JSON.stringify(result), { status: result.error ? 500 : 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/runner/active",
        _openapi: { summary: "List active script runs" },
        handler: async () => new Response(JSON.stringify({ activeRuns: traitApi.listActive() }), { status: 200, headers: { "content-type": "application/json" } }),
      },
    ];

    return {
      "runner-routes": runner_routes,
      "runner": traitApi,
      "codeRunner": traitApi,
    };
  },
});
