/**
 * @module @zenith/security/api-keys/routes
 *
 * Where an app's API keys live and how they are managed over HTTP (master key only).
 *
 * - `apiKeyStoreFor(config)`: MongoDB when the app runs on MongoDB (keys survive restarts and are
 *   shared by every instance), otherwise in memory. MongoDB connects on first use.
 * - `apiKeyRoutes(...)`: GET/POST /zen/api-keys, POST /zen/api-keys/:id/revoke and /rotate. A key of
 *   another app answers 404, as if it did not exist: the store can be shared by several apps.
 *   Only the master key manages keys: an API key, even with scope `*`, is refused (403), so a stolen
 *   key cannot mint or revive keys (ADR-015). Keys follow the access policy of policy.ts.
 */
import type { ApiKeyManager, ApiKeyStore } from "./manager.ts";
import { InMemoryStore, MongoDBStore } from "./store.ts";
import { DEFAULT_SCOPES } from "./scopes.ts";
import { ApiKeyPolicyError } from "./policy.ts";
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

export function apiKeyStoreFor(
  config: { databaseURI?: string },
  warn: (m: string) => void = console.warn,
): ApiKeyStore {
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
const actorOf = (_ctx: any) => "master";
/** Key management is for the master key only (ADR-015). */
const masterOnly = <H extends (req: Request, ctx: any) => Promise<Response>>(handler: H) =>
  (async (req: Request, ctx: any) => {
    if (ctx?.apiKey) {
      throw new ZenithError(
        ZenithErrorCode.OPERATION_FORBIDDEN,
        "API keys cannot manage API keys: use the master key.",
        403,
      );
    }
    try {
      return await handler(req, ctx);
    } catch (e) {
      if (e instanceof ApiKeyPolicyError) throw bad(e.message);
      throw e;
    }
  }) as H;
const bodyOf = async (req: Request) => {
  try {
    return (await req.json()) ?? {};
  } catch (_e) {
    throw bad("Invalid JSON body.");
  }
};

/** Routes to mount with `access: "master"`. */
export function apiKeyRoutes(appId: string, manager: ApiKeyManager, store: ApiKeyStore) {
  const owned = async (id: unknown) => {
    const rec = typeof id === "string" && id ? await store.get(id) : null;
    if (!rec || rec.appId !== appId) throw ZenithErrors.notFound("ApiKey", String(id));
    return rec;
  };
  const routes = [
    {
      method: "GET" as const,
      path: "/zen/api-keys",
      access: "master" as const,
      _openapi: { tag: "API Keys", summary: "List the app's API keys (hashes only)" },
      handler: async () => json({ results: await manager.listByApp(appId) }),
    },
    {
      method: "POST" as const,
      path: "/zen/api-keys",
      access: "master" as const,
      _openapi: {
        tag: "API Keys",
        summary:
          "Create an API key; the plaintext is returned once. Scope * needs allowedIps and expiresIn of at most 90 days (ADR-015)",
      },
      handler: async (req: Request, ctx: any) => {
        const b = await bodyOf(req);
        const prefix = (b.prefix ?? "sk") as ApiKeyPrefix;
        const env = (b.env ?? "live") as ApiKeyEnv;
        if (!PREFIXES.includes(prefix)) throw bad("prefix must be sk, pk or rk.");
        if (!ENVS.includes(env)) throw bad("env must be live or test.");
        if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 100) {
          throw bad("name: 1 to 100 characters.");
        }
        const scopes = (b.scopes ?? DEFAULT_SCOPES[prefix]) as ApiKeyScope[];
        if (
          !Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => typeof s !== "string")
        ) throw bad("scopes: a non-empty list.");
        if (
          b.requestsPerMinute !== undefined &&
          !(Number.isInteger(b.requestsPerMinute) && b.requestsPerMinute > 0)
        ) {
          throw bad("requestsPerMinute: a positive integer.");
        }
        if (
          b.allowedIps !== undefined &&
          (!Array.isArray(b.allowedIps) || b.allowedIps.some((e: unknown) => typeof e !== "string"))
        ) {
          throw bad("allowedIps: a list of IP addresses or CIDR ranges.");
        }
        const created = await manager.create({
          appId,
          prefix,
          env,
          scopes,
          name: b.name.trim(),
          createdBy: actorOf(ctx),
          expiresIn: typeof b.expiresIn === "string" ? b.expiresIn : undefined,
          requestsPerMinute: b.requestsPerMinute,
          allowedIps: b.allowedIps,
        });
        // The plaintext is shown once; only its hash is stored.
        return json({ key: created.plaintext, record: created.record }, 201);
      },
    },
    {
      method: "POST" as const,
      path: "/zen/api-keys/:id/revoke",
      access: "master" as const,
      _openapi: { tag: "API Keys", summary: "Revoke an API key" },
      handler: async (req: Request, ctx: any) => {
        const rec = await owned(ctx.params?.id);
        const b = await bodyOf(req);
        await manager.revoke(
          rec.id,
          actorOf(ctx),
          typeof b.reason === "string" ? b.reason.slice(0, 500) : "",
        );
        return json({ id: rec.id, revoked: true });
      },
    },
    {
      method: "POST" as const,
      path: "/zen/api-keys/:id/rotate",
      access: "master" as const,
      _openapi: { tag: "API Keys", summary: "Rotate an API key with a grace period" },
      handler: async (req: Request, ctx: any) => {
        const rec = await owned(ctx.params?.id);
        const b = await bodyOf(req);
        const hours = b.graceHours === undefined ? 24 : Number(b.graceHours);
        if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 30) {
          throw bad("graceHours: 0 to 720.");
        }
        const rotated = await manager.rotate(rec.id, {
          createdBy: actorOf(ctx),
          gracePeriodMs: hours * 3_600_000,
        });
        return json({ key: rotated.plaintext, record: rotated.record, previous: rec.id }, 201);
      },
    },
  ];
  return routes.map((r) => ({ ...r, handler: masterOnly(r.handler) }));
}

/**
 * The /zen/api-keys routes without handlers, for the OpenAPI spec. Same list as `apiKeyRoutes`, so
 * the spec cannot document a route the server does not mount (the handlers are never called).
 */
export function apiKeyRouteSpecs(): Array<
  { method: string; path: string; access: "master"; _openapi: Record<string, unknown> }
> {
  return apiKeyRoutes("", null as never, null as never).map(({ handler: _h, ...spec }) => spec);
}
