/**
 * @module @zenith/traits/cells/local
 *
 * The `local` cells provider (ADR-019): every cell of this process, with the semantics of Cloudflare
 * Durable Objects and celld on a single node.
 *
 * - **One instance per id:** this process is the only writer of its cells' files (`dir`). Two Zenith
 *   processes must not share a `dir`; for several nodes, use the `celld` provider.
 * - **Input gate:** events (fetch, RPC, alarm) reach a cell one at a time, each one on its own
 *   macrotask. Storage calls are synchronous SQLite under a promise, so the code of an event runs
 *   without interleaving until it awaits something that is not storage (as in Cloudflare and celld).
 *   `blockConcurrencyWhile()` (and `storage.transaction()`) close the gate until the callback settles.
 * - **Hibernation:** a cell idle for `hibernateAfterMs` leaves memory and closes its database; the
 *   next event constructs it again from storage.
 * - **Alarms:** one per cell, in the cell's own database and in an index (`_index.sqlite`) that
 *   schedules them; a hibernated cell wakes for its alarm. A failing `alarm()` is retried with
 *   exponential backoff (`alarmRetries`, `alarmRetryBaseMs`).
 * - **Limits:** `maxResidentCells` (the least recently used idle cell hibernates to make room, or the
 *   call fails with `CellError("capacity")`) and `maxStorageBytesPerCell` (a write over it fails with
 *   `CellError("storage_limit")` and is rolled back).
 * - **RPC:** arguments and results are copied with `structuredClone`, as they would cross an isolate.
 */
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers";
import { CellId, CellIdFactory } from "./ids.ts";
import { CellStorage } from "./storage.ts";
import {
  type AlarmInvocationInfo,
  type CellClass,
  type CellEnv,
  CellError,
  type CellHandlers,
  type DurableObjectId,
  type DurableObjectNamespace,
  type DurableObjectState,
  type DurableObjectStub,
  type SqlRow,
} from "./types.ts";

/** Options of the `local` provider. */
export interface LocalCellsOptions {
  /** Directory of the cell databases (one subdirectory per class). */
  dir: string;
  /** Script name: part of the id key, like the Worker name in celld (default `"zenith"`). */
  scriptName?: string;
  /** Most cells in memory at once (default 1000). */
  maxResidentCells?: number;
  /** Largest database of one cell in bytes (default 256 MiB; `0`: no limit). */
  maxStorageBytesPerCell?: number;
  /** Idle time before a cell hibernates, in ms (default 60 000; `0`: never). */
  hibernateAfterMs?: number;
  /** Upper bound of `blockConcurrencyWhile()` and `transaction()`, in ms (default 30 000). */
  blockTimeoutMs?: number;
  /** Retries of a failing alarm (default 6). */
  alarmRetries?: number;
  /** First retry delay of a failing alarm, doubled each time (default 2000 ms). */
  alarmRetryBaseMs?: number;
  /** Variables every cell receives in `env`. */
  vars?: Record<string, unknown>;
}

/** How a cell class is registered. */
export interface CellClassOptions {
  /** Name of its namespace in `env` (default: the class name). */
  binding?: string;
  /** Extra bindings only this class receives. */
  env?: CellEnv;
}

/** A snapshot of the provider. */
export interface CellsStats {
  /** `"local"`. */
  provider: "local";
  /** Registered classes and their bindings. */
  classes: Array<{ className: string; binding: string }>;
  /** Cells in memory. */
  resident: number;
  /** Cells constructed since start. */
  activations: number;
  /** Cells that left memory since start. */
  hibernations: number;
  /** Alarms pending. */
  alarms: number;
}

type EventFn = (host: Host) => unknown;
interface Item {
  fn: EventFn;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface ClassEntry {
  className: string;
  binding: string;
  cls: CellClass<CellHandlers & Record<string, unknown>>;
  env: CellEnv;
  ids: CellIdFactory;
  ns: DurableObjectNamespace;
}

const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const NOT_RPC = new Set(["constructor", "fetch", "alarm", "then", "webSocketMessage"]);

/** One resident cell. */
class Host {
  readonly key: string;
  readonly entry: ClassEntry;
  readonly id: CellId;
  readonly storage: CellStorage;
  instance: (CellHandlers & Record<string, unknown>) | null = null;
  readonly queue: Item[] = [];
  readonly waits = new Set<Promise<unknown>>();
  inflight = 0;
  gate = 0;
  scheduled = false;
  closed = false;
  lastActive = Date.now();
  constructor(key: string, entry: ClassEntry, id: CellId, storage: CellStorage) {
    this.key = key;
    this.entry = entry;
    this.id = id;
    this.storage = storage;
  }
  get idle(): boolean {
    return this.inflight === 0 && this.queue.length === 0 && this.gate === 0 &&
      this.waits.size === 0;
  }
}

/** The `local` provider. Create it with `new LocalCellsProvider({ dir })`; `close()` when done. */
export class LocalCellsProvider {
  /** Provider kind. */
  readonly kind = "local" as const;
  readonly #o: Required<Omit<LocalCellsOptions, "vars">> & { vars: Record<string, unknown> };
  readonly #classes = new Map<string, ClassEntry>();
  readonly #bindings = new Map<string, ClassEntry>();
  readonly #resident = new Map<string, Host>();
  #index: DatabaseSync | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sweeper: ReturnType<typeof setInterval> | null = null;
  readonly #firing = new Set<string>();
  #activations = 0;
  #hibernations = 0;
  #closed = false;

  /** A provider over `options.dir`. Nothing touches the disk until the first cell runs. */
  constructor(options: LocalCellsOptions) {
    if (!options?.dir) throw new CellError("bad_request", "the local cells provider needs a dir");
    this.#o = {
      dir: options.dir,
      scriptName: options.scriptName ?? "zenith",
      maxResidentCells: options.maxResidentCells ?? 1000,
      maxStorageBytesPerCell: options.maxStorageBytesPerCell ?? 256 * 1024 * 1024,
      hibernateAfterMs: options.hibernateAfterMs ?? 60_000,
      blockTimeoutMs: options.blockTimeoutMs ?? 30_000,
      alarmRetries: options.alarmRetries ?? 6,
      alarmRetryBaseMs: options.alarmRetryBaseMs ?? 2000,
      vars: options.vars ?? {}, // kept by reference: the caller may add bindings later
    };
  }

  /** Registers a cell class and returns its namespace. Registering the same name again replaces it. */
  define<T extends object>(
    className: string,
    cls: CellClass<T>,
    options: CellClassOptions = {},
  ): DurableObjectNamespace<T> {
    this.#open();
    if (!CLASS_NAME.test(className)) {
      throw new CellError("bad_request", `invalid cell class name "${className}"`);
    }
    if (typeof cls !== "function") throw new CellError("bad_request", "a cell class is a class");
    const binding = options.binding ?? className;
    const other = this.#bindings.get(binding);
    if (other && other.className !== className) {
      throw new CellError("bad_request", `binding "${binding}" is already ${other.className}`);
    }
    const prev = this.#classes.get(className);
    if (prev && prev.binding !== binding) this.#bindings.delete(prev.binding);
    const ids = prev?.ids ?? new CellIdFactory(this.#o.scriptName, className);
    const entry = {
      className,
      binding,
      cls: cls as unknown as ClassEntry["cls"],
      env: { ...(options.env ?? {}) },
      ids,
      ns: prev?.ns ?? this.#namespace(className, ids),
    };
    this.#classes.set(className, entry);
    this.#bindings.set(binding, entry);
    this.#ensureStarted();
    this.#armTimer();
    return entry.ns as DurableObjectNamespace<T>;
  }

  /** The namespace of a binding or class name; throws `CellError("not_found")` if unknown. */
  namespace<T = unknown>(bindingOrClass: string): DurableObjectNamespace<T> {
    const e = this.#bindings.get(bindingOrClass) ?? this.#classes.get(bindingOrClass);
    if (!e) throw new CellError("not_found", `no cell class or binding "${bindingOrClass}"`);
    return e.ns as DurableObjectNamespace<T>;
  }

  /** Whether a binding or class is registered. */
  has(bindingOrClass: string): boolean {
    return this.#bindings.has(bindingOrClass) || this.#classes.has(bindingOrClass);
  }

  /** The `env` a cell of `className` receives: every namespace, the variables and its extras. */
  env(className?: string): CellEnv {
    const env: CellEnv = { ...this.#o.vars };
    for (const [b, e] of this.#bindings) env[b] = e.ns;
    if (className) Object.assign(env, this.#classes.get(className)?.env ?? {});
    return env;
  }

  /** Counters for the admin API and the tests. */
  stats(): CellsStats {
    return {
      provider: "local",
      classes: [...this.#classes.values()].map((e) => ({
        className: e.className,
        binding: e.binding,
      })),
      resident: this.#resident.size,
      activations: this.#activations,
      hibernations: this.#hibernations,
      alarms: this.#index
        ? Number((this.#index.prepare("SELECT count(*) AS n FROM alarms").get() as SqlRow).n)
        : 0,
    };
  }

  /** The cells of a class that exist on disk (activated at least once), with their names. */
  list(className: string): Array<{ id: string; name: string | null }> {
    this.#ensureStarted();
    return (this.#index!.prepare("SELECT id, name FROM cells WHERE cls = ? ORDER BY id")
      .all(className) as SqlRow[]).map((r) => ({
        id: String(r.id),
        name: r.name === null ? null : String(r.name),
      }));
  }

  /** Whether the cell is in memory. */
  isResident(className: string, id: DurableObjectId | string): boolean {
    return this.#resident.has(`${className}:${String(id)}`);
  }

  /** Hibernates one cell now if it is idle; whether it did. */
  hibernate(className: string, id: DurableObjectId | string): boolean {
    const h = this.#resident.get(`${className}:${String(id)}`);
    if (!h || !h.idle) return false;
    this.#evict(h);
    return true;
  }

  /** Hibernates every cell idle for at least `idleMs` (default: the configured time); how many. */
  hibernateIdle(idleMs: number = this.#o.hibernateAfterMs): number {
    const now = Date.now();
    let n = 0;
    for (const h of [...this.#resident.values()]) {
      if (h.idle && now - h.lastActive >= idleMs) {
        this.#evict(h);
        n++;
      }
    }
    return n;
  }

  /** Hibernates every cell, stops the timers and closes the index. Pending events fail. */
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#timer = this.#sweeper = null;
    for (const h of [...this.#resident.values()]) {
      for (const it of h.queue.splice(0)) {
        it.reject(new CellError("closed", "the cells provider closed"));
      }
      this.#evict(h);
    }
    this.#index?.close();
    this.#index = null;
    return Promise.resolve();
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  #open(): void {
    if (this.#closed) throw new CellError("closed", "the cells provider is closed");
  }

  #ensureStarted(): void {
    this.#open();
    if (this.#index) return;
    Deno.mkdirSync(this.#o.dir, { recursive: true });
    const db = new DatabaseSync(`${this.#o.dir}/_index.sqlite`);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;" +
        "CREATE TABLE IF NOT EXISTS alarms (cls TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL," +
        " retry INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cls, id)) WITHOUT ROWID;" +
        "CREATE TABLE IF NOT EXISTS cells (cls TEXT NOT NULL, id TEXT NOT NULL, name TEXT," +
        " created INTEGER NOT NULL, PRIMARY KEY (cls, id)) WITHOUT ROWID;",
    );
    this.#index = db;
    const hib = this.#o.hibernateAfterMs;
    if (hib > 0) {
      this.#sweeper = setInterval(() => this.hibernateIdle(), Math.max(50, Math.min(hib, 5000)));
      Deno.unrefTimer(this.#sweeper as unknown as number);
    }
    this.#armTimer();
  }

  #namespace(className: string, ids: CellIdFactory): DurableObjectNamespace {
    const check = (id: DurableObjectId): CellId => {
      if (!(id instanceof CellId)) {
        throw new TypeError("Durable Object ID is not valid for this namespace");
      }
      return ids.fromString(id.toString(), id.name);
    };
    return {
      idFromName: (name) => ids.fromName(name),
      idFromString: (hex) => ids.fromString(hex),
      newUniqueId: (options) => {
        if (options?.jurisdiction != null) {
          throw new CellError("unsupported", "Jurisdiction restrictions are not implemented");
        }
        return ids.unique();
      },
      get: (id) => this.#stub(className, check(id)),
      getByName: (name) => this.#stub(className, ids.fromName(name)),
    };
  }

  #stub(className: string, id: CellId): DurableObjectStub {
    const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = new Request(input instanceof URL ? input.href : input, init);
      return this.#deliver(className, id, (h) => {
        const f = h.instance?.fetch;
        if (typeof f !== "function") {
          throw new CellError("unsupported", `${className} has no fetch() handler`);
        }
        return f.call(h.instance, req);
      }) as Promise<Response>;
    };
    const base = { id, name: id.name, fetch };
    return new Proxy(base, {
      get: (t, p) => {
        if (typeof p === "symbol") return undefined;
        if (p in t) return t[p as keyof typeof t];
        if (NOT_RPC.has(p)) return undefined;
        return (...args: unknown[]) => this.#rpc(className, id, p, args);
      },
    }) as DurableObjectStub;
  }

  async #rpc(className: string, id: CellId, method: string, args: unknown[]): Promise<unknown> {
    let copy: unknown[];
    try {
      copy = structuredClone(args);
    } catch (e) {
      throw new CellError(
        "bad_request",
        `RPC arguments must be cloneable: ${(e as Error).message}`,
      );
    }
    const r = await this.#deliver(className, id, (h) => {
      const inst = h.instance as Record<string, unknown>;
      const fn = inst[method];
      if (
        method.startsWith("_") || typeof fn !== "function" ||
        (Object.prototype as unknown as Record<string, unknown>)[method] === fn
      ) {
        throw new TypeError(`The RPC receiver does not implement the method "${method}".`);
      }
      return (fn as (...a: unknown[]) => unknown).apply(inst, copy);
    });
    try {
      return structuredClone(r);
    } catch (e) {
      throw new CellError("bad_request", `RPC results must be cloneable: ${(e as Error).message}`);
    }
  }

  /** Queues `fn` on the cell, activating it if needed. */
  #deliver(className: string, id: CellId, fn: EventFn): Promise<unknown> {
    return new Promise((resolve, reject) => {
      try {
        const h = this.#host(className, id);
        h.queue.push({ fn, resolve, reject });
        this.#schedule(h);
      } catch (e) {
        reject(e);
      }
    });
  }

  #schedule(h: Host): void {
    if (h.scheduled || h.closed) return;
    h.scheduled = true;
    setImmediate(() => this.#pump(h));
  }

  /** Starts the next event of `h`: one per macrotask, so earlier events finish their sync part. */
  #pump(h: Host): void {
    h.scheduled = false;
    if (h.closed) {
      this.#requeue(h);
      return;
    }
    if (h.gate > 0 || h.queue.length === 0) return;
    const it = h.queue.shift()!;
    h.inflight++;
    h.lastActive = Date.now();
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(it.fn(h));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(it.resolve, it.reject).finally(() => {
      h.inflight--;
      h.lastActive = Date.now();
      if (h.queue.length) this.#schedule(h);
    });
    if (h.queue.length) this.#schedule(h);
  }

  /** Events queued on a host that was reset go to a fresh instance. */
  #requeue(h: Host): void {
    const items = h.queue.splice(0);
    for (const it of items) {
      if (this.#closed) {
        it.reject(new CellError("closed", "the cells provider closed"));
        continue;
      }
      this.#deliver(h.entry.className, h.id, it.fn).then(it.resolve, it.reject);
    }
  }

  /** The resident host of a cell, constructing it when it is not in memory. */
  #host(className: string, id: CellId): Host {
    this.#open();
    const key = `${className}:${id.toString()}`;
    const found = this.#resident.get(key);
    if (found) return found;
    const entry = this.#classes.get(className);
    if (!entry) throw new CellError("not_found", `no cell class "${className}"`);
    this.#ensureStarted();
    if (this.#resident.size >= this.#o.maxResidentCells) this.#makeRoom();
    const dir = `${this.#o.dir}/${className}`;
    Deno.mkdirSync(dir, { recursive: true });
    let host: Host | null = null;
    const storage = new CellStorage(`${dir}/${id.toString()}.sqlite`, {
      onAlarm: (at) => this.#alarmChanged(className, id.toString(), at),
      block: (fn) => this.#block(host!, fn),
    }, { maxBytes: this.#o.maxStorageBytesPerCell });
    host = new Host(key, entry, id, storage);
    try {
      if (id.name !== undefined && storage.meta("name") === undefined) {
        storage.setMeta("name", id.name);
      }
      this.#index!.prepare(
        "INSERT INTO cells (cls, id, name, created) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(cls, id) DO UPDATE SET name = coalesce(excluded.name, cells.name)",
      ).run(className, id.toString(), id.name ?? null, Date.now());
      this.#resident.set(key, host);
      this.#activations++;
      const name = id.name ?? (storage.meta("name") as string | undefined);
      const ctxId = name !== undefined && id.name === undefined
        ? new CellId(id.toString(), name)
        : id;
      host.instance = new entry.cls(this.#state(host, ctxId), this.env(className));
    } catch (e) {
      this.#resident.delete(key);
      host.closed = true;
      storage.close();
      throw e;
    }
    return host;
  }

  #makeRoom(): void {
    let lru: Host | null = null;
    for (const h of this.#resident.values()) {
      if (h.idle && (!lru || h.lastActive < lru.lastActive)) lru = h;
    }
    if (!lru) {
      throw new CellError(
        "capacity",
        `too many resident cells (${this.#o.maxResidentCells}) and none is idle`,
      );
    }
    this.#evict(lru);
  }

  #state(h: Host, id: CellId): DurableObjectState {
    return {
      id,
      storage: h.storage,
      blockConcurrencyWhile: (cb) => this.#block(h, cb),
      waitUntil: (p) => {
        const w = Promise.resolve(p).catch(() => {});
        h.waits.add(w);
        w.finally(() => {
          h.waits.delete(w);
          h.lastActive = Date.now();
        });
      },
      abort: (reason) => this.#reset(h, reason ?? "aborted"),
    };
  }

  async #block<T>(h: Host, cb: () => Promise<T>): Promise<T> {
    h.gate++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(cb),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new CellError(
                "timeout",
                `blockConcurrencyWhile() exceeded ${this.#o.blockTimeoutMs} ms; the cell was reset`,
              ),
            );
            this.#reset(h, "blockConcurrencyWhile() timeout");
          }, this.#o.blockTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      h.gate--;
      if (!h.closed) this.#schedule(h);
    }
  }

  /** Drops the instance (storage stays) and sends queued events to a new one. */
  #reset(h: Host, _reason: string): void {
    if (h.closed) return;
    this.#evict(h);
    this.#requeue(h);
  }

  #evict(h: Host): void {
    if (h.closed) return;
    h.closed = true;
    this.#resident.delete(h.key);
    this.#hibernations++;
    h.instance = null;
    h.storage.close();
  }

  // ── Alarms ────────────────────────────────────────────────────────────────────

  #alarmChanged(cls: string, id: string, at: number | null): void {
    if (!this.#index) return;
    if (at === null) {
      this.#index.prepare("DELETE FROM alarms WHERE cls = ? AND id = ?").run(cls, id);
    } else {
      this.#index.prepare(
        "INSERT INTO alarms (cls, id, at, retry) VALUES (?, ?, ?, 0) " +
          "ON CONFLICT(cls, id) DO UPDATE SET at = excluded.at, retry = 0",
      ).run(cls, id, at);
    }
    this.#armTimer();
  }

  #armTimer(): void {
    if (!this.#index || this.#closed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    // The earliest alarm of a registered class that is not already firing.
    const rows = this.#index.prepare("SELECT cls, id, at FROM alarms ORDER BY at LIMIT 1000")
      .all() as SqlRow[];
    const next = rows.find((r) =>
      this.#classes.has(String(r.cls)) && !this.#firing.has(`${r.cls}:${r.id}`)
    );
    if (!next) return;
    const delay = Math.min(Math.max(0, Number(next.at) - Date.now()), 2 ** 31 - 1);
    this.#timer = setTimeout(() => this.#fireDue(), delay);
  }

  #fireDue(): void {
    this.#timer = null;
    if (!this.#index || this.#closed) return;
    const due = this.#index.prepare(
      "SELECT cls, id, retry FROM alarms WHERE at <= ? ORDER BY at",
    ).all(Date.now()) as SqlRow[];
    for (const row of due) {
      const cls = String(row.cls), hex = String(row.id), key = `${cls}:${hex}`;
      const entry = this.#classes.get(cls);
      if (!entry || this.#firing.has(key)) continue;
      let id: CellId;
      try {
        id = entry.ids.fromString(hex);
      } catch {
        this.#index.prepare("DELETE FROM alarms WHERE cls = ? AND id = ?").run(cls, hex);
        continue;
      }
      this.#firing.add(key);
      this.#deliver(cls, id, (h) => this.#runAlarm(h, Number(row.retry)))
        .catch((e) => console.error(`[cells] alarm of ${cls} ${hex} failed:`, e))
        .finally(() => {
          this.#firing.delete(key);
          this.#armTimer();
        });
    }
    this.#armTimer();
  }

  async #runAlarm(h: Host, retry: number): Promise<void> {
    const at = h.storage.alarmSync();
    if (at === null || at > Date.now()) {
      this.#alarmChanged(h.entry.className, h.id.toString(), at);
      return;
    }
    h.storage.setAlarmSync(null);
    const info: AlarmInvocationInfo = { retryCount: retry, isRetry: retry > 0 };
    try {
      await h.instance?.alarm?.(info);
    } catch (e) {
      if (h.closed || h.storage.alarmSync() !== null) throw e;
      if (retry + 1 > this.#o.alarmRetries) {
        console.error(
          `[cells] alarm of ${h.entry.className} ${h.id} gave up after ${retry + 1} attempts`,
        );
        throw e;
      }
      // Retried later: the failure is the cell's, not the runtime's, so it is not reported here.
      h.storage.setAlarmSync(Date.now() + this.#o.alarmRetryBaseMs * 2 ** retry);
      this.#index?.prepare("UPDATE alarms SET retry = ? WHERE cls = ? AND id = ?")
        .run(retry + 1, h.entry.className, h.id.toString());
    }
  }
}
