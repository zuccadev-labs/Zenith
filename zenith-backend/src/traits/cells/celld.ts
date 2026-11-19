/**
 * @module @zenith/traits/cells/celld
 *
 * The `celld` provider (ADR-019), **experimental**: Zenith's cell classes run in a celld fleet
 * (https://celld.dev, Apache-2.0) instead of this process. Three pieces:
 *
 * 1. **Project generator** (`generateCelldProject`): writes a Wrangler project (`wrangler.json` with the
 *    Durable Object bindings and the `new_sqlite_classes` migration, plus an entry module). The entry
 *    exports the cell classes (wrapped as `DurableObject` subclasses, which RPC needs on celld) and a
 *    small Worker that exposes them to Zenith under
 *    `/__zenith/cells/<BINDING>/<name:…|id:…>/{rpc/<method>|fetch/<path>|id}` and
 *    `/__zenith/cells/<BINDING>/new-id`, behind a bearer token (`ZENITH_CELLS_TOKEN`, fail closed).
 * 2. **Runner** (`celldDeploy`, `startCelldDev`): runs the `celld` binary (`celld deploy` to a bucket,
 *    or `celld dev` for one local node). Zenith never installs celld; `bin` or `CELLD_BIN` names it.
 * 3. **Client** (`CelldCellsClient`): a `DurableObjectNamespace` whose stubs reach the cells over HTTP.
 *
 * Limits of this phase: a cell module must be self-contained (one file; esbuild bundles its npm/URL
 * imports only if celld can resolve them), RPC arguments and results travel as JSON (no `Map`, `Date`
 * or binary), `newUniqueId()` is asynchronous (`newUniqueIdAsync()`), and cells on celld do not see
 * Zenith's in-process capabilities (AI, db…), only their `env`.
 */
import { CellError, type DurableObjectId, type DurableObjectNamespace } from "./types.ts";

/** A cell class to deploy to celld. */
export interface CelldCellClass {
  /** Exported class name (also the Durable Object `class_name`). */
  className: string;
  /** Binding name in `env` (default: the class name). */
  binding?: string;
  /** Path of the self-contained module (JS or TS) that exports the class. */
  module: string;
}

/** Options of `generateCelldProject`. */
export interface CelldProjectOptions {
  /** Worker (script) name: part of the cell ids in celld. */
  name: string;
  /** Directory to write the project to (created if needed). */
  outDir: string;
  /** The cell classes. */
  classes: CelldCellClass[];
  /** Wrangler `compatibility_date` (default `"2026-01-01"`). */
  compatibilityDate?: string;
  /** Plain variables for every cell (`vars`). Never put secrets here: they are stored in the bucket. */
  vars?: Record<string, string>;
}

/** The generated `wrangler.json`. */
export interface CelldWranglerConfig {
  /** Worker name. */
  name: string;
  /** Entry module. */
  main: string;
  /** Compatibility date. */
  compatibility_date: string;
  /** Durable Object bindings. */
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  /** The SQLite-class migration. */
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  /** Plain variables. */
  vars?: Record<string, string>;
}

/** What `generateCelldProject` wrote. */
export interface CelldProject {
  /** Project directory. */
  dir: string;
  /** Path of `wrangler.json`. */
  wranglerPath: string;
  /** Path of the entry module (imports `cloudflare:workers`: only celld/workerd load it). */
  entryPath: string;
  /** Path of the router module (the default export of the entry; plain JavaScript). */
  routerPath: string;
  /** Each source module and its copy, relative to `dir`. */
  modules: Record<string, string>;
  /** The configuration written. */
  config: CelldWranglerConfig;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ENTRY = "zenith-entry.js";
const ROUTER = "zenith-router.js";

/** The `wrangler.json` for `options` (pure; `generateCelldProject` writes it). */
export function celldWranglerConfig(
  options: Omit<CelldProjectOptions, "outDir">,
): CelldWranglerConfig {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(options.name)) {
    throw new CellError("bad_request", `invalid celld worker name "${options.name}"`);
  }
  if (!options.classes.length) throw new CellError("bad_request", "no cell classes to deploy");
  const bindings = new Set<string>();
  for (const c of options.classes) {
    const b = c.binding ?? c.className;
    if (!IDENT.test(c.className) || !IDENT.test(b)) {
      throw new CellError("bad_request", `invalid class or binding name "${c.className}"/"${b}"`);
    }
    if (bindings.has(b)) throw new CellError("bad_request", `duplicated binding "${b}"`);
    bindings.add(b);
  }
  const config: CelldWranglerConfig = {
    name: options.name,
    main: ENTRY,
    compatibility_date: options.compatibilityDate ?? "2026-01-01",
    durable_objects: {
      bindings: options.classes.map((c) => ({
        name: c.binding ?? c.className,
        class_name: c.className,
      })),
    },
    migrations: [{ tag: "v1", new_sqlite_classes: options.classes.map((c) => c.className) }],
  };
  if (options.vars && Object.keys(options.vars).length) config.vars = { ...options.vars };
  return config;
}

/**
 * The entry module. Cloudflare and celld only accept RPC on classes that extend `DurableObject` from
 * `cloudflare:workers`, which Deno cannot import; so cell modules stay plain classes (portable to the
 * local provider) and the entry wraps each one in a `DurableObject` subclass that forwards every
 * method to an inner instance. A class that already extends `DurableObject` is exported as it is.
 */
export function celldEntryModule(classes: Array<{ className: string; file: string }>): string {
  const imports = classes.map((c, i) => `import { ${c.className} as __Zc${i} } from "./${c.file}";`)
    .join("\n");
  const exports = classes.map((c, i) => `export const ${c.className} = zenithCell(__Zc${i});`)
    .join("\n");
  return `// Generated by Zenith (cells, celld provider). Do not edit: regenerate it.
import { DurableObject } from "cloudflare:workers";
import router from "./${ROUTER}";
${imports}

function zenithCell(Inner) {
  if (Inner.prototype instanceof DurableObject) return Inner;
  class Cell extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.__zenithInner = new Inner(ctx, env);
    }
  }
  for (let p = Inner.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const key of Object.getOwnPropertyNames(p)) {
      if (key === "constructor" || Object.prototype.hasOwnProperty.call(Cell.prototype, key)) continue;
      const d = Object.getOwnPropertyDescriptor(p, key);
      if (typeof d?.value !== "function") continue;
      Object.defineProperty(Cell.prototype, key, {
        configurable: true,
        writable: true,
        value: function (...args) {
          return this.__zenithInner[key](...args);
        },
      });
    }
  }
  Object.defineProperty(Cell, "name", { value: Inner.name });
  return Cell;
}

${exports}
export default router;
`;
}

/** The Worker that exposes the cells to Zenith (no imports: it also runs in Deno, for tests). */
export function celldRouterModule(): string {
  return `// Generated by Zenith (cells, celld provider). Do not edit: regenerate it.
const PREFIX = "/__zenith/cells/";
const json = (status, body) => Response.json(body, { status });

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function idOf(ns, spec) {
  if (spec.startsWith("name:")) return ns.idFromName(decodeURIComponent(spec.slice(5)));
  if (spec.startsWith("id:")) return ns.idFromString(spec.slice(3));
  throw new TypeError("cell spec must be name:<name> or id:<hex>");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return json(404, { error: "not found" });
    if (!env.ZENITH_CELLS_TOKEN) return json(503, { error: "ZENITH_CELLS_TOKEN is not set" });
    const auth = request.headers.get("authorization") ?? "";
    if (!sameToken(auth, "Bearer " + env.ZENITH_CELLS_TOKEN)) return json(401, { error: "unauthorized" });
    const parts = url.pathname.slice(PREFIX.length).split("/");
    const ns = env[parts[0]];
    if (!ns || typeof ns.idFromName !== "function") return json(404, { error: "unknown binding" });
    try {
      if (parts[1] === "new-id" && request.method === "POST") {
        return json(200, { id: ns.newUniqueId().toString() });
      }
      const id = idOf(ns, parts[1] ?? "");
      const op = parts[2];
      if (op === "id") return json(200, { id: id.toString(), name: id.name ?? null });
      const stub = ns.get(id);
      if (op === "rpc" && request.method === "POST" && parts[3]) {
        const { args = [] } = await request.json();
        try {
          const value = await stub[parts[3]](...args);
          return json(200, { ok: true, value: value === undefined ? null : value });
        } catch (e) {
          return json(200, { ok: false, error: { name: e?.name ?? "Error", message: String(e?.message ?? e) } });
        }
      }
      if (op === "fetch") {
        const headers = new Headers(request.headers);
        headers.delete("authorization");
        const target = new URL("/" + parts.slice(3).join("/") + url.search, url);
        return await stub.fetch(new Request(target, { method: request.method, headers, body: request.body }));
      }
      return json(404, { error: "unknown operation" });
    } catch (e) {
      return json(400, { error: String(e?.message ?? e) });
    }
  },
};
`;
}

/** Writes the Wrangler project of `options` (and copies each module into it). */
export async function generateCelldProject(options: CelldProjectOptions): Promise<CelldProject> {
  const config = celldWranglerConfig(options);
  const dir = options.outDir;
  await Deno.mkdir(`${dir}/cells`, { recursive: true });
  const files: Array<{ className: string; file: string }> = [];
  const copied = new Map<string, string>();
  for (const c of options.classes) {
    let file = copied.get(c.module);
    if (!file) {
      const base = c.module.split(/[\\/]/).pop()!;
      file = `cells/${copied.size}-${base}`;
      await Deno.copyFile(c.module, `${dir}/${file}`);
      copied.set(c.module, file);
    }
    files.push({ className: c.className, file });
  }
  const wranglerPath = `${dir}/wrangler.json`;
  const entryPath = `${dir}/${ENTRY}`;
  const routerPath = `${dir}/${ROUTER}`;
  await Deno.writeTextFile(wranglerPath, JSON.stringify(config, null, 2) + "\n");
  await Deno.writeTextFile(entryPath, celldEntryModule(files));
  await Deno.writeTextFile(routerPath, celldRouterModule());
  await Deno.writeTextFile(`${dir}/.gitignore`, ".celld/\n.dev.vars\n");
  return { dir, wranglerPath, entryPath, routerPath, modules: Object.fromEntries(copied), config };
}

/** Where the `celld` binary is: `bin`, else `CELLD_BIN`, else `celld` on `PATH`. */
function celldBin(bin?: string): string {
  return bin ?? Deno.env.get("CELLD_BIN") ?? "celld";
}

/** Options of `celldDeploy`. */
export interface CelldDeployOptions {
  /** The generated project. */
  projectDir: string;
  /** Fleet bucket: `s3://NAME[/PREFIX]`, `gs://…` or `az://…`. */
  bucket: string;
  /** S3-compatible endpoint. */
  endpoint?: string;
  /** Storage region. */
  region?: string;
  /** celld binary. */
  bin?: string;
  /** Extra environment (credentials; `PATH` must reach esbuild). */
  env?: Record<string, string>;
}

/** Runs `celld deploy`. Returns its exit code and output; it does not throw on a failed deploy. */
export async function celldDeploy(
  options: CelldDeployOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = ["deploy", options.projectDir, "--bucket", options.bucket];
  if (options.endpoint) args.push("--endpoint", options.endpoint);
  if (options.region) args.push("--region", options.region);
  const out = await new Deno.Command(celldBin(options.bin), {
    args,
    env: options.env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

/** A running `celld dev` node. */
export interface CelldDevNode {
  /** Worker listener, e.g. `http://127.0.0.1:9876`. */
  url: string;
  /** Stops the node. */
  close(): Promise<void>;
}

/**
 * Starts `celld dev <projectDir>` on `port` with the token in `.dev.vars` (mode 0600) and waits until
 * the Worker answers. For development and tests: one node, local object store in `.celld/dev`.
 */
export async function startCelldDev(options: {
  projectDir: string;
  port: number;
  token: string;
  bin?: string;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}): Promise<CelldDevNode> {
  const vars = `${options.projectDir}/.dev.vars`;
  await Deno.writeTextFile(vars, `ZENITH_CELLS_TOKEN=${options.token}\n`, { mode: 0o600 });
  const child = new Deno.Command(celldBin(options.bin), {
    args: ["dev", options.projectDir, "--port", String(options.port), "--no-watch"],
    env: options.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const logs: string[] = [];
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const chunk of s.pipeThrough(new TextDecoderStream())) logs.push(chunk);
  };
  const drains = Promise.all([drain(child.stdout), drain(child.stderr)]).catch(() => {});
  const url = `http://127.0.0.1:${options.port}`;
  const end = Date.now() + (options.readyTimeoutMs ?? 60_000);
  let exited = false;
  child.status.then(() => (exited = true));
  const close = async () => {
    if (!exited) {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
    }
    await child.status;
    await drains;
  };
  while (true) {
    if (exited) {
      await drains;
      throw new CellError("remote", `celld dev exited before it was ready:\n${logs.join("")}`);
    }
    try {
      const r = await fetch(`${url}/__zenith/cells/`, { signal: AbortSignal.timeout(1000) });
      await r.body?.cancel();
      if (r.status === 401 || r.status === 404 || r.status === 503) return { url, close };
    } catch { /* not listening yet */ }
    if (Date.now() > end) {
      await close();
      throw new CellError("timeout", `celld dev was not ready in time:\n${logs.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** A cell id as the client knows it: a name or a hexadecimal id, resolved by celld. */
class RemoteCellId implements DurableObjectId {
  readonly name?: string;
  readonly #hex?: string;
  constructor(spec: { name?: string; hex?: string }) {
    if (spec.name !== undefined) this.name = spec.name;
    this.#hex = spec.hex;
  }
  /** The spec in the URL. */
  get spec(): string {
    return this.#hex ? `id:${this.#hex}` : `name:${encodeURIComponent(this.name!)}`;
  }
  toString(): string {
    if (!this.#hex) {
      throw new CellError(
        "unsupported",
        "the hexadecimal id of a named celld cell is known only to celld: use resolveId()",
      );
    }
    return this.#hex;
  }
  equals(other: DurableObjectId): boolean {
    return other instanceof RemoteCellId ? other.spec === this.spec : false;
  }
}

/** A remote namespace: `DurableObjectNamespace` plus the asynchronous calls HTTP needs. */
export interface CelldNamespace<T = unknown> extends DurableObjectNamespace<T> {
  /** A new random id, created by celld. */
  newUniqueIdAsync(): Promise<DurableObjectId>;
  /** The hexadecimal id and name of `id` as celld computes them. */
  resolveId(id: DurableObjectId): Promise<{ id: string; name: string | null }>;
}

/** Options of `CelldCellsClient`. */
export interface CelldClientOptions {
  /** Base URL of the celld Worker listener (or its ingress). */
  url: string;
  /** The `ZENITH_CELLS_TOKEN` of the deployment. */
  token: string;
  /** `fetch` to use (tests). */
  fetch?: typeof fetch;
  /** Upper bound of one call in ms (default 30 000). */
  timeoutMs?: number;
}

/** The HTTP client of the cells deployed to celld. */
export class CelldCellsClient {
  readonly #o: Required<CelldClientOptions>;
  /** A client of the deployment at `options.url`. */
  constructor(options: CelldClientOptions) {
    if (!options.url || !options.token) {
      throw new CellError("bad_request", "the celld client needs url and token");
    }
    this.#o = {
      fetch: globalThis.fetch.bind(globalThis),
      timeoutMs: 30_000,
      ...options,
      url: options.url.replace(/\/+$/, ""),
    };
  }

  #call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#o.token}`);
    return this.#o.fetch(`${this.#o.url}/__zenith/cells/${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(this.#o.timeoutMs),
    });
  }

  async #json(path: string, init?: RequestInit): Promise<any> {
    const r = await this.#call(path, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new CellError(
        r.status === 401 ? "bad_request" : "remote",
        `celld ${r.status}: ${body.error ?? "error"}`,
      );
    }
    return body;
  }

  /** The namespace of `binding` in the deployment. */
  namespace<T = unknown>(binding: string): CelldNamespace<T> {
    if (!IDENT.test(binding)) throw new CellError("bad_request", `invalid binding "${binding}"`);
    const check = (id: DurableObjectId): RemoteCellId => {
      if (!(id instanceof RemoteCellId)) {
        throw new TypeError("Durable Object ID is not valid for this namespace");
      }
      return id;
    };
    const ns: CelldNamespace<T> = {
      idFromName: (name) => new RemoteCellId({ name: String(name) }),
      idFromString: (hex) => {
        const h = String(hex).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(h)) throw new CellError("bad_id", "not 64 hex digits");
        return new RemoteCellId({ hex: h });
      },
      newUniqueId: () => {
        throw new CellError("unsupported", "celld ids come from celld: use newUniqueIdAsync()");
      },
      newUniqueIdAsync: async () =>
        new RemoteCellId({ hex: (await this.#json(`${binding}/new-id`, { method: "POST" })).id }),
      resolveId: (id) => this.#json(`${binding}/${check(id).spec}/id`),
      get: (id) => this.#stub(binding, check(id)) as any,
      getByName: (name) => this.#stub(binding, new RemoteCellId({ name: String(name) })) as any,
    };
    return ns;
  }

  #stub(binding: string, id: RemoteCellId): unknown {
    const base = {
      id,
      name: id.name,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input instanceof URL ? input.href : input, init);
        const u = new URL(req.url);
        return this.#call(`${binding}/${id.spec}/fetch${u.pathname}${u.search}`, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
      },
    };
    return new Proxy(base, {
      get: (t, p) => {
        if (typeof p === "symbol") return undefined;
        if (p in t) return t[p as keyof typeof t];
        if (p === "then") return undefined;
        return async (...args: unknown[]) => {
          const r = await this.#json(`${binding}/${id.spec}/rpc/${encodeURIComponent(p)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ args }),
          });
          if (r.ok) return r.value;
          const e = new Error(r.error?.message ?? "remote error");
          e.name = r.error?.name ?? "Error";
          (e as Error & { remote: boolean }).remote = true;
          throw e;
        };
      },
    });
  }
}
