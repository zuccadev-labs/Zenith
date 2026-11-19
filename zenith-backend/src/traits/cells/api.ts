/**
 * @module @zenith/traits/cells/api
 *
 * The `cells` capability: one object that registers cell classes and hands out their namespaces, on
 * the provider `config.cells.provider` selects (`local` by default; `celld` is experimental). Class
 * registrations are kept, so `configure()` can switch the provider after composition (mod.ts does it
 * with the app's config) and they are applied again.
 */
import { CelldCellsClient } from "./celld.ts";
import { KV_CELL_CLASS, type KVNamespace, kvNamespace, ZenithKVCell } from "./kv.ts";
import { type CellClassOptions, type CellsStats, LocalCellsProvider } from "./local.ts";
import {
  type JobQueueLike,
  type Queue,
  queueBinding,
  type QueueConsumer,
  registerQueueConsumer,
} from "./queue.ts";
import {
  cellDefinitions,
  type CellsHandle,
  onCellDefinition,
  registerCellsApp,
  unregisterCellsApp,
} from "./registry.ts";
import { type CellClass, type CellEnv, CellError, type DurableObjectNamespace } from "./types.ts";

/** `config.cells`. */
export interface CellsConfig {
  /** `local` (default) or `celld` (experimental: needs `celld.experimental: true`). */
  readonly provider?: "local" | "celld";
  /** Directory of the local provider (default `ZENITH_CELLS_DIR`, else `.zenith/cells`, plus the app id). */
  readonly dir?: string;
  /** Most cells in memory (local; default 1000). */
  readonly maxResidentCells?: number;
  /** Largest database of one cell in bytes (local; default 256 MiB). */
  readonly maxStorageBytesPerCell?: number;
  /** Idle time before hibernation in ms (local; default 60 000). */
  readonly hibernateAfterMs?: number;
  /** Upper bound of `blockConcurrencyWhile()` in ms (local; default 30 000). */
  readonly blockTimeoutMs?: number;
  /** Retries of a failing alarm (local; default 6). */
  readonly alarmRetries?: number;
  /** First retry delay of a failing alarm in ms (local; default 2000). */
  readonly alarmRetryBaseMs?: number;
  /** Variables every cell receives in `env`. */
  readonly vars?: Record<string, unknown>;
  /** KV namespace bindings to create (local), each one backed by a cell. */
  readonly kv?: readonly string[];
  /** Queue producer bindings to create (local), over the `queue` capability. */
  readonly queues?: readonly string[];
  /** The celld deployment (provider `celld`). */
  readonly celld?: {
    /** Worker listener (or ingress) URL of the fleet. */
    readonly url: string;
    /** Bearer token (prefer `tokenEnv`). */
    readonly token?: string;
    /** Environment variable that holds the token (default `ZENITH_CELLS_TOKEN`). */
    readonly tokenEnv?: string;
    /** Must be `true`: the celld provider is experimental (ADR-019). */
    readonly experimental: boolean;
  };
}

/** What the `cells` capability gives other traits and Cloud Code. */
export interface CellsApi extends CellsHandle {
  /** Applies `config.cells` (closes the previous provider; class registrations stay). */
  configure(config: CellsConfig & { appId?: string }): void;
  /** The active provider kind. */
  readonly provider: "local" | "celld";
  /** Starts the provider now (the local one arms the pending alarms). Otherwise it starts on first use. */
  start(): void;
  /** Registers a cell class and returns its namespace (lazy: nothing starts until it is used). */
  define<T extends object>(
    className: string,
    cls: CellClass<T>,
    options?: CellClassOptions,
  ): DurableObjectNamespace<T>;
  /** The namespace of a binding or class name. */
  namespace<T = unknown>(binding: string): DurableObjectNamespace<T>;
  /** The env cells receive (namespaces, KV, queues, variables). */
  env(className?: string): CellEnv;
  /** A KV namespace binding (local provider). */
  kv(binding: string): KVNamespace;
  /** A Queue producer binding (needs the `queue` capability). */
  queue<Body = unknown>(binding: string): Queue<Body>;
  /** Registers the consumer of a queue (needs the `queue` capability). */
  consume<Body = unknown>(queue: string, consumer: QueueConsumer<Body>): void;
  /** Counters of the provider. */
  stats(): CellsStats | { provider: "celld"; url: string; classes: string[] };
  /** The local provider, when it is the active one (admin, tests). */
  local(): LocalCellsProvider | null;
  /** Closes the provider. */
  close(): Promise<void>;
}

/** Dependencies of `createCellsApi`. */
export interface CellsDeps {
  /** The job queue for Queue bindings, when the `queue` capability is there. */
  jobs?: () => JobQueueLike | undefined;
}

const defaultDir = (appId: string) =>
  `${Deno.env.get("ZENITH_CELLS_DIR") ?? ".zenith/cells"}/${appId.replace(/[^\w.-]/g, "_")}`;

/** Creates the `cells` capability. Nothing touches the disk until a cell runs. */
export function createCellsApi(
  initial: CellsConfig & { appId?: string } = {},
  deps: CellsDeps = {},
): CellsApi {
  let config: CellsConfig & { appId?: string } = initial;
  let appId = initial.appId ?? "zenith";
  const defs = new Map<string, { cls: CellClass; options: CellClassOptions }>();
  let local: LocalCellsProvider | null = null;
  let remote: CelldCellsClient | null = null;
  const queues = new Map<string, Queue>();

  const jobs = () => {
    const j = deps.jobs?.();
    if (!j) throw new CellError("unsupported", "Queue bindings need the queue feature");
    return j;
  };

  const kind = () => config.provider ?? "local";

  const localProvider = (): LocalCellsProvider => {
    if (local) return local;
    const vars: Record<string, unknown> = { ...(config.vars ?? {}) };
    const p = new LocalCellsProvider({
      dir: config.dir ?? defaultDir(appId),
      scriptName: appId,
      maxResidentCells: config.maxResidentCells,
      maxStorageBytesPerCell: config.maxStorageBytesPerCell,
      hibernateAfterMs: config.hibernateAfterMs,
      blockTimeoutMs: config.blockTimeoutMs,
      alarmRetries: config.alarmRetries,
      alarmRetryBaseMs: config.alarmRetryBaseMs,
      vars,
    });
    if (config.kv?.length) {
      const ns = p.define(KV_CELL_CLASS, ZenithKVCell, { binding: `__${KV_CELL_CLASS}` });
      for (const name of config.kv) vars[name] = kvNamespace(ns, name);
    }
    for (const name of config.queues ?? []) vars[name] = api.queue(name);
    // The vars object is shared with the provider, so the bindings above are in every env.
    for (const [className, d] of defs) p.define(className, d.cls, d.options);
    local = p;
    return p;
  };

  const celld = (): CelldCellsClient => {
    if (remote) return remote;
    const c = config.celld;
    if (!c?.experimental) {
      throw new CellError(
        "unsupported",
        "the celld provider is experimental: set cells.celld.experimental = true (ADR-019)",
      );
    }
    const token = c.token ?? Deno.env.get(c.tokenEnv ?? "ZENITH_CELLS_TOKEN");
    if (!token) throw new CellError("bad_request", "cells.celld needs a token (tokenEnv)");
    remote = new CelldCellsClient({ url: c.url, token });
    return remote;
  };

  const api: CellsApi = {
    configure(c) {
      const old = local;
      local = null;
      remote = null;
      queues.clear();
      old?.close();
      unregisterCellsApp(appId, api);
      config = c;
      if (c.appId) appId = c.appId;
      registerCellsApp(appId, api);
      if (kind() === "celld") celld(); // fail at boot, not at the first call
    },
    get provider() {
      return kind();
    },
    define<T extends object>(className: string, cls: CellClass<T>, options: CellClassOptions = {}) {
      defs.set(className, { cls: cls as CellClass, options });
      if (local) local.define(className, cls, options);
      // Lazy: registering a class touches no disk and opens no connection.
      const binding = options.binding ?? className;
      const ns = () => api.namespace<T>(binding);
      return {
        idFromName: (name) => ns().idFromName(name),
        idFromString: (id) => ns().idFromString(id),
        newUniqueId: (o) => ns().newUniqueId(o),
        get: (id) => ns().get(id),
        getByName: (name) => ns().getByName(name),
      } as DurableObjectNamespace<T>;
    },
    start() {
      if (kind() === "celld") celld();
      else localProvider();
    },
    namespace(binding) {
      if (kind() === "celld") return celld().namespace(binding);
      return localProvider().namespace(binding);
    },
    env(className) {
      if (kind() === "celld") {
        const env: CellEnv = { ...(config.vars ?? {}) };
        for (const [name, d] of defs) {
          const b = d.options.binding ?? name;
          env[b] = celld().namespace(b);
        }
        return env;
      }
      return localProvider().env(className);
    },
    kv(binding) {
      if (kind() === "celld") {
        throw new CellError("unsupported", "KV bindings over celld are not wired yet (ADR-019)");
      }
      const v = localProvider().env()[binding];
      if (!v) throw new CellError("not_found", `no KV binding "${binding}" (cells.kv)`);
      return v as KVNamespace;
    },
    queue<Body = unknown>(binding: string) {
      let q = queues.get(binding);
      if (!q) {
        q = queueBinding(jobs(), binding);
        queues.set(binding, q);
      }
      return q as Queue<Body>;
    },
    consume(queue, consumer) {
      registerQueueConsumer(jobs(), queue, consumer as QueueConsumer, () => api.env());
    },
    stats() {
      if (kind() === "celld") {
        return { provider: "celld", url: config.celld!.url, classes: [...defs.keys()] };
      }
      return localProvider().stats();
    },
    local: () => (kind() === "local" ? localProvider() : null),
    async close() {
      off();
      unregisterCellsApp(appId, api);
      const p = local;
      local = null;
      await p?.close();
    },
  };

  // Cloud Code classes: the ones declared already and the ones to come.
  for (const d of cellDefinitions()) defs.set(d.className, { cls: d.cls, options: d.options });
  const off = onCellDefinition((d) => {
    defs.set(d.className, { cls: d.cls, options: d.options });
    if (local) local.define(d.className, d.cls, d.options);
  });
  registerCellsApp(appId, api);
  return api;
}
