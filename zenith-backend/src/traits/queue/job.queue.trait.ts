/**
 * Cola de trabajos duradera: cada trabajo es un registro de `_Job` en la base de datos, así que sobrevive
 * a reinicios y varias instancias se reparten el trabajo sin duplicarlo (`core/outbox.ts`).
 *
 * - **API:**
 *   - `registerWorker(tipo, fn)` registra quién procesa un tipo;
 *   - `enqueue(tipo, datos, { priority, maxAttempts, delayMs, idempotencyKey })` encola. Con la misma
 *     `idempotencyKey` devuelve el trabajo que ya existe;
 *   - `processDue()` procesa lo vencido;
 *   - `startBackground()` lo hace cada segundo.
 * - **Reintentos:** si el worker lanza, el trabajo vuelve a la cola con espera exponencial (2, 4, 8 s…,
 *   máximo 1 h, ±10 %). Al agotar `maxAttempts` queda `failed` (cola de mensajes muertos) y se puede
 *   reintentar con `retry(jobId)`.
 * - **Al menos una vez:** si una instancia cae mientras procesa, otra lo retoma al vencer la concesión
 *   (`leaseMs`, 5 min por defecto). Los workers deben ser idempotentes.
 * - **Tipos sin worker:** si esta instancia no tiene worker para un tipo, no reclama el trabajo y lo deja
 *   para otra que sí lo tenga.
 * - **API HTTP** (solo master key): `POST /queue/enqueue`, `GET /queue/jobs?status=` y
 *   `POST /queue/jobs/:jobId/retry`.
 *
 * @barrits-trait
 * @barrits-summary ZenithJobQueue
 * @barrits-provides queue-routes, queue, jobQueue
 * @barrits-consumes db
 * @barrits-tags uses:metric-registry
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { claimDue, isLeased } from "../../core/outbox.ts";
import { ZenithError, ZenithErrorCode, ZenithErrors } from "../../core/errors.ts";

export const JOB_CLASS = "_Job";
const MAX_BACKOFF_MS = 3_600_000;

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface Job {
  objectId: string;
  jobId: string;
  type: string;
  data: unknown;
  /** `running` no se guarda: es un trabajo pendiente con la concesión en vigor. */
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  idempotencyKey?: string;
  lastError?: string;
  result?: unknown;
  finishedAt?: string;
  createdAt?: string;
}

export interface EnqueueOptions {
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly idempotencyKey?: string;
}

export interface JobQueueOptions {
  readonly now?: () => number;
  readonly leaseMs?: number;
  /** Trabajos a la vez por instancia. */
  readonly concurrency?: number;
  readonly intervalMs?: number;
  readonly random?: () => number;
}

/** Espera antes del intento `attempt + 1` tras fallar el número `attempt` (1-based). */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(base + base * 0.1 * (random() * 2 - 1));
}

const iso = (ms: number) => new Date(ms).toISOString();
const bad = (msg: string) => new ZenithError(ZenithErrorCode.INVALID_JSON, msg, 400);

export function createJobQueueTrait(options: JobQueueOptions = {}): AnyTraitDescriptor {
  return createTraitDescriptor({
    name: "ZenithJobQueue",
    provides: ["queue-routes", "queue", "jobQueue"],
    consumes: ["db"],
    tags: ["uses:metric-registry"],
    state: [],
    runtimes: ["deno"],
    summary:
      "Durable job queue on _Job: survives restarts, shared by every instance without duplicates (core/outbox.ts), priorities, delays, idempotency keys, exponential retries and a dead-letter state.",
    create: (deps: Record<string, any>) => {
      const db = deps.traits["db"];
      const clock = options.now ?? Date.now;
      const random = options.random ?? Math.random;
      const leaseMs = options.leaseMs ?? 300_000;
      const concurrency = options.concurrency ?? 5;
      const workers = new Map<string, (data: any) => unknown | Promise<unknown>>();
      const metrics = deps.traits["metric-registry"];
      const count = (job: Job, result: string, ms: number) => {
        metrics?.increment("zenith_jobs_total", { type: job.type, result });
        metrics?.histogram("zenith_job_duration_ms", ms, { type: job.type, result });
      };

      /** Estado visible: `running` si está pendiente con concesión en vigor. */
      const view = (j: Job): Job => ({
        ...j,
        status: j.status === "pending" && isLeased(j, clock()) ? "running" : j.status,
      });

      const finish = async (job: Job, patch: Partial<Job>) =>
        await db.update(JOB_CLASS, { objectId: job.objectId }, { ...patch, leaseUntil: null });

      const run = async (job: Job): Promise<Job> => {
        const attempts = (job.attempts ?? 0) + 1;
        const worker = workers.get(job.type)!;
        const started = clock();
        try {
          const result = await worker(job.data);
          count(job, "completed", clock() - started);
          return view(
            await finish(job, {
              status: "completed",
              attempts,
              result: result ?? null,
              finishedAt: iso(clock()),
              nextAttemptAt: null,
              lastError: undefined,
            }),
          );
        } catch (e) {
          const lastError = (e as Error)?.message ?? String(e);
          const dead = attempts >= job.maxAttempts;
          count(job, dead ? "failed" : "retry", clock() - started);
          if (dead) {
            console.warn(
              `[queue] job ${job.jobId} (${job.type}) failed after ${attempts} attempts: ${lastError}`,
            );
            return view(
              await finish(job, {
                status: "failed",
                attempts,
                lastError,
                finishedAt: iso(clock()),
                nextAttemptAt: null,
              }),
            );
          }
          return view(
            await finish(job, {
              status: "pending",
              attempts,
              lastError,
              nextAttemptAt: iso(clock() + backoffMs(attempts, random)),
            }),
          );
        }
      };

      /** Reclama y procesa hasta `limit` trabajos vencidos, por prioridad y después por antigüedad. */
      const processDue = async (limit = concurrency): Promise<Job[]> => {
        const claimed = await claimDue<Job>(db, JOB_CLASS, {
          now: clock(),
          limit,
          leaseMs,
          order: (a, b) =>
            (b.priority ?? 0) - (a.priority ?? 0) ||
            String(a.nextAttemptAt ?? "").localeCompare(String(b.nextAttemptAt ?? "")),
          accept: (j) => workers.has(j.type),
        });
        return await Promise.all(claimed.map(run));
      };

      let timer: ReturnType<typeof setInterval> | null = null;
      let gauges: ReturnType<typeof setInterval> | null = null;
      let busy = false;
      /** Backlog gauges for dashboards and alerts (every 30 s with the worker). */
      const reportBacklog = async () => {
        if (!metrics) return;
        for (const status of ["pending", "failed"]) {
          metrics.gauge("zenith_jobs", (await db.find(JOB_CLASS, { status })).length, { status });
        }
      };

      const traitApi = {
        registerWorker: (jobType: string, handler: (data: any) => unknown | Promise<unknown>) => {
          if (typeof jobType !== "string" || !jobType || typeof handler !== "function") {
            throw new TypeError("registerWorker(type, handler)");
          }
          workers.set(jobType, handler);
        },

        enqueue: async (type: string, data: unknown, opts: EnqueueOptions = {}): Promise<Job> => {
          if (typeof type !== "string" || !type || type.length > 200) {
            throw bad("type: 1 to 200 characters.");
          }
          const maxAttempts = opts.maxAttempts ?? 3;
          if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
            throw bad("maxAttempts: 1 to 100.");
          }
          const delayMs = opts.delayMs ?? 0;
          if (!Number.isFinite(delayMs) || delayMs < 0) throw bad("delayMs: 0 or more.");
          if (opts.idempotencyKey !== undefined) {
            if (typeof opts.idempotencyKey !== "string" || opts.idempotencyKey.length > 200) {
              throw bad("idempotencyKey: up to 200 characters.");
            }
            const [existing] = await db.find(JOB_CLASS, { idempotencyKey: opts.idempotencyKey });
            if (existing) return view(existing);
          }
          const job = await db.create(JOB_CLASS, {
            jobId: crypto.randomUUID(),
            type,
            data: data ?? null,
            status: "pending",
            priority: Number.isFinite(opts.priority) ? opts.priority : 0,
            attempts: 0,
            maxAttempts,
            nextAttemptAt: iso(clock() + delayMs),
            leaseUntil: null,
            ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
          });
          return view(job);
        },

        /** Procesa el siguiente trabajo vencido; `null` si no hay ninguno. */
        processNext: async (): Promise<Job | null> => (await processDue(1))[0] ?? null,
        processDue,

        get: async (jobId: string): Promise<Job | null> => {
          const [j] = await db.find(JOB_CLASS, { jobId });
          return j ? view(j) : null;
        },

        list: async (status?: JobStatus, limit = 100): Promise<Job[]> => {
          const stored = status === "running" ? "pending" : status;
          const rows: Job[] = await db.find(JOB_CLASS, stored ? { status: stored } : {});
          return rows.map(view).filter((j) => !status || j.status === status)
            .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
            .slice(0, limit);
        },

        /** Vuelve a encolar un trabajo fallido (cola de mensajes muertos) con sus intentos a cero. */
        retry: async (jobId: string): Promise<Job> => {
          const [j] = await db.find(JOB_CLASS, { jobId });
          if (!j) throw ZenithErrors.notFound(JOB_CLASS, jobId);
          if (j.status !== "failed") {
            throw bad(`Job ${jobId} is ${j.status}; only failed jobs can be retried.`);
          }
          return view(
            await db.update(JOB_CLASS, { objectId: j.objectId }, {
              status: "pending",
              attempts: 0,
              nextAttemptAt: iso(clock()),
              leaseUntil: null,
            }),
          );
        },

        startBackground() {
          if (timer !== null) return;
          timer = setInterval(async () => {
            if (busy) return;
            busy = true;
            try {
              await processDue();
            } catch (e) {
              console.warn(`[queue] ${(e as Error).message}`);
            } finally {
              busy = false;
            }
          }, options.intervalMs ?? 1000);
          Deno.unrefTimer(timer);
          gauges = setInterval(() => void reportBacklog().catch(() => {}), 30_000);
          Deno.unrefTimer(gauges);
        },
        stopBackground() {
          if (timer !== null) clearInterval(timer);
          if (gauges !== null) clearInterval(gauges);
          timer = gauges = null;
        },
        reportBacklog,
        /** Alias anterior de `startBackground`; devuelve la función para pararlo. */
        startWorker() {
          traitApi.startBackground();
          return () => traitApi.stopBackground();
        },
      };

      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      const queue_routes = [
        {
          method: "POST" as const,
          path: "/queue/enqueue",
          access: "master" as const,
          _openapi: {
            summary:
              "Enqueue a background job: { type, data, priority?, maxAttempts?, delayMs?, idempotencyKey? }",
            tags: ["Queue"],
          },
          handler: async (req: Request) => {
            let b: any;
            try {
              b = await req.json();
            } catch {
              throw bad("Invalid JSON body.");
            }
            return json(
              await traitApi.enqueue(b?.type, b?.data, {
                priority: b?.priority,
                maxAttempts: b?.maxAttempts,
                delayMs: b?.delayMs,
                idempotencyKey: b?.idempotencyKey,
              }),
              201,
            );
          },
        },
        {
          method: "GET" as const,
          path: "/queue/jobs",
          access: "master" as const,
          _openapi: {
            summary: "List jobs (?status=pending|running|completed|failed)",
            tags: ["Queue"],
          },
          handler: async (req: Request) => {
            const status = new URL(req.url).searchParams.get("status") as JobStatus | null;
            if (status && !["pending", "running", "completed", "failed"].includes(status)) {
              throw bad("status: pending, running, completed or failed.");
            }
            return json({ jobs: await traitApi.list(status ?? undefined) });
          },
        },
        {
          method: "POST" as const,
          path: "/queue/jobs/:jobId/retry",
          access: "master" as const,
          _openapi: { summary: "Requeue a failed job (dead-letter)", tags: ["Queue"] },
          handler: async (_req: Request, ctx: any) =>
            json(await traitApi.retry(String(ctx?.params?.jobId ?? ""))),
        },
      ];

      return { "queue-routes": queue_routes, queue: traitApi, jobQueue: traitApi };
    },
  });
}

/**
 * Durable job queue trait: jobs are `_Job` records, so they survive restarts and are shared
 * between instances without duplication; workers register per job type (`/queue/*` routes).
 */
export const JobQueueTrait: AnyTraitDescriptor = createJobQueueTrait();
