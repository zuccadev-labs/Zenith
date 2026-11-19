/**
 * @module @zenith/traits/cells/storage
 *
 * The storage of one cell on the `local` provider: one SQLite file per cell (`node:sqlite`, no extra
 * dependency), as celld and Cloudflare keep one SQLite database per object.
 *
 * - **Key-value API:** table `_cf_KV` (the name Cloudflare uses), values serialized with V8's
 *   structured serialization (`node:v8`), so `Map`, `Date`, typed arrays… round-trip.
 * - **SQL API:** `sql.exec()` over the same database.
 * - **Alarm:** in `_zc_meta`, transactional with the data; the provider is told of every change so it
 *   can schedule it.
 * - **Limits:** `PRAGMA max_page_count` caps the file: a write that would exceed it fails atomically
 *   with `CellError("storage_limit")`.
 * - **Durability:** WAL with `synchronous=FULL`: a write is on disk when the call returns, so the
 *   output gate of Cloudflare/celld has nothing to wait for here.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import {
  CellError,
  type CellValue,
  type DurableObjectListOptions,
  type DurableObjectStorage,
  type DurableObjectTransaction,
  type SqlRow,
  type SqlStorage,
  type SqlStorageCursor,
  type SqlStorageValue,
  type SyncKvStorage,
} from "./types.ts";

/** Longest key, in UTF-8 bytes (as Cloudflare). */
export const MAX_KEY_BYTES = 2048;
/** Largest serialized value (SQLite-backed Durable Objects allow 2 MB per entry). */
export const MAX_VALUE_BYTES = 2 * 1024 * 1024;

const enc = new TextEncoder();
const RESERVED = /^(_cf_|_zc_|sqlite_)/i;

/** What the storage needs from the cell that owns it. */
export interface CellStorageHooks {
  /** The alarm changed (after commit); `null` when removed. */
  onAlarm(at: number | null): void;
  /** Runs `fn` with the input gate closed (`blockConcurrencyWhile`). */
  block<T>(fn: () => Promise<T>): Promise<T>;
}

/** Options of a cell database. */
export interface CellStorageOptions {
  /** Upper bound of the database file in bytes (`0`: no limit). */
  maxBytes?: number;
}

function limitError(e: unknown): unknown {
  const m = (e as Error)?.message ?? "";
  if (/database or disk is full/i.test(m)) {
    return new CellError("storage_limit", "cell storage limit exceeded; the write was rolled back");
  }
  return e;
}

/** The cursor of `sql.exec()`: rows are read eagerly, so it never holds the database. */
class Cursor<T extends SqlRow> implements SqlStorageCursor<T> {
  #rows: T[];
  #i = 0;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  constructor(rows: T[], columns: string[], written: number) {
    this.#rows = rows;
    this.columnNames = columns;
    this.rowsRead = rows.length;
    this.rowsWritten = written;
  }
  next(): IteratorResult<T> {
    return this.#i < this.#rows.length
      ? { done: false, value: this.#rows[this.#i++] }
      : { done: true, value: undefined };
  }
  [Symbol.iterator](): Iterator<T> {
    return this;
  }
  toArray(): T[] {
    const rest = this.#rows.slice(this.#i);
    this.#i = this.#rows.length;
    return rest;
  }
  one(): T {
    const rest = this.toArray();
    if (rest.length !== 1) {
      throw new Error(`Expected exactly one result from SQL query, but got ${rest.length}.`);
    }
    return rest[0];
  }
  *raw(): IterableIterator<SqlStorageValue[]> {
    for (const row of this.toArray()) yield this.columnNames.map((c) => row[c]);
  }
}

/** The storage of one cell. Open while the cell is resident; `close()` on hibernation. */
export class CellStorage implements DurableObjectStorage {
  readonly #db: DatabaseSync;
  readonly #hooks: CellStorageHooks;
  #savepoint = 0;
  /** SQLite dropped the enclosing transaction (SQLITE_FULL): writes fail until it ends. */
  #aborted = false;
  #closed = false;
  #stmts = new Map<string, StatementSync>();
  /** `ctx.storage.sql`. */
  readonly sql: SqlStorage;
  /** `ctx.storage.kv`. */
  readonly kv: SyncKvStorage;

  /** Opens (or creates) the database at `path`. */
  constructor(path: string, hooks: CellStorageHooks, options: CellStorageOptions = {}) {
    this.#db = new DatabaseSync(path);
    this.#hooks = hooks;
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;" +
        "CREATE TABLE IF NOT EXISTS _zc_meta (k TEXT PRIMARY KEY, v) WITHOUT ROWID;",
    );
    if (options.maxBytes && options.maxBytes > 0) {
      const page = Number((this.#db.prepare("PRAGMA page_size").get() as SqlRow).page_size);
      this.#db.exec(`PRAGMA max_page_count=${Math.max(8, Math.floor(options.maxBytes / page))}`);
    }
    const size = () => this.databaseSize;
    this.sql = {
      exec: <T extends SqlRow = SqlRow>(query: string, ...bindings: unknown[]) =>
        this.#exec<T>(query, bindings),
      get databaseSize() {
        return size();
      },
    };
    this.kv = {
      get: <T = CellValue>(key: string) => this.#get(key) as T | undefined,
      put: <T = CellValue>(key: string, value: T) => this.#write(() => this.#put(key, value)),
      delete: (key: string) => this.#write(() => this.#delete(key)),
      list: <T = CellValue>(o?: DurableObjectListOptions) => this.#list(o) as Map<string, T>,
    };
  }

  /** Size of the database in bytes. */
  get databaseSize(): number {
    const r = this.#db.prepare(
      "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()",
    ).get() as SqlRow;
    return Number(r.n);
  }

  /** Closes the database (the cell hibernated or was reset). Later calls throw. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stmts.clear();
    this.#db.close();
  }

  #check(): void {
    if (this.#closed) throw new CellError("closed", "the storage of this cell is closed");
  }

  #stmt(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.#db.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  /**
   * Ends savepoint `sp`. SQLite rolls back the whole transaction by itself on SQLITE_FULL; then there
   * is nothing to end, and committing would be wrong, so that case throws the limit error.
   */
  #end(sp: string, rollback: boolean): void {
    if (!this.#db.isTransaction) {
      if (this.#savepoint > 1) this.#aborted = true;
      if (rollback) return;
      throw new CellError(
        "storage_limit",
        "cell storage limit exceeded; the transaction was rolled back",
      );
    }
    this.#db.exec(rollback ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : `RELEASE ${sp}`);
  }

  /** Runs `fn` atomically (a savepoint, so it nests inside transactions). */
  #write<T>(fn: () => T): T {
    this.#check();
    if (this.#aborted) {
      throw new CellError("storage_limit", "the transaction was rolled back by the storage limit");
    }
    const sp = `zc_w${++this.#savepoint}`;
    this.#db.exec(`SAVEPOINT ${sp}`);
    try {
      const r = fn();
      this.#end(sp, false);
      return r;
    } catch (e) {
      this.#end(sp, true);
      throw limitError(e);
    } finally {
      if (--this.#savepoint === 0) this.#aborted = false;
    }
  }

  #key(key: string): string {
    if (typeof key !== "string") throw new TypeError("storage keys must be strings");
    if (enc.encode(key).length > MAX_KEY_BYTES) {
      throw new RangeError(`Keys cannot be larger than ${MAX_KEY_BYTES} bytes.`);
    }
    return key;
  }

  #get(key: string): CellValue | undefined {
    this.#check();
    const r = this.#stmt("SELECT value FROM _cf_KV WHERE key = ?").get(this.#key(key)) as
      | SqlRow
      | undefined;
    return r ? deserialize(r.value as Uint8Array) : undefined;
  }

  #put(key: string, value: unknown): void {
    if (value === undefined) throw new TypeError("storage values cannot be undefined");
    const bytes = serialize(value);
    if (bytes.length > MAX_VALUE_BYTES) {
      throw new RangeError(`Values cannot be larger than ${MAX_VALUE_BYTES} bytes.`);
    }
    this.#stmt(
      "INSERT INTO _cf_KV (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(this.#key(key), bytes);
  }

  #delete(key: string): boolean {
    return Number(this.#stmt("DELETE FROM _cf_KV WHERE key = ?").run(this.#key(key)).changes) > 0;
  }

  #list(o: DurableObjectListOptions = {}): Map<string, CellValue> {
    this.#check();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.startAfter !== undefined) {
      where.push("key > ?");
      args.push(o.startAfter);
    } else if (o.start !== undefined) {
      where.push("key >= ?");
      args.push(o.start);
    }
    if (o.end !== undefined) {
      where.push("key < ?");
      args.push(o.end);
    }
    if (o.prefix) {
      where.push("key >= ? AND substr(key, 1, ?) = ?");
      args.push(o.prefix, [...o.prefix].length, o.prefix);
    }
    let q = "SELECT key, value FROM _cf_KV";
    if (where.length) q += ` WHERE ${where.join(" AND ")}`;
    q += ` ORDER BY key ${o.reverse ? "DESC" : "ASC"}`;
    if (o.limit !== undefined) {
      if (!(o.limit > 0)) throw new RangeError("list() limit must be positive");
      q += " LIMIT ?";
      args.push(Math.floor(o.limit));
    }
    const out = new Map<string, CellValue>();
    for (const r of this.#db.prepare(q).all(...args) as SqlRow[]) {
      out.set(r.key as string, deserialize(r.value as Uint8Array));
    }
    return out;
  }

  /** `ctx.storage.get()`. */
  get<T = CellValue>(key: string): Promise<T | undefined>;
  /** `ctx.storage.get()` of several keys. */
  get<T = CellValue>(keys: string[]): Promise<Map<string, T>>;
  get(k: string | string[]): Promise<unknown> {
    try {
      if (Array.isArray(k)) {
        const out = new Map<string, unknown>();
        for (const key of k) {
          const v = this.#get(key);
          if (v !== undefined) out.set(key, v);
        }
        return Promise.resolve(out);
      }
      return Promise.resolve(this.#get(k));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** `ctx.storage.put()`. */
  put<T = CellValue>(key: string, value: T): Promise<void>;
  /** `ctx.storage.put()` of several entries, atomically. */
  put<T = CellValue>(entries: Record<string, T>): Promise<void>;
  put(k: string | Record<string, unknown>, value?: unknown): Promise<void> {
    try {
      this.#write(() => {
        if (typeof k === "string") this.#put(k, value);
        else for (const [key, v] of Object.entries(k)) this.#put(key, v);
      });
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** `ctx.storage.delete()`. */
  delete(key: string): Promise<boolean>;
  /** `ctx.storage.delete()` of several keys. */
  delete(keys: string[]): Promise<number>;
  delete(k: string | string[]): Promise<boolean | number> {
    try {
      return Promise.resolve(this.#write(() => {
        if (typeof k === "string") return this.#delete(k);
        let n = 0;
        for (const key of k) if (this.#delete(key)) n++;
        return n;
      }));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** `ctx.storage.deleteAll()`: keys and SQL tables. The alarm stays (use `deleteAlarm()`). */
  deleteAll(): Promise<void> {
    try {
      this.#write(() => {
        this.#db.exec("DELETE FROM _cf_KV");
        const tables = this.#db.prepare(
          "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') ORDER BY type DESC",
        ).all() as SqlRow[];
        for (const t of tables) {
          const name = String(t.name);
          if (RESERVED.test(name)) continue;
          this.#db.exec(
            `DROP ${t.type === "view" ? "VIEW" : "TABLE"} IF EXISTS "${
              name.replaceAll('"', '""')
            }"`,
          );
        }
      });
      this.#stmts.clear();
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** `ctx.storage.list()`. */
  list<T = CellValue>(options?: DurableObjectListOptions): Promise<Map<string, T>> {
    try {
      return Promise.resolve(this.#list(options) as Map<string, T>);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** The alarm, synchronously (the provider's view). */
  alarmSync(): number | null {
    this.#check();
    const r = this.#stmt("SELECT v FROM _zc_meta WHERE k = 'alarm'").get() as SqlRow | undefined;
    return r && r.v !== null ? Number(r.v) : null;
  }

  /** Sets or clears the alarm, synchronously, and tells the provider. */
  setAlarmSync(at: number | null): void {
    this.#write(() => {
      if (at === null) this.#stmt("DELETE FROM _zc_meta WHERE k = 'alarm'").run();
      else {
        this.#stmt(
          "INSERT INTO _zc_meta (k, v) VALUES ('alarm', ?) " +
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        ).run(at);
      }
    });
    if (this.#savepoint === 0) this.#hooks.onAlarm(at);
  }

  /** A metadata value of the cell (identity, retry counters). */
  meta(k: string): SqlStorageValue | undefined {
    this.#check();
    const r = this.#stmt("SELECT v FROM _zc_meta WHERE k = ?").get(k) as SqlRow | undefined;
    return r?.v;
  }

  /** Sets a metadata value. */
  setMeta(k: string, v: SqlStorageValue): void {
    this.#write(() =>
      this.#stmt(
        "INSERT INTO _zc_meta (k, v) VALUES (?, ?) " +
          "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      ).run(k, v)
    );
  }

  /** `ctx.storage.getAlarm()`. */
  getAlarm(): Promise<number | null> {
    try {
      return Promise.resolve(this.alarmSync());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** `ctx.storage.setAlarm()`. */
  setAlarm(scheduledTime: number | Date): Promise<void> {
    try {
      const at = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
      if (!Number.isFinite(at)) throw new TypeError("setAlarm() needs a time");
      this.setAlarmSync(Math.floor(at));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** `ctx.storage.deleteAlarm()`. */
  deleteAlarm(): Promise<void> {
    try {
      this.setAlarmSync(null);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** `ctx.storage.transactionSync()`. */
  transactionSync<T>(closure: () => T): T {
    const before = this.#savepoint === 0 ? this.alarmSync() : undefined;
    const r = this.#write(closure);
    if (before !== undefined) this.#alarmAfterTx(before);
    return r;
  }

  #alarmAfterTx(before: number | null): void {
    const after = this.alarmSync();
    if (after !== before) this.#hooks.onAlarm(after);
  }

  /** `ctx.storage.transaction()`: the input gate stays closed until the closure settles. */
  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    return this.#hooks.block(async () => {
      this.#check();
      const outer = this.#savepoint === 0;
      const before = outer ? this.alarmSync() : null;
      const sp = `zc_t${++this.#savepoint}`;
      this.#db.exec(`SAVEPOINT ${sp}`);
      let rolledBack = false;
      const rollback = () => {
        rolledBack = true;
      };
      const txn = new Proxy(this, {
        get: (t, p) => {
          if (p === "rollback") return rollback;
          const v = Reflect.get(t, p, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as unknown as DurableObjectTransaction;
      try {
        const r = await closure(txn);
        this.#end(sp, rolledBack);
        return r;
      } catch (e) {
        if (!this.#closed) this.#end(sp, true);
        throw limitError(e);
      } finally {
        if (--this.#savepoint === 0) this.#aborted = false;
        if (outer && !this.#closed) this.#alarmAfterTx(before);
      }
    });
  }

  /** `ctx.storage.sync()`: writes are already durable when they return. */
  sync(): Promise<void> {
    return Promise.resolve();
  }

  #exec<T extends SqlRow>(query: string, bindings: unknown[]): SqlStorageCursor<T> {
    this.#check();
    if (this.#aborted) {
      throw new CellError("storage_limit", "the transaction was rolled back by the storage limit");
    }
    let rest = query;
    let last: Cursor<T> | null = null;
    const statements: string[] = [];
    // node:sqlite compiles only the first statement of a string: split by what SQLite consumed.
    while (rest.trim()) {
      let stmt: StatementSync;
      try {
        stmt = this.#db.prepare(rest);
      } catch (e) {
        // A trailing comment or `;` compiles to nothing.
        if (statements.length && /not an error|empty|incomplete/i.test((e as Error).message)) break;
        throw e;
      }
      const src = stmt.sourceSQL;
      const at = rest.indexOf(src);
      if (!src || at < 0) throw new Error("sql.exec(): cannot split the statements of this query");
      statements.push(src);
      rest = rest.slice(at + src.length);
      const isLast = !rest.trim().replace(/^;+/, "").trim();
      last = this.#run<T>(stmt, isLast ? bindings : []);
      if (isLast) break;
    }
    if (!last) throw new Error("sql.exec(): empty query");
    return last;
  }

  #run<T extends SqlRow>(stmt: StatementSync, bindings: unknown[]): Cursor<T> {
    const params = bindings.map((b) =>
      b instanceof ArrayBuffer ? new Uint8Array(b) : typeof b === "boolean" ? Number(b) : b
    ) as (string | number | bigint | null | Uint8Array)[];
    const columns = stmt.columns().map((c) => c.name);
    try {
      if (columns.length) {
        const before = this.#db.prepare("SELECT total_changes() AS n").get() as SqlRow;
        const rows = stmt.all(...params) as T[];
        const after = this.#db.prepare("SELECT total_changes() AS n").get() as SqlRow;
        return new Cursor<T>(rows, columns, Number(after.n) - Number(before.n));
      }
      const r = stmt.run(...params);
      return new Cursor<T>([], [], Number(r.changes));
    } catch (e) {
      throw limitError(e);
    }
  }
}
