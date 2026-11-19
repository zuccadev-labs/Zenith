/**
 * @module @zenith/core/types
 * Tipos compartidos del núcleo de Zenith.
 *
 * Todos los tipos son inmutables (readonly) por diseño.
 * Ningún Trait debe importar tipos de otros Traits directamente —
 * deben usar estos tipos compartidos del core para mantener el desacoplamiento.
 */

// ─── Configuración del Servidor ───────────────────────────────────────────────

/**
 * Configuration of one Zenith application (one entry of `apps.config.ts`). It decides which traits
 * are composed (`features`, `topology`), how clients authenticate and which external services the
 * engine connects to. Passed to `createZenithApp()`.
 */
export interface ZenithConfig {
  /** Application id; clients send it as `Zen-Application-Id` (or `X-Parse-Application-Id`). */
  readonly appId: string;
  /** Static master key: grants full access, bypassing ACLs. Keep it server-side only. */
  readonly masterKey: string;
  /** Parse-compatible client SDK key (`Zen-JavaScript-Key`). Accepted in the config for parity. */
  readonly javascriptKey?: string;
  /** Parse-compatible REST key (`Zen-Api-Key` / `X-Parse-REST-API-Key`). Accepted for parity. */
  readonly restApiKey?: string;
  /** Parse-compatible client key (`Zen-Client-Key`). Accepted in the config for parity. */
  readonly clientKey?: string;
  /** Public URL of the server; used as the `servers` entry of the OpenAPI spec. */
  readonly serverURL: string;
  /** HTTP port the server listens on (the default server uses 23614). */
  readonly port: number;
  /** Path of the cloud code module loaded at boot (`Zen.Cloud.define`, triggers, jobs). */
  readonly cloudCodePath?: string;
  /** Directory of signed plugins verified and loaded at boot. */
  readonly pluginsPath?: string;
  /** Commands the shell trait may run (default `git`, `vault`, `kubectl`, `lux-db`). */
  readonly allowedShellCommands?: string[];
  /** Whether clients may create classes by writing to them; false unless explicitly `true`. */
  readonly allowClientClassCreation?: boolean;
  /** Parse-compatible switch for anonymous users. Reserved; the engine does not read it yet. */
  readonly enableAnonymousUsers?: boolean;
  /** Zero-trust mode switch. Reserved; the engine does not read it yet. */
  readonly zeroTrustMode?: boolean;
  /** Lifetime of issued JWTs in seconds. Reserved; the engine does not read it yet. */
  readonly jwtExpirationSeconds?: number;
  /** RSA modulus size for generated JWT keys. Reserved; the engine does not read it yet. */
  readonly rsaKeySize?: number;
  /** Maximum session age in seconds. Reserved; the engine does not read it yet. */
  readonly sessionMaxAge?: number;

  /**
   * IPs of trusted reverse proxies (Nginx, Cloudflare, AWS ALB). X-Forwarded-For is only trusted
   * to find the real client IP when the request comes from one of them; when empty, the TCP socket
   * address is used. Prevents bypassing IP restrictions with forged headers.
   */
  readonly trustedProxies?: string[];

  /**
   * engine-auth: users, sessions and token verification (Parse `/users`, `/login`, `/logout`,
   * `/users/me`, and `Authorization: Bearer` from any service of the ecosystem).
   * Without it the user routes answer 503 and every request is anonymous.
   */
  readonly engineAuth?: import("../traits/auth/engine-auth.ts").EngineAuthConfig;

  /**
   * engine-push (zutool): socket and timeout of the daemon that delivers notices to people. Without it,
   * the zutool convention (`ENGINE_PUSH_SOCKET`, `$XDG_RUNTIME_DIR/zutool/engine-push.sock`). When the
   * socket does not answer, push and notifications keep their own path.
   */
  readonly enginePush?: import("../traits/push/engine-push.trait.ts").EnginePushConfig;

  /**
   * Cells (ADR-019): provider (`local` by default, `celld` experimental), directory, limits, KV and
   * Queue bindings. Without it, the local provider in `ZENITH_CELLS_DIR` (or `.zenith/cells`).
   */
  readonly cells?: import("../traits/cells/api.ts").CellsConfig;

  /** Log folder (Parse parity). Reserved; the engine does not read it yet. */
  readonly logsFolder?: string;
  /** OpenTelemetry exporter: collector `endpoint` and optional `serviceName`. */
  readonly openTelemetry?: {
    readonly endpoint: string;
    readonly serviceName?: string;
  };

  /** LiveQuery (Parse parity): the classes whose changes are pushed to subscribers. */
  readonly liveQuery?: {
    readonly classNames: string[];
  };

  /** Media LiveQuery (Zenith only): classes streamed as media rooms, optionally recorded. */
  readonly mediaLiveQuery?: {
    readonly classNames: string[];
    readonly enableRecording?: boolean;
  };

  /**
   * Secret Key used to authenticate internal ZeroMQ cluster RPC calls.
   * If set, only nodes knowing this secret can execute cross-app queries.
   */
  readonly clusterSecret?: string;

  /**
   * API key dedicated to managing remote webhooks, so that the master key alone is not enough to
   * register webhook targets (limits SSRF through webhooks).
   */
  readonly webhookKey?: string;

  /**
   * Port on which the ZeroMQ transport server will listen.
   * Required for node-to-node RPC Federation.
   */
  readonly zmqPort?: number;

  /**
   * Node topology: the transports and roles this node serves, from a specialized server to a
   * monolith. Default: `["http"]`.
   */
  readonly topology?: Array<"http" | "grpc" | "zeromq" | "runner" | "ai" | "graphql">;
  /** Database connection URI (`mongodb://`, `scylla://`, `surreal://`, etc.). */
  readonly databaseURI?: string;

  /** Multi-provider AI configuration: default provider and model plus per-provider credentials. */
  readonly aiConfig?: {
    readonly defaultProvider: "openai" | "anthropic" | "gemini" | "ollama" | "custom";
    readonly defaultModel: string;
    readonly ollamaUrl?: string; // Default: http://localhost:11434
    readonly openAIApiKey?: string;
    readonly anthropicApiKey?: string;
    readonly geminiApiKey?: string;
    readonly customOpenAIEndpoint?: string; // Para LM Studio, vLLM, etc.
  };

  /**
   * Feature flags (attack surface reduction): turn business layers on or off so pure
   * infrastructure instances expose only what they need. Each flag maps to the traits it enables.
   */
  readonly features?: {
    readonly saas?: boolean; // Activa BillingTrait (Facturación y Pagos)
    readonly ai?: boolean; // Activa AITrait (Agentes LLM y Tokens)
    readonly ecommerce?: boolean; // Activa OpenSearchTrait (Búsqueda B2C y Productos)
    readonly gdpr?: boolean; // Activa SegmentationTrait (Derecho al olvido, Data Portability)

    // Fase 20: El Titán Distribuido
    readonly edge?: boolean; // Activa EdgeTrait (WebAssembly Sandboxing)
    readonly events?: boolean; // Activa EventStreamingTrait (Kafka / CQRS)
    readonly web3?: boolean; // Activa Web3Trait (Logins Crypto e IPFS)
    readonly federation?: boolean; // Activa FederationTrait (Replicación Activo-Activo CRDT)
    readonly graph?: boolean; // Activa GraphAdapter (Neo4j para relaciones complejas)

    // Fase 21: Military-Grade E2EE Media & Signaling
    readonly e2ee_media?: boolean; // Activa E2EEKeysTrait y SFrameSignalingTrait
    readonly e2ee_mode?: "strict_sframe" | "hop_by_hop"; // "strict_sframe" (Zero-Knowledge) o "hop_by_hop" (estándar SFU)

    // Phase 3.A: features adicionales detectados en mod.ts
    readonly vectordb?: boolean; // Activa VectorDBTrait (Qdrant, Milvus, Weaviate)
    readonly iot?: boolean; // Activa IoTTrait (MQTT, CoAP, device shadow)
    readonly agents?: boolean; // Activa AgentOrchestratorTrait (multi-agent workflows)
    readonly timeseries?: boolean; // Activa TimeSeriesTrait (InfluxDB, TimescaleDB, Scylla)
    readonly workflow?: boolean; // Activa WorkflowTrait (BPMN, state machines, cron)
    readonly multiTenant?: boolean; // Activa TenantTrait (row-level isolation, tenant routing)
    readonly compliance?: boolean; // Activa ComplianceTrait (SOC2, HIPAA, GDPR reporting)

    // Activos salvo que se pongan a false
    readonly cache?: boolean; // CacheTrait
    readonly queue?: boolean; // JobQueueTrait
    readonly resilience?: boolean; // CircuitBreakerTrait
    readonly push?: boolean; // PushTrait (desactivado por defecto)
    readonly cells?: boolean; // CellsTrait (ADR-019): celdas/Durable Objects, sesiones de agentes

    /**
     * Cualquier otra pieza del catálogo (`src/traits/catalog.ts`) por su id: `crm: false`,
     * `webhooks: false`, `graphql: false`… El núcleo no se puede desactivar.
     */
    readonly [feature: string]: boolean | string | undefined;
  };
}

// ─── Request / Response Lifecycle ─────────────────────────────────────────────

export interface ZenithRequestContext {
  readonly appId: string;
  /** Client address from the socket, or from X-Forwarded-For only behind `trustedProxies` (H-02). */
  readonly clientIp?: string;
  /**
   * [H-02] Flag booleano: `true` si la request se autenticó con la master key
   * estática (o el JWT Zen-Internal-Token). NUNCA contiene el valor real de
   * la key — solo el hecho de que fue validada. Esto previene que la key
   * aparezca en logs serializados del contexto.
   */
  readonly masterKey?: boolean;
  readonly javascriptKey?: string;
  readonly restApiKey?: string;
  readonly clientKey?: string;
  readonly tenantId?: string;
  readonly workspaceId?: string;
  readonly sessionToken?: string;
  readonly clientVersion?: string;
  readonly installationId?: string;
  readonly auth?: ZenithAuthContext;
  readonly params?: Record<string, string>;
  /**
   * [H-2/H-3 mitigation] Contexto de la API key verificada (si la request
   * se autenticó vía API key estilo Stripe en lugar de master key estática).
   * Ver src/security/api-keys/middleware.ts.
   */
  readonly apiKey?: {
    readonly id: string;
    readonly prefix: "sk" | "pk" | "rk";
    readonly env: "live" | "test";
    readonly appId: string;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly rateLimit: { readonly requestsPerMinute: number };
  };
  /** Motivo por el cual NO se autenticó vía API key (si vino master key) */
  readonly apiKeyRejected?: string;
}

export interface ZenithAuthContext {
  readonly userId: string;
  readonly roles: string[];
  /** Directory groups from engine-auth (LDAP/FreeIPA), when the token carries them. */
  readonly groups?: string[];
  readonly scope?: string;
  /** engine-auth client that obtained the token. */
  readonly clientId?: string;
  /** engine-auth session id (`sid`). */
  readonly sessionId?: string;
  /** RFC 8693 actor (`act.sub`): the agent acting on the user's behalf. */
  readonly actor?: string;
  /** `session` (Parse session token) or `bearer` (access token presented directly). */
  readonly via?: "session" | "bearer";
}

// ─── Operaciones CRUD ─────────────────────────────────────────────────────────

/** A Parse-style query on a class. */
export interface ZenithQuery {
  /** Filter: field equality or operators such as `$gt`, `$in`, `$regex`. */
  readonly where?: Record<string, unknown>;
  /** Comma-separated sort keys; a leading `-` sorts descending. */
  readonly order?: string;
  /** Maximum number of objects returned. */
  readonly limit?: number;
  /** Number of matching objects skipped before the first one returned. */
  readonly skip?: number;
  /** Pointer fields to resolve into full objects. */
  readonly include?: string[];
  /** Fields to return (projection); all fields when omitted. */
  readonly keys?: string[];
  /** Whether to also return the total number of matches. */
  readonly count?: boolean;
}

/** A stored object: system fields plus the class's own fields. */
export interface ZenithObject {
  /** Unique id within its class, assigned on insert. */
  readonly objectId?: string;
  /** Creation time, set by the database adapter. */
  readonly createdAt?: Date;
  /** Last update time, set by the database adapter. */
  readonly updatedAt?: Date;
  /** Class (collection) the object belongs to. */
  readonly className?: string;
  /** The class's own fields. */
  readonly [key: string]: unknown;
}

export type ZenithWriteOperation = "create" | "update" | "delete";

// ─── Hooks del Ciclo de Vida ───────────────────────────────────────────────────

export interface HookRequest<T = ZenithObject> {
  readonly object: T;
  readonly original?: T;
  readonly context?: Record<string, unknown>;
  readonly auth?: ZenithAuthContext;
}

export interface HookResponse<T = ZenithObject> {
  readonly object: T;
  readonly message?: string;
}

// ─── Streaming y Media ─────────────────────────────────────────────────────────

export type StreamProtocol = "webrtc" | "rtmp" | "hls" | "dash";

export interface MediaStreamConfig {
  readonly streamId: string;
  readonly protocol: StreamProtocol;
  readonly record?: boolean;
  readonly storagePath?: string;
}

// ─── Adapters (interfaces mínimas) ────────────────────────────────────────────

/** Minimal contract every database adapter (MongoDB, ScyllaDB, SurrealDB…) implements. */
export interface DatabaseAdapter {
  /** Opens the connection to the database at `uri`. */
  connect(uri: string): Promise<void>;
  /** Returns the objects of `collection` that match `query`. */
  find(collection: string, query: ZenithQuery): Promise<ZenithObject[]>;
  /** Returns the first object of `collection` that matches `query`, or null. */
  findOne(collection: string, query: ZenithQuery): Promise<ZenithObject | null>;
  /** Inserts `data` into `collection` and returns the stored object (with its id). */
  insert(collection: string, data: ZenithObject): Promise<ZenithObject>;
  /** Applies `data` to the object `objectId` and returns the updated object. */
  update(collection: string, objectId: string, data: Partial<ZenithObject>): Promise<ZenithObject>;
  /**
   * Atomically updates only if the document meets the conditions (equality or `$gte`).
   * Returns null when it was not applied. Optional: not every engine can guarantee it.
   */
  updateIf?(
    collection: string,
    objectId: string,
    conditions: Record<string, unknown>,
    data: Partial<ZenithObject>,
  ): Promise<ZenithObject | null>;
  /** Lists the names of the existing classes (collections), when the engine supports it. */
  listClasses?(): Promise<string[]>;
  /** Deletes the object `objectId` from `collection`. */
  delete(collection: string, objectId: string): Promise<void>;
  /** Closes the connection. */
  disconnect(): Promise<void>;
}

export interface StorageAdapter {
  upload(path: string, data: Uint8Array, contentType: string): Promise<string>;
  download(path: string): Promise<Uint8Array>;
  delete: (path: string) => Promise<void>;
  getSignedUrl: (path: string, expiresIn?: number) => Promise<string>;

  startResumableUpload?: (path: string, contentType: string) => Promise<string>;
  uploadChunk?: (
    path: string,
    uploadId: string,
    partNumber: number,
    data: Uint8Array,
  ) => Promise<string>;
  completeResumableUpload?: (
    path: string,
    uploadId: string,
    parts: { PartNumber: number; ETag: string }[],
  ) => Promise<void>;
}

export interface AuthAdapter {
  authenticate(credentials: Record<string, unknown>): Promise<ZenithAuthContext | null>;
  validateToken(token: string): Promise<ZenithAuthContext | null>;
  createSession(userId: string): Promise<string>;
  revokeSession(token: string): Promise<void>;
}

export interface MailAdapter {
  sendMail(options: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
    from?: string;
  }): Promise<void>;
}

export interface SearchAdapter {
  connect(uri: string): Promise<void>;
  indexDocument(index: string, id: string, document: any): Promise<void>;
  search(
    index: string,
    query: Record<string, any>,
    options?: { limit?: number; skip?: number },
  ): Promise<any[]>;
  vectorSearch(
    index: string,
    vectorField: string,
    vector: number[],
    limit?: number,
  ): Promise<any[]>;
  deleteDocument(index: string, id: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface EventBusAdapter {
  connect(brokers: string[]): Promise<void>;
  publish(topic: string, event: { type: string; payload: any; timestamp: Date }): Promise<void>;
  subscribe(topic: string, handler: (event: any) => Promise<void>): Promise<void>;
  disconnect(): Promise<void>;
}

export interface GraphAdapter {
  connect(uri: string, user: string, pass: string): Promise<void>;
  runCypher(query: string, params?: Record<string, any>): Promise<any[]>;
  disconnect(): Promise<void>;
}

// ─── Plugins Interfaces ────────────────────────────────────────────────────────

export interface ZenCacheAdapter {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
}

export interface ZenVaultAdapter {
  /** True si Vault está activo (VAULT_ADDR configurado y cliente inicializado). */
  isActive(): boolean;
  /** Acceso directo al VaultClient HTTP. Lanza si no está activo. */
  client(): unknown; // Tipado narrow en runtime; ver src/security/secrets/vault-client.ts

  // Auth
  loginAppRole(roleId: string, secretId: string, mountPath?: string): Promise<unknown>;
  loginKubernetes(role: string, jwtPath?: string, mountPath?: string): Promise<unknown>;
  loginUserpass(username: string, password: string, mountPath?: string): Promise<unknown>;

  // KV v2
  kvGet(path: string, version?: number): Promise<unknown>;
  kvPut(path: string, data: Record<string, unknown>): Promise<unknown>;
  kvList(path: string): Promise<string[]>;
  kvDelete(path: string, versions?: number[]): Promise<void>;

  // PKI
  pkiIssue(
    role: string,
    commonName: string,
    opts?: { altNames?: string[]; ipSans?: string[]; ttl?: string },
  ): Promise<unknown>;

  // Transit
  transitEncrypt(keyName: string, plaintext: string): Promise<string>;
  transitDecrypt(keyName: string, ciphertext: string): Promise<string>;

  // Legacy CLI
  authenticate(username: string, password: string): Promise<string>;
  readSecret(path: string): Promise<Record<string, any>>;
}

export interface ZenGitAdapter {
  clonePrivateRepo(repoUrl: string, token: string, destinationDir: string): Promise<string>;
  configureKubeconfig(clusterName: string, token: string, serverUrl: string): Promise<void>;
}

export interface ZenithPluginsRegistry {
  CacheAdapter?: ZenCacheAdapter;
  Vault?: ZenVaultAdapter;
  Git?: ZenGitAdapter;
  [key: string]: any; // Permite extensión para plugins genéricos, pero tipa los core
}
