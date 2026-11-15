/**
 * engine-push: every notice to people goes through zutool's engine-push daemon, by its Unix socket.
 *
 * engine-push keeps the subscriptions (sealed) and the providers (ntfy, Web Push, FCM, APNs, Telegram,
 * Slack, email); Zenith only names owners and hands it messages. Owners are `zenith:<appId>:<userId>`
 * for a user and `zenith:<appId>:installation:<installationId>` for a Parse installation (ZenithPush).
 * engine-push is never started from here: when its socket does not answer, `available()` is false and
 * the consumers keep their previous path (ZenithPush records the delivery, ZenithNotifications stays
 * in-app).
 *
 * Configured after composition with `config.enginePush` (`socket`, `timeoutMs`); without it, the socket
 * of the zutool convention (`ENGINE_PUSH_SOCKET`, `$XDG_RUNTIME_DIR/zutool/engine-push.sock`).
 *
 * @barrits-trait
 * @barrits-summary ZenithEnginePush
 * @barrits-provides enginePush
 * @barrits-consumes
 * @barrits-state enginePushConfig
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import {
  EnginePushClient,
  EnginePushError,
  ensureSubscription,
  type PushMessage,
  type PushSendResult,
  type PushSubscription,
} from "./engine-push-client.ts";

export { EnginePushClient, EnginePushError } from "./engine-push-client.ts";
export type { PushMessage, PushSendResult, PushSubscription } from "./engine-push-client.ts";

/** `config.enginePush`. */
export interface EnginePushConfig {
  /** Socket path (default: `ENGINE_PUSH_SOCKET`, else `$XDG_RUNTIME_DIR/zutool/engine-push.sock`). */
  readonly socket?: string;
  /** Upper bound of one call in ms (default 30 000). */
  readonly timeoutMs?: number;
  /** `false` turns the relay off: consumers behave as without engine-push. */
  readonly enabled?: boolean;
}

/** What `enginePush` gives other traits. */
export interface EnginePushApi {
  configure(config: EnginePushConfig & { appId?: string }): void;
  readonly enabled: boolean;
  readonly client: EnginePushClient;
  /** The engine-push owner of a user of this app. */
  userOwner(userId: string): Promise<string>;
  /** The engine-push owner of a Parse installation of this app. */
  installationOwner(installationId: string): Promise<string>;
  available(): Promise<boolean>;
  subscribe(
    userId: string,
    provider: string,
    target: string,
    name?: string,
  ): Promise<{ subscriptionId: string; existing: boolean }>;
  list(userId: string): Promise<PushSubscription[]>;
  unsubscribe(userId: string, id: string): Promise<{ ok: boolean }>;
  purgeUser(userId: string): Promise<{ deleted: number }>;
  /** `push/send` to every subscription of a user (or only `providers`). Throws `EnginePushError`. */
  sendToUser(userId: string, message: PushMessage, providers?: string[]): Promise<PushSendResult>;
  /** Keeps one subscription of `provider` with `target` for `owner` and sends to it. Throws `EnginePushError`. */
  deliver(
    owner: string,
    provider: string,
    target: string,
    message: PushMessage,
  ): Promise<PushSendResult>;
  /** A `zutool-push/1` message within engine-push's limits. */
  message(input: {
    title?: unknown;
    body?: unknown;
    kind?: unknown;
    urgency?: "normal" | "high";
    collapseKey?: unknown;
    data?: Record<string, unknown>;
  }): PushMessage;
}

const TITLE_MAX = 200;
const BODY_MAX = 4000;
const MESSAGE_FIELDS = new Set(["title", "body", "kind", "urgency", "collapseKey", "ttlS", "data"]);
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** `[A-Za-z0-9:_.@-]{1,128}`: anything else becomes `_`, and a longer owner a hash of itself. */
async function ownerOf(...parts: string[]): Promise<string> {
  const clean = parts.map((p) => p.replace(/[^A-Za-z0-9:_.@-]/g, "_"));
  const o = clean.join(":");
  if (o.length <= 128) return o;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(o)));
  return `${clean[0]}:${clean[1].slice(0, 40)}:h:${
    [...d.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")
  }`;
}

export function createEnginePushApi(
  initial: EnginePushConfig & { appId?: string } = {},
): EnginePushApi {
  let appId = initial.appId ?? "zenith";
  let enabled = initial.enabled !== false;
  let client = new EnginePushClient({ socket: initial.socket, timeoutMs: initial.timeoutMs });

  const api: EnginePushApi = {
    configure(c) {
      if (c.appId) appId = c.appId;
      enabled = c.enabled !== false;
      client = new EnginePushClient({ socket: c.socket, timeoutMs: c.timeoutMs });
    },
    get enabled() {
      return enabled;
    },
    get client() {
      return client;
    },
    userOwner: (userId) => ownerOf("zenith", appId, userId),
    installationOwner: (id) => ownerOf("zenith", appId, "installation", id),
    async available() {
      return enabled && await client.available();
    },
    async subscribe(userId, provider, target, name) {
      return client.subscribe(await api.userOwner(userId), provider, target, name);
    },
    async list(userId) {
      return client.list(await api.userOwner(userId));
    },
    async unsubscribe(userId, id) {
      return client.unsubscribe(await api.userOwner(userId), id);
    },
    async purgeUser(userId) {
      return client.purgeOwner(await api.userOwner(userId));
    },
    async sendToUser(userId, message, providers) {
      if (!enabled) throw new EnginePushError("unavailable", "enginePush is disabled");
      return client.send(await api.userOwner(userId), message, providers);
    },
    async deliver(owner, provider, target, message) {
      if (!enabled) throw new EnginePushError("unavailable", "enginePush is disabled");
      await ensureSubscription(client, owner, provider, target);
      return client.send(owner, message, [provider]);
    },
    message(input) {
      const data: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.data ?? {})) {
        if (Object.keys(data).length >= 16) break;
        if (MESSAGE_FIELDS.has(k) || v == null || typeof v === "object") continue;
        data[k] = String(v);
      }
      const m: PushMessage = {
        title: clip(text(input.title), TITLE_MAX),
        body: clip(text(input.body), BODY_MAX),
        urgency: input.urgency ?? "normal",
      };
      const kind = text(input.kind).replace(/[^A-Za-z0-9_:.-]/g, "-").slice(0, 64);
      if (kind) m.kind = kind;
      const ck = text(input.collapseKey);
      if (ck) m.collapseKey = ck;
      if (Object.keys(data).length) m.data = data;
      if (!m.title && !m.body) m.body = "…";
      return m;
    },
  };
  return api;
}

export const EnginePushTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithEnginePush",
  provides: ["enginePush"],
  consumes: [],
  state: ["enginePushConfig"],
  runtimes: ["deno"],
  summary:
    "Notices to people through zutool's engine-push daemon by its Unix socket (devices, Telegram, Slack, email), with the callers' own path when it does not answer.",
  create: () => ({ enginePush: createEnginePushApi() }),
});
