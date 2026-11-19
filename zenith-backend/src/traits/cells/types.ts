/**
 * @module @zenith/traits/cells/types
 *
 * The binding surface of cells (ADR-019): the Cloudflare Durable Objects API, which celld implements
 * as well. A cell class written against these types runs on Zenith's `local` provider, on celld and on
 * Cloudflare without changes, as long as it only touches `ctx` and `env`.
 *
 * Only the subset that the `local` provider really implements is declared here; the rest of the
 * Cloudflare surface (hibernatable WebSockets, facets, RPC stubs as arguments) is listed as pending in
 * ADR-019 and fails loudly when called.
 */

/** A value that can be stored or passed through RPC: anything `structuredClone` accepts. */
export type CellValue = unknown;

/** The identity of a cell inside one namespace: 64 hexadecimal digits. */
export interface DurableObjectId {
  /** The name it was derived from with `idFromName()`, when it has one. */
  readonly name?: string;
  /** The 64-digit hexadecimal form, accepted back by `idFromString()`. */
  toString(): string;
  /** Whether both ids name the same cell. */
  equals(other: DurableObjectId): boolean;
}

/** Options of `DurableObjectStorage.list()`. Keys compare as UTF-8 bytes. */
export interface DurableObjectListOptions {
  /** First key, inclusive. */
  start?: string;
  /** First key, exclusive (takes precedence over `start`). */
  startAfter?: string;
  /** Last key, exclusive. */
  end?: string;
  /** Only keys that start with it. */
  prefix?: string;
  /** Descending order. */
  reverse?: boolean;
  /** At most this many entries. */
  limit?: number;
}

/** `alarm(info)` argument. */
export interface AlarmInvocationInfo {
  /** How many times this alarm already failed. */
  readonly retryCount: number;
  /** `retryCount > 0`. */
  readonly isRetry: boolean;
}

/** One SQL result: column name to value. */
export type SqlRow = Record<string, SqlStorageValue>;

/** The values SQLite gives back. */
export type SqlStorageValue = string | number | bigint | null | Uint8Array;

/** The result of `sql.exec()`: an iterator over the rows, with the counters of the statement. */
export interface SqlStorageCursor<T extends SqlRow = SqlRow> extends Iterable<T> {
  /** The next row, as an iterator result. */
  next(): IteratorResult<T>;
  /** Every remaining row. */
  toArray(): T[];
  /** The only row; throws when there is not exactly one. */
  one(): T;
  /** The remaining rows as arrays, in column order. */
  raw(): IterableIterator<SqlStorageValue[]>;
  /** Column names, in order. */
  readonly columnNames: string[];
  /** Rows the statement returned (an approximation of Cloudflare's `rowsRead`). */
  readonly rowsRead: number;
  /** Rows the statement changed. */
  readonly rowsWritten: number;
}

/** `ctx.storage.sql`: the SQLite database of the cell. */
export interface SqlStorage {
  /**
   * Runs `query` (one or more statements separated by `;`) and returns the cursor of the last one.
   * `bindings` go to the last statement.
   */
  exec<T extends SqlRow = SqlRow>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  /** Size of the database file in bytes. */
  readonly databaseSize: number;
}

/** `ctx.storage.kv`: the synchronous key-value API of SQLite-backed objects. */
export interface SyncKvStorage {
  /** The value of `key`, or `undefined`. */
  get<T = CellValue>(key: string): T | undefined;
  /** Stores `value` under `key`. */
  put<T = CellValue>(key: string, value: T): void;
  /** Deletes `key`; whether it existed. */
  delete(key: string): boolean;
  /** The entries that match `options`, in key order. */
  list<T = CellValue>(options?: DurableObjectListOptions): Iterable<[string, T]>;
}

/** `ctx.storage`: transactional storage private to one cell. */
export interface DurableObjectStorage {
  /** The value of one key, or `undefined`. */
  get<T = CellValue>(key: string): Promise<T | undefined>;
  /** The values of several keys; missing keys are absent from the map. */
  get<T = CellValue>(keys: string[]): Promise<Map<string, T>>;
  /** Stores one value. */
  put<T = CellValue>(key: string, value: T): Promise<void>;
  /** Stores several values atomically. */
  put<T = CellValue>(entries: Record<string, T>): Promise<void>;
  /** Deletes one key; whether it existed. */
  delete(key: string): Promise<boolean>;
  /** Deletes several keys; how many existed. */
  delete(keys: string[]): Promise<number>;
  /** Deletes every key and every SQL table of the cell (not the alarm: `deleteAlarm()`). */
  deleteAll(): Promise<void>;
  /** The entries that match `options`, in key order. */
  list<T = CellValue>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
  /** The time of the alarm in ms since the epoch, or `null`. */
  getAlarm(): Promise<number | null>;
  /** Sets the only alarm of the cell; `alarm()` runs at (or after) that time. */
  setAlarm(scheduledTime: number | Date): Promise<void>;
  /** Removes the alarm. */
  deleteAlarm(): Promise<void>;
  /**
   * Runs `closure` in a transaction: everything it writes commits together, or nothing when it throws
   * or calls `txn.rollback()`. Other events wait until it ends.
   */
  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;
  /** Synchronous transaction: a throw rolls it back. Can nest. */
  transactionSync<T>(closure: () => T): T;
  /** Resolves when the earlier writes are durable (immediate on the local provider). */
  sync(): Promise<void>;
  /** The SQLite database of the cell. */
  readonly sql: SqlStorage;
  /** The synchronous key-value API. */
  readonly kv: SyncKvStorage;
}

/** The storage seen inside `storage.transaction()`, with `rollback()`. */
export interface DurableObjectTransaction extends DurableObjectStorage {
  /** Discards every write of the transaction when the closure returns. */
  rollback(): void;
}

/** `ctx`: what a cell receives from its runtime. */
export interface DurableObjectState {
  /** The id of this cell. */
  readonly id: DurableObjectId;
  /** The storage of this cell. */
  readonly storage: DurableObjectStorage;
  /**
   * Closes the input gate while `callback` runs: no other event reaches the cell until it settles.
   * Limited to 30 s (as in celld); a timeout resets the cell.
   */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  /** Keeps the cell resident until `promise` settles. */
  waitUntil(promise: Promise<unknown>): void;
  /** Resets the cell: the in-memory instance is dropped, storage stays. */
  abort(reason?: string): void;
}

/** A remote reference to one cell: `fetch()` plus every public method of its class, as RPC. */
export type DurableObjectStub<T = unknown> =
  & {
    /** The id of the cell. */
    readonly id: DurableObjectId;
    /** The name of the cell, when the id has one. */
    readonly name?: string;
    /** Sends an HTTP request to the `fetch()` handler of the cell. */
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  }
  & RpcMethods<T>;

/** The public methods of `T` as asynchronous RPC calls. */
export type RpcMethods<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends
    (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** `env.MY_CELL`: creates ids and stubs for one cell class. */
export interface DurableObjectNamespace<T = unknown> {
  /** The id of the cell called `name` (the same name always reaches the same cell). */
  idFromName(name: string): DurableObjectId;
  /** Parses an id from its `toString()`; refuses ids of another namespace. */
  idFromString(id: string): DurableObjectId;
  /** A new random id. */
  newUniqueId(options?: { jurisdiction?: string }): DurableObjectId;
  /** A stub for `id`. The cell starts at the first call, not here. */
  get(id: DurableObjectId): DurableObjectStub<T>;
  /** `get(idFromName(name))`. */
  getByName(name: string): DurableObjectStub<T>;
}

/** The bindings a cell receives as `env`: namespaces, variables and the extras of its class. */
export type CellEnv = Record<string, unknown>;

/** A cell class: `new (ctx, env)`, with optional `fetch` and `alarm` handlers and RPC methods. */
export type CellClass<T = object> = new (ctx: DurableObjectState, env: CellEnv) => T;

/** The handlers a cell may implement. */
export interface CellHandlers {
  /** HTTP entry point. */
  fetch?(request: Request): Response | Promise<Response>;
  /** Runs when the alarm fires. A throw retries it with exponential backoff. */
  alarm?(info: AlarmInvocationInfo): void | Promise<void>;
}

/**
 * Optional base class, like `DurableObject` from `cloudflare:workers`: it keeps `ctx` and `env`. Plain
 * classes with a `(ctx, env)` constructor work the same and are the most portable form (no import).
 */
export class DurableObject<Env extends CellEnv = CellEnv> {
  /** The state of this cell. */
  protected ctx: DurableObjectState;
  /** The bindings of this cell. */
  protected env: Env;
  /** Keeps `ctx` and `env`. */
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** Why a cell operation failed. */
export type CellErrorCode =
  | "not_found"
  | "bad_id"
  | "bad_request"
  | "capacity"
  | "storage_limit"
  | "timeout"
  | "reset"
  | "closed"
  | "unsupported"
  | "remote";

/** A failure of the cells runtime (not of the cell's own code, which throws its own errors). */
export class CellError extends Error {
  /** Machine-readable reason. */
  readonly code: CellErrorCode;
  /** An error with a reason code. */
  constructor(code: CellErrorCode, message: string) {
    super(message);
    this.name = "CellError";
    this.code = code;
  }
}
