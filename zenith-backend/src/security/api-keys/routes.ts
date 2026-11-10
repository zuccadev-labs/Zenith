/**
 * @module @zenith/security/api-keys/routes
 *
 * Where an app's API keys live and how they are managed over HTTP (master key only).
 *
 * - `apiKeyStoreFor(config)`: MongoDB when the app runs on MongoDB (keys survive restarts and are
 *   shared by every instance), otherwise in memory. MongoDB connects on first use.
 * - `apiKeyRoutes(...)`: GET/POST /zen/api-keys, POST /zen/api-keys/:id/revoke and /rotate. A key of
 *   another app answers 404, as if it did not exist: the store can be shared by several apps.
 */
import type { ApiKeyManager, ApiKeyStore } from "./manager.ts";
import { InMemoryStore, MongoDBStore } from "./store.ts";
import { DEFAULT_SCOPES } from "./scopes.ts";
import type { ApiKeyEnv, ApiKeyPrefix, ApiKeyScope } from "./types.ts";
import { ZenithError, ZenithErrorCode, ZenithErrors } from "../../core/errors.ts";

/** Connects on the first call; a failed connection is retried on the next one. */
export function lazyStore(store: ApiKeyStore & { init(): Promise<void> }): ApiKeyStore {
  let ready: Promise<void> | null = null;
  const init = () => (ready ??= store.init().catch((e) => {
    ready = null;
    throw e;
  }));
  const call = <K extends keyof ApiKeyStore>(k: K) => async (...a: Parameters<ApiKeyStore[K]>) => {
    await init();
    return await (store[k] as (...x: unknown[]) => unknown)(...a);
  };
  return {
    get: call("get"),
    listByApp: call("listByApp"),
    put: call("put"),
    update: call("update"),
    delete: call("delete"),
  } as ApiKeyStore;
}

export function apiKeyStoreFor(config: { databaseURI?: string }, warn: (m: string) => void = console.warn): ApiKeyStore {
  const uri = config.databaseURI ?? "";
  if (/^mongodb(\+srv)?:\/\//.test(uri)) return lazyStore(new MongoDBStore({ uri }));
  warn("[api-keys] No MongoDB: API keys live in memory and are lost on restart.");
  return new InMemoryStore();
}

const PREFIXES: ApiKeyPrefix[] = ["sk", "pk", "rk"];
const ENVS: ApiKeyEnv[] = ["live", "test"];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (msg: string) => new ZenithError(ZenithErrorCode.INVALID_JSON, msg, 400);
const actorOf = (ctx: any) => (ctx?.apiKey?.id ? `apikey:${ctx.apiKey.id}` : "master");
const bodyOf = async (req: Request) => {
  try { return (await req.json()) ?? {}; } catch (_e) { throw bad("Invalid JSON body."); }
};

/** Routes to mount with `access: "master"`. */
export function apiKeyRoutes(appId: string, manager: ApiKeyManager, store: ApiKeyStore) {
  const owned = async (id: unknown) => {
    const rec = typeof id === "string" && id ? await store.get(id) : null;
    if (!rec || rec.appId !== appId) throw ZenithErrors.notFound("ApiKey", String(id));
    return rec;
  };
  return [
    {
      method: "GET" as const,
      path: "/zen/api-keys",
      handler: async () => json({ results: await manager.listByApp(appId) }),
    },
    {
      method: "POST" as const,
      path: "/zen/api-keys",
      handler: async (req: Request, ctx: any) => {
        const b = await bodyOf(req);
        const prefix = (b.prefix ?? "sk") as ApiKeyPrefix;
        const env = (b.env ?? "live") as ApiKeyEnv;
        if (!PREFIXES.includes(prefix)) throw bad("prefix must be sk, pk or rk.");
        if (!ENVS.includes(env)) throw bad("env must be live or test.");
        if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 100) throw bad("name: 1 to 100 characters.");
        const scopes = (b.scopes ?? DEFAULT_SCOPES[prefix]) as ApiKeyScope[];
        if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => typeof s !== "string")) throw bad("scopes: a non-empty list.");
        if (b.requestsPerMinute !== undefined && !(Number.isInteger(b.requestsPerMinute) && b.requestsPerMinute > 0)) {
          throw bad("requestsPerMinute: a positive integer.");
        }
        const created = await manager.create({
          appId, prefix, env, scopes, name: b.name.trim(), createdBy: actorOf(ctx),
          expiresIn: typeof b.expiresIn === "string" ? b.expiresIn : undefined,
          requestsPerMinute: b.requestsPerMinute,
        });
        // The plaintext is shown once; only its hash is stored.
        return json({ key: created.plaintext, record: created.record }, 201);
      },
    },
    {
      method: "POST" as const,
      path: "/zen/api-keys/:id/revoke",
      handler: async (req: Request, ctx: any) => {
        const rec = await owned(ctx.params?.id);
        const b = await bodyOf(req);
        await manager.revoke(rec.id, actorOf(ctx), typeof b.reason === "string" ? b.reason.slice(0, 500) : "");
        return json({ id: rec.id, revoked: true });
      },
    },
    {
      method: "POST" as const,
      path: "/zen/api-keys/:id/rotate",
      handler: async (req: Request, ctx: any) => {
        const rec = await owned(ctx.params?.id);
        const b = await bodyOf(req);
        const hours = b.graceHours === undefined ? 24 : Number(b.graceHours);
        if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 30) throw bad("graceHours: 0 to 720.");
        const rotated = await manager.rotate(rec.id, { createdBy: actorOf(ctx), gracePeriodMs: hours * 3_600_000 });
        return json({ key: rotated.plaintext, record: rotated.record, previous: rec.id }, 201);
      },
    },
  ];
}
