/**
 * @module @zenith/traits/cells/kv
 *
 * KV namespaces (Cloudflare's `KVNamespace`) built on a cell, as celld builds them: each namespace is
 * one cell of the internal class `ZenithKV`, named after the binding, with its entries in that cell's
 * SQLite. Expired entries are invisible at once and removed by the cell's alarm.
 *
 * Differences from Cloudflare: reads are strongly consistent (one writer), there is no `cacheTtl`
 * (accepted and ignored), and the minimum `expirationTtl` of 60 s is not enforced.
 */
import type {
  CellEnv,
  DurableObjectNamespace,
  DurableObjectState,
  SqlRow,
  SqlStorageValue,
} from "./types.ts";

/** The internal cell class name of KV namespaces. */
export const KV_CELL_CLASS = "ZenithKV";

/** Options of `put()`. */
export interface KVPutOptions {
  /** Absolute expiry, in seconds since the epoch. */
  expiration?: number;
  /** Expiry relative to now, in seconds. */
  expirationTtl?: number;
  /** JSON metadata kept with the value (at most 1024 bytes serialized). */
  metadata?: unknown;
}

/** Options of `list()`. */
export interface KVListOptions {
  /** Only keys with this prefix. */
  prefix?: string;
  /** Page size (default and maximum 1000). */
  limit?: number;
  /** The `cursor` of the previous page. */
  cursor?: string;
}

/** A page of `list()`. */
export interface KVListResult {
  /** Keys of this page. */
  keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
  /** Whether there are no more pages. */
  list_complete: boolean;
  /** The cursor of the next page, when there is one. */
  cursor?: string;
}

/** How `get()` decodes the value. */
export type KVGetType = "text" | "json" | "arrayBuffer" | "stream";

/** `env.MY_KV`: the subset of Cloudflare's `KVNamespace` the local provider implements. */
export interface KVNamespace {
  /** The value of `key`, decoded as `type` (default text), or `null`. */
  get(key: string, type?: KVGetType | { type?: KVGetType; cacheTtl?: number }): Promise<unknown>;
  /** `get()` plus the metadata of the entry. */
  getWithMetadata(
    key: string,
    type?: KVGetType | { type?: KVGetType; cacheTtl?: number },
  ): Promise<{ value: unknown; metadata: unknown }>;
  /** Stores `value` under `key`. */
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVPutOptions,
  ): Promise<void>;
  /** Removes `key`. */
  delete(key: string): Promise<void>;
  /** Keys in order, by pages. */
  list(options?: KVListOptions): Promise<KVListResult>;
}

const MAX_KEY = 512;
const MAX_META = 1024;
const now = () => Math.floor(Date.now() / 1000);

/** The cell behind a KV namespace. Portable: it only uses `ctx.storage`. */
export class ZenithKVCell {
  #ctx: DurableObjectState;
  /** Creates the table of entries. */
  constructor(ctx: DurableObjectState, _env: CellEnv) {
    this.#ctx = ctx;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, expiration INTEGER," +
        " metadata TEXT) WITHOUT ROWID",
    );
  }
  #live(key: string): SqlRow | undefined {
    const rows = this.#ctx.storage.sql.exec(
      "SELECT value, expiration, metadata FROM kv WHERE key = ? AND (expiration IS NULL OR expiration > ?)",
      key,
      now(),
    ).toArray();
    return rows[0];
  }
  /** The raw entry: bytes and metadata, or `null`. */
  read(key: string): { value: Uint8Array; metadata: unknown } | null {
    const r = this.#live(key);
    if (!r) return null;
    return {
      value: r.value as Uint8Array,
      metadata: r.metadata === null ? null : JSON.parse(String(r.metadata)),
    };
  }
  /** Stores an entry and schedules the sweep of its expiry. */
  async write(
    key: string,
    value: Uint8Array,
    expiration: number | null,
    metadata: string | null,
  ): Promise<void> {
    this.#ctx.storage.sql.exec(
      "INSERT INTO kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO " +
        "UPDATE SET value = excluded.value, expiration = excluded.expiration, metadata = excluded.metadata",
      key,
      value,
      expiration,
      metadata,
    );
    if (expiration !== null) {
      const at = (await this.#ctx.storage.getAlarm()) ?? Infinity;
      if (expiration * 1000 < at) await this.#ctx.storage.setAlarm(expiration * 1000);
    }
  }
  /** Removes an entry. */
  remove(key: string): void {
    this.#ctx.storage.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }
  /** One page of live keys after `cursor`. */
  keys(prefix: string, limit: number, cursor: string | null): KVListResult {
    const rows = this.#ctx.storage.sql.exec(
      "SELECT key, expiration, metadata FROM kv WHERE (expiration IS NULL OR expiration > ?)" +
        " AND key > ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?",
      now(),
      cursor ?? "",
      [...prefix].length,
      prefix,
      limit + 1,
    ).toArray();
    const page = rows.slice(0, limit);
    const done = rows.length <= limit;
    return {
      keys: page.map((r) => ({
        name: String(r.key),
        ...(r.expiration !== null ? { expiration: Number(r.expiration) } : {}),
        ...(r.metadata !== null ? { metadata: JSON.parse(String(r.metadata)) } : {}),
      })),
      list_complete: done,
      ...(done ? {} : { cursor: String(page[page.length - 1].key) }),
    };
  }
  /** Removes expired entries and schedules the next expiry. */
  async alarm(): Promise<void> {
    const sql = this.#ctx.storage.sql;
    sql.exec("DELETE FROM kv WHERE expiration IS NOT NULL AND expiration <= ?", now());
    const next = sql.exec("SELECT min(expiration) AS e FROM kv").one().e as SqlStorageValue;
    if (next !== null) await this.#ctx.storage.setAlarm(Number(next) * 1000);
  }
}

async function toBytes(
  value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  throw new TypeError("KV put() takes a string, an ArrayBuffer, a view or a stream");
}

function decode(bytes: Uint8Array, type: KVGetType): unknown {
  switch (type) {
    case "text":
      return new TextDecoder().decode(bytes);
    case "json":
      return JSON.parse(new TextDecoder().decode(bytes));
    case "arrayBuffer":
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    case "stream":
      return new Response(bytes as Uint8Array<ArrayBuffer>).body;
    default:
      throw new TypeError(`unknown KV type "${type}"`);
  }
}

function checkKey(key: string): string {
  if (typeof key !== "string" || !key) throw new TypeError("KV keys are non-empty strings");
  if (new TextEncoder().encode(key).length > MAX_KEY) {
    throw new RangeError(`KV keys cannot be longer than ${MAX_KEY} bytes`);
  }
  return key;
}

/** The `KVNamespace` binding `name`, served by its cell in `cells` (the `ZenithKV` namespace). */
export function kvNamespace(
  cells: DurableObjectNamespace<ZenithKVCell>,
  name: string,
): KVNamespace {
  const cell = () => cells.getByName(`kv:${name}`);
  const typeOf = (t?: KVGetType | { type?: KVGetType }) =>
    (typeof t === "string" ? t : t?.type) ?? "text";
  return {
    async get(key, type) {
      const r = await cell().read(checkKey(key));
      return r ? decode(r.value, typeOf(type)) : null;
    },
    async getWithMetadata(key, type) {
      const r = await cell().read(checkKey(key));
      return r
        ? { value: decode(r.value, typeOf(type)), metadata: r.metadata }
        : { value: null, metadata: null };
    },
    async put(key, value, options = {}) {
      checkKey(key);
      let expiration: number | null = null;
      if (options.expiration !== undefined) expiration = Math.floor(options.expiration);
      if (options.expirationTtl !== undefined) {
        expiration = now() + Math.floor(options.expirationTtl);
      }
      let metadata: string | null = null;
      if (options.metadata !== undefined) {
        metadata = JSON.stringify(options.metadata);
        if (new TextEncoder().encode(metadata).length > MAX_META) {
          throw new RangeError(`KV metadata cannot be larger than ${MAX_META} bytes`);
        }
      }
      await cell().write(key, await toBytes(value), expiration, metadata);
    },
    async delete(key) {
      await cell().remove(checkKey(key));
    },
    async list(options = {}) {
      const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 1000)), 1000);
      return await cell().keys(options.prefix ?? "", limit, options.cursor ?? null);
    },
  };
}
