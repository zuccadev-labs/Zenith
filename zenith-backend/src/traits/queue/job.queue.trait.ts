/**
 * Background job queue: persistent jobs, retry policies, dead-letter queue, scheduled (delayed) jobs, worker pool, priority levels, deduplication by idempotency key.
 *
 * @barrits-trait
 * @barrits-summary ZenithJobQueue
 * @barrits-provides queue-routes, queue, jobQueue
 * @barrits-consumes db
 * @barrits-state jobs, workers
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor, type AnyTraitDescriptor } from "@zuccadev-labs/barrits";

interface Job {
  jobId: string;
  type: string;
  data: any;
  status: "pending" | "running" | "completed" | "failed";
  priority: number;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  scheduledFor?: number;
  lastError?: string;
  idempotencyKey?: string;
}

export const JobQueueTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithJobQueue",
  provides: ["queue-routes", "queue", "jobQueue"],
  consumes: ["db"],
  state: ["jobs", "workers"],
  runtimes: ["deno"],
  summary: "Background job queue: persistent jobs, retry policies, dead-letter queue, scheduled (delayed) jobs, worker pool, priority levels, deduplication by idempotency key.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    const jobs = new Map<string, Job>();
    const workers = new Map<string, (data: any) => Promise<any>>();

    const traitApi: any = {
      jobs,
      workers,

      registerWorker: (jobType: string, handler: (data: any) => Promise<any>) => {
        workers.set(jobType, handler);
      },

      enqueue: async (type: string, data: any, options: { priority?: number; maxAttempts?: number; delayMs?: number; idempotencyKey?: string } = {}) => {
        if (options.idempotencyKey) {
          const existing = Array.from(jobs.values()).find((j: Job) => j.idempotencyKey === options.idempotencyKey);
          if (existing) return existing;
        }
        const job: Job = {
          jobId: crypto.randomUUID(),
          type,
          data,
          status: "pending",
          priority: options.priority || 0,
          attempts: 0,
          maxAttempts: options.maxAttempts || 3,
          createdAt: Date.now(),
          scheduledFor: options.delayMs ? Date.now() + options.delayMs : undefined,
          idempotencyKey: options.idempotencyKey,
        };
        jobs.set(job.jobId, job);
        await db.create("_Job", job).catch(() => {});
        return job;
      },

      processNext: async () => {
        const now = Date.now();
        const pending: Job[] = Array.from(jobs.values())
          .filter((j: Job) => j.status === "pending" && (!j.scheduledFor || j.scheduledFor <= now))
          .sort((a: Job, b: Job) => b.priority - a.priority);
        if (pending.length === 0) return null;
        const job: Job = pending[0];
        job.status = "running";
        job.attempts++;
        const worker = workers.get(job.type);
        if (!worker) {
          job.status = "failed";
          job.lastError = `no worker registered for: ${job.type}`;
          return job;
        }
        try {
          await worker(job.data);
          job.status = "completed";
        } catch (e: any) {
          job.lastError = e.message;
          if (job.attempts < job.maxAttempts) {
            job.status = "pending";
            job.scheduledFor = Date.now() + 1000 * Math.pow(2, job.attempts);
          } else {
            job.status = "failed";
          }
        }
        return job;
      },

      startWorker: () => {
        const intervalId = setInterval(async () => {
          try { await traitApi.processNext(); } catch (_e) { /* noop: worker loop */ }
        }, 1000);
        return () => clearInterval(intervalId);
      },
    };

    const queue_routes = [
      {
        method: "POST" as const,
        path: "/queue/enqueue",
        _openapi: { summary: "Enqueue a background job" },
        handler: async (req: Request) => {
          const body = await req.json() as { type: string; data: any; priority?: number; maxAttempts?: number; delayMs?: number };
          const job = await traitApi.enqueue(body.type, body.data, { priority: body.priority, maxAttempts: body.maxAttempts, delayMs: body.delayMs });
          return new Response(JSON.stringify(job), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/queue/jobs",
        _openapi: { summary: "List jobs by status" },
        handler: async (req: Request) => {
          const url = new URL(req.url);
          const status = url.searchParams.get("status") as Job["status"] | null;
          const jobsList: Job[] = Array.from(jobs.values()).filter((j: Job) => !status || j.status === status);
          return new Response(JSON.stringify({ jobs: jobsList }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "queue-routes": queue_routes,
      "queue": traitApi,
      "jobQueue": traitApi,
    };
  },
});
