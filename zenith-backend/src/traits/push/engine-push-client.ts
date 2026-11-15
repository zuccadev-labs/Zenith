/**
 * @module @zenith/traits/push/engine-push-client
 *
 * Client of **engine-push** (zutool), the daemon that delivers every notice to people: devices (ntfy,
 * Web Push, FCM, APNs) and Telegram, Slack and email. It speaks line-delimited JSON-RPC 2.0 over a Unix
 * socket: `$ENGINE_PUSH_SOCKET`, else `$XDG_RUNTIME_DIR/zutool/engine-push.sock`, else
 * `<tmp>/zutool-<uid>/engine-push.sock` (the convention of every zutool engine). No dependencies, and it
 * never starts engine-push: when the socket does not answer, calls fail with code `unavailable` and the
 * caller keeps its own path.
 *
 * Methods (`push/*`): see `docs/development/engine-push.md` in zutool.
 */

export class EnginePushError extends Error {
  /** `unavailable` (no socket, no answer), or engine-push's `error.data.code` (`bad_target`…). */
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "EnginePushError";
    this.code = code;
  }
}

const env = (name: string): string | undefined => {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined; // no --allow-env
  }
};

/** The socket path by the zutool convention. */
export function enginePushSocketPath(): string {
  const explicit = env("ENGINE_PUSH_SOCKET");
  if (explicit) return explicit;
  const runtime = env("XDG_RUNTIME_DIR");
  if (runtime) return `${runtime}/zutool/engine-push.sock`;
  let uid = env("USER") ?? "user";
  try {
    uid = String(Deno.uid() ?? uid);
  } catch { /* not on this OS */ }
  return `${env("TMPDIR") ?? "/tmp"}/zutool-${uid}/engine-push.sock`;
}

/** The `zutool-push/1` message. */
export interface PushMessage {
  title?: string;
  body?: string;
  kind?: string;
  urgency?: "normal" | "high";
  collapseKey?: string;
  ttlS?: number;
  data?: Record<string, string>;
}

export interface PushResult {
  subscriptionId?: string;
  provider: string;
  ok: boolean;
  error?: string;
}
export interface PushSendResult {
  delivered: number;
  failed: number;
  results: PushResult[];
}
export interface PushSubscription {
  subscriptionId: string;
  provider: string;
  name?: string;
  /** Masked hint, never the target itself. */
  target?: string;
  createdAt?: number;
  lastOkAt?: number | null;
  lastError?: string | null;
}

export interface EnginePushClientOptions {
  /** Socket path; default [`enginePushSocketPath`]. */
  socket?: string;
  /** Upper bound of one call (default 30 s, as engine-kit's RPC client). */
  timeoutMs?: number;
}

export class EnginePushClient {
  readonly socket: string;
  readonly timeoutMs: number;
  #nextId = 1;

  constructor(options: EnginePushClientOptions = {}) {
    this.socket = options.socket ?? enginePushSocketPath();
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** One request on a fresh connection. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let conn: Deno.UnixConn;
    try {
      conn = await Deno.connect({ transport: "unix", path: this.socket });
    } catch (e) {
      throw new EnginePushError("unavailable", `${this.socket}: ${(e as Error).message}`);
    }
    const id = this.#nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = new TextEncoder().encode(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      for (let off = 0; off < line.length;) off += await conn.write(line.subarray(off));
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new EnginePushError("unavailable", `no answer to ${method} in ${this.timeoutMs} ms`),
            ),
          this.timeoutMs,
        );
      });
      const v = await Promise.race([readAnswer(conn, id), timeout]);
      if (v.error) {
        const e = v.error as { code?: unknown; message?: unknown; data?: { code?: unknown } };
        const code = typeof e.data?.code === "string" ? e.data.code : String(e.code ?? "error");
        throw new EnginePushError(code, typeof e.message === "string" ? e.message : "error");
      }
      return (v.result ?? null) as T;
    } finally {
      clearTimeout(timer);
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  }

  /** Is engine-push answering (`engine/status`)? Never starts it. */
  async available(): Promise<boolean> {
    try {
      await this.call("engine/status");
      return true;
    } catch {
      return false;
    }
  }

  async list(owner: string): Promise<PushSubscription[]> {
    const r = await this.call<PushSubscription[]>("push/list", { owner });
    return Array.isArray(r) ? r : [];
  }

  subscribe(
    owner: string,
    provider: string,
    target: string,
    name?: string,
  ): Promise<{ subscriptionId: string; existing: boolean }> {
    return this.call("push/subscribe", { owner, provider, target, ...(name ? { name } : {}) });
  }

  unsubscribe(owner: string, id: string): Promise<{ ok: boolean }> {
    return this.call("push/unsubscribe", { owner, id });
  }

  send(owner: string, message: PushMessage, providers?: string[]): Promise<PushSendResult> {
    return this.call("push/send", { owner, message, ...(providers ? { providers } : {}) });
  }

  purgeOwner(owner: string): Promise<{ deleted: number }> {
    return this.call("push/purge-owner", { owner });
  }
}

/** Reads lines until the answer with `id` (skips notifications). */
async function readAnswer(conn: Deno.Conn, id: number): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(64 * 1024);
  let pending = "";
  while (true) {
    const n = await conn.read(buf);
    if (n === null) throw new EnginePushError("unavailable", "engine-push closed the connection");
    pending += decoder.decode(buf.subarray(0, n), { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(line);
      } catch (e) {
        throw new EnginePushError("unavailable", `answer is not JSON: ${(e as Error).message}`);
      }
      if (v.id === id || (v.id === null && v.error)) return v;
    }
  }
}

/** The subscription name for a target (as zutool's `PushRelay`): a one-way fingerprint, never the target. */
export async function targetFingerprint(provider: string, target: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`zutool-push-relay/1\n${provider}\n${target}`),
    ),
  );
  return `${provider} ${
    [...d.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")
  }`;
}

/**
 * Leaves exactly one subscription of `provider` for `owner`, with `target` (none when `null`): an
 * unchanged target costs one `push/list`, a changed one replaces the old subscription.
 */
export async function ensureSubscription(
  client: EnginePushClient,
  owner: string,
  provider: string,
  target: string | null,
): Promise<void> {
  const want = target === null ? null : await targetFingerprint(provider, target);
  let have = false;
  for (const s of (await client.list(owner)).filter((s) => s.provider === provider)) {
    if (!have && want !== null && s.name === want) {
      have = true;
      continue;
    }
    try {
      await client.unsubscribe(owner, s.subscriptionId);
    } catch (e) {
      if (!(e instanceof EnginePushError && e.code === "not_found")) throw e;
    }
  }
  if (!have && target !== null && want !== null) {
    await client.subscribe(owner, provider, target, want);
  }
}
