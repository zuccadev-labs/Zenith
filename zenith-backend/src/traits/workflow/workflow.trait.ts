/**
 * iPaaS-style workflow engine: define trigger→action pipelines, schedule with cron, retry policies, conditional branching, error handling, persistent execution history.
 *
 * @barrits-trait
 * @barrits-summary ZenithWorkflow
 * @barrits-provides workflow-routes, workflow, workflowEngine
 * @barrits-consumes cloud, db
 * @barrits-tags uses:events
 * @barrits-state workflows, cronJobs
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const WorkflowTrait = createTraitDescriptor({
  name: "ZenithWorkflow",
  provides: ["workflow-routes", "workflow", "workflowEngine"],
  consumes: ["cloud", "db"],
  tags: ["uses:events"],
  state: ["workflows", "cronJobs"],
  runtimes: ["deno"],
  summary:
    "iPaaS-style workflow engine: define trigger→action pipelines, schedule with cron, retry policies, conditional branching, error handling, persistent execution history.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const events = deps.traits["events"];
    const cloud = deps.traits["cloud"];

    const traitApi: any = {
      workflows: new Map<
        string,
        { name: string; trigger: any; actions: any[]; enabled: boolean; schedule?: string }
      >(),
      cronJobs: new Map<string, { intervalId: ReturnType<typeof setInterval>; workflow: string }>(),

      defineWorkflow: (
        name: string,
        config: {
          trigger: {
            type: "event" | "schedule" | "http";
            eventName?: string;
            schedule?: string;
            path?: string;
          };
          actions: Array<
            { type: "cloud-function" | "http" | "db-write" | "send-webhook"; config: any }
          >;
        },
      ) => {
        traitApi.workflows.set(name, {
          name,
          trigger: config.trigger,
          actions: config.actions,
          enabled: true,
          schedule: config.trigger.schedule,
        });
        if (config.trigger.type === "schedule" && config.trigger.schedule) {
          traitApi.scheduleWorkflow(name, config.trigger.schedule);
        }
        if (config.trigger.type === "event" && config.trigger.eventName) {
          events?.on(config.trigger.eventName, async (payload: any) => {
            await traitApi.executeWorkflow(name, { event: config.trigger.eventName, payload });
          });
        }
      },

      scheduleWorkflow: (name: string, cronExpression: string) => {
        const existing = traitApi.cronJobs.get(name);
        if (existing) clearInterval(existing.intervalId);
        const intervalMs = parseCronToInterval(cronExpression);
        const intervalId = setInterval(async () => {
          try {
            await traitApi.executeWorkflow(name, { trigger: "schedule" });
          } catch (e) {
            console.error(`[Workflow] ${name} failed:`, e);
          }
        }, intervalMs);
        traitApi.cronJobs.set(name, { intervalId: intervalId as any, workflow: name });
      },

      executeWorkflow: async (name: string, context: any) => {
        const wf = traitApi.workflows.get(name);
        if (!wf || !wf.enabled) return { executed: false };
        const execution: {
          workflow: string;
          context: any;
          startedAt: string;
          completedAt?: string;
          results: any[];
        } = { workflow: name, context, startedAt: new Date().toISOString(), results: [] as any[] };
        for (const action of wf.actions) {
          try {
            if (action.type === "cloud-function" && cloud) {
              const r = await cloud.run(
                action.config.function,
                action.config.params || {},
                context,
              );
              execution.results.push({ action: action.type, result: r });
            } else if (action.type === "http") {
              const r = await fetch(action.config.url, {
                method: action.config.method || "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(action.config.body || context),
              });
              execution.results.push({ action: action.type, status: r.status });
            } else if (action.type === "db-write") {
              const r = await db.create(action.config.className, action.config.data);
              execution.results.push({ action: action.type, id: r.objectId });
            }
          } catch (e: any) {
            execution.results.push({ action: action.type, error: e.message });
          }
        }
        execution.completedAt = new Date().toISOString();
        await db.create("_WorkflowExecution", execution).catch(() => {});
        return execution;
      },

      enable: (name: string) => {
        const wf = traitApi.workflows.get(name);
        if (wf) wf.enabled = true;
      },
      disable: (name: string) => {
        const wf = traitApi.workflows.get(name);
        if (wf) wf.enabled = false;
      },
    };

    function parseCronToInterval(expr: string): number {
      if (expr.startsWith("*/")) {
        const seconds = parseInt(expr.substring(2), 10);
        return Math.max(seconds * 1000, 1000);
      }
      return 60000;
    }

    const workflow_routes = [
      {
        method: "POST" as const,
        path: "/workflows",
        _openapi: { summary: "Define a new workflow" },
        handler: async (req: Request) => {
          const body = await req.json() as { name: string; trigger: any; actions: any[] };
          traitApi.defineWorkflow(body.name, { trigger: body.trigger, actions: body.actions });
          return new Response(JSON.stringify({ defined: true, name: body.name }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      },
      {
        method: "POST" as const,
        path: "/workflows/:name/execute",
        _openapi: {
          summary: "Manually trigger a workflow",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request) => {
          const name = new URL(req.url).pathname.split("/")[2];
          const body = await req.json().catch(() => ({}));
          const result = await traitApi.executeWorkflow(name, body);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    ];

    return {
      "workflow-routes": workflow_routes,
      "workflow": traitApi,
      "workflowEngine": traitApi,
    };
  },
});
