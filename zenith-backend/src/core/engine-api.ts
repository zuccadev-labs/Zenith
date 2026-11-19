/**
 * @module @zenith/core/engine-api
 *
 * Type contracts for the composed Zenith Engine.
 * Each interface describes a service that a trait (or group of traits)
 * can expose under a specific key of the composed state.
 *
 * Cloud Code developers do NOT use this directly.
 * They use the public `Zen.Cloud`, `Zen.DB`, etc. API defined in `cloud.ts`.
 *
 * @barrits-trait
 * @barrits-summary Engine API contracts — typed service interfaces
 */

import type { ZenithConfig } from "./types.ts";

/**
 * Cloud Functions service.
 * Exposed by CloudCodeTrait under the `"cloud-functions"` key.
 * Loads dynamic cloud code and defines, runs and lists cloud functions.
 */
export interface CloudFunctionService {
  /** Loads cloud code from a .ts file through a dynamic `import()`. */
  loadCloudCode: (cloudCodePath: string) => Promise<void>;
  /** Registers a cloud function programmatically and returns its name and registration time. */
  define: (
    name: string,
    fn: (request: Record<string, unknown>) => unknown,
  ) => { name: string; registeredAt: string };
  /** Runs a registered cloud function by name with the given params and request context. */
  run: (
    name: string,
    params: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Lists the names of every registered cloud function. */
  listFunctions: () => string[];
}

/**
 * Trigger service (object lifecycle hooks).
 * Exposed by CloudCodeTrait under the `"triggers"` key.
 * Runs beforeSave, afterSave, beforeFind, afterFind, etc.
 */
export interface TriggerService {
  /** Runs the beforeSave triggers registered for a class. */
  runBeforeSave: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Runs the afterSave triggers registered for a class. */
  runAfterSave: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Runs the beforeFind triggers registered for a class. */
  runBeforeFind: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Runs the afterFind triggers registered for a class. */
  runAfterFind: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Runs the beforeDelete triggers registered for a class. */
  runBeforeDelete: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Runs the afterDelete triggers registered for a class. */
  runAfterDelete: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Runs the file triggers of a phase (beforeWrite, afterWrite, beforeDelete, afterDelete). */
  runFileTrigger: (phase: string, request: Record<string, unknown>) => Promise<void>;
}

/**
 * Billing and metering service.
 * Exposed by BillingTrait under the `"billing-metering"` key.
 */
export interface BillingMeteringService {
  /** Injects the payments adapter (Stripe, etc.). */
  injectAdapter: (adapter: unknown) => void;
  /** Consumes `amount` units of a user's quota for the given metric. */
  consumeQuota: (userId: string, metric: string, amount: number) => Promise<void>;
}

/**
 * Realtime Pub/Sub service (LiveQuery).
 * Exposed by RealtimeTrait under the `"realtime-pubsub"` key.
 */
export interface RealtimePubSubService {
  /** Takes over an accepted LiveQuery WebSocket connection for the given app and session. */
  handleWebSocket: (
    socket: WebSocket,
    authPayload: { appId: string; sessionToken: string | undefined },
  ) => void;
}

/**
 * Schema and migrations service.
 * Exposed by SchemaManagementTrait and MigrationTrait.
 */
export interface SchemaService {
  /** Builds the schema from the registered traits. */
  buildSchema: () => Promise<void>;
  /** Initializes the schema with the app configuration. */
  schema_init: (config: ZenithConfig) => Promise<void>;
  /** Runs the migrations that have not been applied yet. */
  runPendingMigrations: (migrations: unknown[]) => Promise<void>;
}

/**
 * Observability service (metrics, logs, health checks).
 * Exposed by ObservabilityTrait.
 */
export interface ObservabilityService {
  /** Initializes the observability pipeline (OTel, Prometheus). */
  observability_init: () => void;
  /**
   * HTTP middleware that records per-request metrics around `next`; `routeOf` maps a request to
   * its route template so metrics are labelled by route instead of raw path.
   */
  middleware: (
    req: Request,
    next: () => Promise<Response>,
    routeOf?: (method: string, pathname: string) => string | undefined,
  ) => Promise<Response>;
  /** Liveness report served at `/_health`. */
  health: () => Promise<Record<string, unknown>>;
  /** Readiness report served at `/_ready`. */
  ready: () => Promise<Record<string, unknown>>;
  /** Structured logger. */
  log: (...args: unknown[]) => void;
}

/**
 * ACL (Access Control Lists) service.
 * Exposed by ACLTrait.
 */
export interface AclService {
  /** Initializes the ACL system with the app configuration. */
  acl_init: (config: ZenithConfig) => void;
}

/**
 * Rate limiting service.
 * Exposed by RateLimitTrait.
 */
export interface RateLimitService {
  /** Initializes the rate limiter backend (Redis, in-memory, etc.). */
  ratelimit_init: () => Promise<void>;
}

/**
 * AI / agents service.
 * Exposed by AITrait.
 */
export interface AiService {
  /** Initializes the AI providers from the app configuration. */
  ai_init: (config: ZenithConfig) => void;
}

/**
 * Cryptography service (JWT keys).
 * Exposed by CryptoTrait.
 */
export interface CryptoService {
  /** Injects the RSA key pair (PEM) used to sign and verify JWTs. */
  initKeys: (privateKey: string, publicKey: string) => void;
}

/**
 * Media streaming service (E2EE, SFU).
 * Exposed by MediaStreamTrait, E2EEKeysTrait and SFrameSignalingTrait.
 */
export interface MediaService {
  /** Sets the E2EE mode (`strict_sframe` or `hop_by_hop`). */
  setE2EEMode: (mode: string) => void;
  /** Takes over an accepted media streaming WebSocket for a room. */
  handleWebSocket: (
    socket: WebSocket,
    roomId: string,
    authPayload: { appId: string; sessionToken: string | undefined },
  ) => void;
}

/**
 * gRPC service.
 * Exposed by gRPCTrait.
 */
export interface GrpcService {
  /** Starts the gRPC server on the given port with the given service implementations. */
  startServer: (
    port: number,
    services?: Record<string, unknown>,
  ) => Promise<{ port: number; secure: boolean }>;
  /** Stops the gRPC server. */
  stopServer: () => Promise<void>;
  /** Calls a method of a remote gRPC service and resolves with its response. */
  callService: (
    address: string,
    serviceName: string,
    methodName: string,
    request: unknown,
  ) => Promise<unknown>;
}

/**
 * Composed interface of the Zenith Engine.
 * It is the result of composing the active traits and exposes every service
 * they provide as optional properties.
 *
 * Not every service is always available: it depends on the topology and
 * features configured in `ZenithConfig`.
 *
 * @example
 * const engine = composition.traits as unknown as EngineAPI;
 * if (engine["cloud-functions"]) {
 *   await engine["cloud-functions"].loadCloudCode("./cloud/main.ts");
 * }
 */
export interface EngineAPI {
  /** Cloud Functions service (available when CloudCodeTrait is active). */
  "cloud-functions"?: CloudFunctionService;
  /** Legacy alias of the cloud functions service. */
  "cloud"?: CloudFunctionService;
  /** Trigger service (beforeSave, afterSave, etc.). */
  "triggers"?: TriggerService;
  /** Billing and metering service. */
  "billing-metering"?: BillingMeteringService;
  /** LiveQuery / realtime Pub/Sub service. */
  "realtime-pubsub"?: RealtimePubSubService;
  /** gRPC service. */
  "grpc"?: GrpcService;

  // ─── Flat services (direct method aliases) ──────────────

  /** Initializes the data schema. */
  schema_init?: SchemaService["schema_init"];
  /** Builds the schema from the traits. */
  buildSchema?: SchemaService["buildSchema"];
  /** Runs pending schema migrations. */
  runPendingMigrations?: SchemaService["runPendingMigrations"];
  /** Initializes the observability pipeline. */
  observability_init?: ObservabilityService["observability_init"];
  /** Initializes the ACL system. */
  acl_init?: AclService["acl_init"];
  /** Initializes the rate limiter. */
  ratelimit_init?: RateLimitService["ratelimit_init"];
  /** Initializes the AI providers. */
  ai_init?: AiService["ai_init"];
  /** Injects the RSA keys used for JWTs. */
  initKeys?: CryptoService["initKeys"];
  /** Sets the E2EE mode. */
  setE2EEMode?: MediaService["setE2EEMode"];
  /** Takes over a media streaming WebSocket. */
  handleWebSocket?: MediaService["handleWebSocket"];

  /** Returns the engine's HTTP handler (main router), or null when no router is composed. */
  getHandler: (config: ZenithConfig) => ((req: Request) => Promise<Response>) | null;
  /** Dynamic routes registered by the traits. */
  routes?: {
    method: string;
    path: string;
    handler: (req: Request, ctx: unknown) => Promise<Response> | Response;
  }[];

  /** Index signature for additional services (plugins, custom traits). */
  [key: string]: unknown;
}
