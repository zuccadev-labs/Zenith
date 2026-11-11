/**
 * @module @zenith/core/engine-api
 *
 * Contratos de tipos para el Engine compuesto de Zenith.
 * Cada interfaz describe un servicio que un trait (o grupo de traits)
 * puede exponer bajo una clave específica en el state compuesto.
 *
 * Los desarrolladores de Cloud Code NO usan esto directamente.
 * Usan la API pública `Zen.Cloud`, `Zen.DB`, etc. definida en `cloud.ts`.
 *
 * @barrits-trait
 * @barrits-summary Engine API contracts — typed service interfaces
 */

import type { ZenithConfig } from "./types.ts";

/**
 * Servicio de Cloud Functions.
 * Expuesto por CloudCodeTrait bajo la clave `"cloud-functions"`.
 * Permite cargar cloud code dinámico, definir funciones, ejecutarlas y listarlas.
 */
export interface CloudFunctionService {
  /** Carga cloud code desde un archivo .ts via `import()` dinámico */
  loadCloudCode: (cloudCodePath: string) => Promise<void>;
  /** Define una función cloud programáticamente */
  define: (
    name: string,
    fn: (request: Record<string, unknown>) => unknown,
  ) => { name: string; registeredAt: string };
  /** Ejecuta una función cloud por nombre */
  run: (
    name: string,
    params: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Lista todas las funciones cloud registradas */
  listFunctions: () => string[];
}

/**
 * Servicio de Triggers (hooks de ciclo de vida).
 * Expuesto por CloudCodeTrait bajo la clave `"triggers"`.
 * Ejecuta beforeSave, afterSave, beforeFind, afterFind, etc.
 */
export interface TriggerService {
  /** Ejecuta triggers beforeSave para una clase */
  runBeforeSave: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Ejecuta triggers afterSave para una clase */
  runAfterSave: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Ejecuta triggers beforeFind para una clase */
  runBeforeFind: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Ejecuta triggers afterFind para una clase */
  runAfterFind: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Ejecuta triggers beforeDelete para una clase */
  runBeforeDelete: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Ejecuta triggers afterDelete para una clase */
  runAfterDelete: (className: string, request: Record<string, unknown>) => Promise<void>;
  /** Ejecuta triggers de archivo (beforeWrite, afterWrite, beforeDelete, afterDelete) */
  runFileTrigger: (phase: string, request: Record<string, unknown>) => Promise<void>;
}

/**
 * Servicio de Facturación y Metering.
 * Expuesto por BillingTrait bajo la clave `"billing-metering"`.
 */
export interface BillingMeteringService {
  /** Inyecta el adaptador de pagos (Stripe, etc.) */
  injectAdapter: (adapter: unknown) => void;
  /** Consume cuota de un usuario para una métrica específica */
  consumeQuota: (userId: string, metric: string, amount: number) => Promise<void>;
}

/**
 * Servicio de Realtime Pub/Sub (LiveQuery).
 * Expuesto por RealtimeTrait bajo la clave `"realtime-pubsub"`.
 */
export interface RealtimePubSubService {
  /** Maneja la conexión WebSocket de LiveQuery */
  handleWebSocket: (
    socket: WebSocket,
    authPayload: { appId: string; sessionToken: string | undefined },
  ) => void;
}

/**
 * Servicio de Schema y Migraciones.
 * Expuesto por SchemaManagementTrait y MigrationTrait.
 */
export interface SchemaService {
  /** Construye el schema a partir de los traits registrados */
  buildSchema: () => Promise<void>;
  /** Inicializa el schema con la configuración de la app */
  schema_init: (config: ZenithConfig) => Promise<void>;
  /** Ejecuta migraciones pendientes */
  runPendingMigrations: (migrations: unknown[]) => Promise<void>;
}

/**
 * Servicio de Observabilidad (métricas, logs, health checks).
 * Expuesto por ObservabilityTrait.
 */
export interface ObservabilityService {
  /** Inicializa el pipeline de observabilidad (OTel, Prometheus) */
  observability_init: () => void;
  /** Middleware HTTP que registra métricas por request */
  middleware: (
    req: Request,
    next: () => Promise<Response>,
    routeOf?: (method: string, pathname: string) => string | undefined,
  ) => Promise<Response>;
  /** Health check endpoint /_health */
  health: () => Promise<Record<string, unknown>>;
  /** Readiness check endpoint /_ready */
  ready: () => Promise<Record<string, unknown>>;
  /** Logger estructurado */
  log: (...args: unknown[]) => void;
}

/**
 * Servicio de ACL (Access Control Lists).
 * Expuesto por ACLTrait.
 */
export interface AclService {
  /** Inicializa el sistema de ACLs con la configuración de la app */
  acl_init: (config: ZenithConfig) => void;
}

/**
 * Servicio de Rate Limiting.
 * Expuesto por RateLimitTrait.
 */
export interface RateLimitService {
  /** Inicializa el rate limiter (Redis, in-memory, etc.) */
  ratelimit_init: () => Promise<void>;
}

/**
 * Servicio de AI/Agentes.
 * Expuesto por AITrait.
 */
export interface AiService {
  /** Inicializa los proveedores de AI */
  ai_init: (config: ZenithConfig) => void;
}

/**
 * Servicio de Criptografía (JWT keys).
 * Expuesto por CryptoTrait.
 */
export interface CryptoService {
  /** Inyecta las llaves RSA para firmar/verificar JWTs */
  initKeys: (privateKey: string, publicKey: string) => void;
}

/**
 * Servicio de Media Streaming (E2EE, SFU).
 * Expuesto por MediaStreamTrait, E2EEKeysTrait, SFrameSignalingTrait.
 */
export interface MediaService {
  /** Configura el modo E2EE (strict_sframe | hop_by_hop) */
  setE2EEMode: (mode: string) => void;
  /** Maneja WebSocket de streaming de medios */
  handleWebSocket: (
    socket: WebSocket,
    roomId: string,
    authPayload: { appId: string; sessionToken: string | undefined },
  ) => void;
}

/**
 * Servicio de gRPC.
 * Expuesto por gRPCTrait.
 */
export interface GrpcService {
  /** Inicia el servidor gRPC en el puerto especificado */
  startServer: (
    port: number,
    services?: Record<string, unknown>,
  ) => Promise<{ port: number; secure: boolean }>;
  /** Detiene el servidor gRPC */
  stopServer: () => Promise<void>;
  /** Llama a un servicio gRPC remoto */
  callService: (
    address: string,
    serviceName: string,
    methodName: string,
    request: unknown,
  ) => Promise<unknown>;
}

/**
 * Interfaz compuesta del Engine de Zenith.
 * Es el resultado de `composeTraitDescriptors()` y expone todos los servicios
 * de los traits activos como propiedades opcionales.
 *
 * No todos los servicios están disponibles siempre — dependen de la topología
 * y features configurados en `ZenithConfig`.
 *
 * @example
 * const engine = composition.traits as unknown as EngineAPI;
 * if (engine["cloud-functions"]) {
 *   await engine["cloud-functions"].loadCloudCode("./cloud/main.ts");
 * }
 */
export interface EngineAPI {
  /** Servicio de Cloud Functions (disponible si CloudCodeTrait está activo) */
  "cloud-functions"?: CloudFunctionService;
  /** Alias del servicio cloud (legacy) */
  "cloud"?: CloudFunctionService;
  /** Servicio de Triggers (beforeSave, afterSave, etc.) */
  "triggers"?: TriggerService;
  /** Servicio de facturación/metering */
  "billing-metering"?: BillingMeteringService;
  /** Servicio de LiveQuery / Realtime PubSub */
  "realtime-pubsub"?: RealtimePubSubService;
  /** Servicio de gRPC */
  "grpc"?: GrpcService;

  // ─── Servicios planos (alias directos de métodos) ──────────────

  /** Inicializa el schema de datos */
  schema_init?: SchemaService["schema_init"];
  /** Construye el schema a partir de los traits */
  buildSchema?: SchemaService["buildSchema"];
  /** Ejecuta migraciones de schema pendientes */
  runPendingMigrations?: SchemaService["runPendingMigrations"];
  /** Inicializa el pipeline de observabilidad */
  observability_init?: ObservabilityService["observability_init"];
  /** Inicializa el sistema de ACLs */
  acl_init?: AclService["acl_init"];
  /** Inicializa el rate limiter */
  ratelimit_init?: RateLimitService["ratelimit_init"];
  /** Inicializa los proveedores de AI */
  ai_init?: AiService["ai_init"];
  /** Inyecta las llaves RSA para JWT */
  initKeys?: CryptoService["initKeys"];
  /** Configura el modo E2EE */
  setE2EEMode?: MediaService["setE2EEMode"];
  /** Maneja WebSocket de medios */
  handleWebSocket?: MediaService["handleWebSocket"];

  /** Obtiene el handler HTTP del engine (router principal) */
  getHandler: (config: ZenithConfig) => ((req: Request) => Promise<Response>) | null;
  /** Rutas dinámicas registradas por los traits */
  routes?: {
    method: string;
    path: string;
    handler: (req: Request, ctx: unknown) => Promise<Response> | Response;
  }[];

  /** Index signature para servicios adicionales (plugins, traits custom) */
  [key: string]: unknown;
}
