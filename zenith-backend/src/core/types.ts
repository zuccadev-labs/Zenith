/**
 * @module @zenith/core/types
 * Tipos compartidos del núcleo de Zenith.
 * 
 * Todos los tipos son inmutables (readonly) por diseño.
 * Ningún Trait debe importar tipos de otros Traits directamente —
 * deben usar estos tipos compartidos del core para mantener el desacoplamiento.
 */

// ─── Configuración del Servidor ───────────────────────────────────────────────

export interface ZenithConfig {
  readonly appId: string;
  readonly masterKey: string;
  readonly javascriptKey?: string;
  readonly restApiKey?: string;
  readonly clientKey?: string;
  readonly serverURL: string;
  readonly port: number;
  readonly cloudCodePath?: string;
  readonly pluginsPath?: string;
  readonly allowedShellCommands?: string[];
  readonly allowClientClassCreation?: boolean;
  readonly enableAnonymousUsers?: boolean;
  readonly zeroTrustMode?: boolean;
  readonly jwtExpirationSeconds?: number;
  readonly rsaKeySize?: number;
  readonly sessionMaxAge?: number;

  /**
   * Lista de IPs de proxies reversos confiables (Nginx, Cloudflare, AWS ALB).
   * Solo cuando la request proviene de estas IPs se confiará en X-Forwarded-For
   * para determinar la IP real del cliente. Si está vacío, se usa la IP del socket TCP.
   * Grado Militar: Previene el bypass de restricciones por IP usando headers manipulados.
   */
  readonly trustedProxies?: string[];

  /**
   * engine-auth: users, sessions and token verification (Parse `/users`, `/login`, `/logout`,
   * `/users/me`, and `Authorization: Bearer` from any service of the ecosystem).
   * Without it the user routes answer 503 and every request is anonymous.
   */
  readonly engineAuth?: import("../traits/auth/engine-auth.ts").EngineAuthConfig;
  
  /**
   * Configuración de Logs y Observabilidad (Parse Parity)
   */
  readonly logsFolder?: string;
  readonly openTelemetry?: {
    readonly endpoint: string;
    readonly serviceName?: string;
  };

  /**
   * Configuración de LiveQuery (Parse Parity)
   */
  readonly liveQuery?: {
    readonly classNames: string[];
  };

  /**
   * Configuración de Media LiveQuery (Zenith Exclusive)
   */
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
   * Clave API dedicada exclusivamente a la administración de Webhooks Remotos.
   * Grado Militar: Previene que un atacante con Master Key abuse de SSRF vía Webhooks.
   */
  readonly webhookKey?: string;

  /**
   * Port on which the ZeroMQ transport server will listen.
   * Required for node-to-node RPC Federation.
   */
  readonly zmqPort?: number;
  
  /**
   * Topología del Nodo (Enterprise Architecture Phase 11)
   * Permite instanciar un servidor especializado o un monolito.
   * Por defecto: ["http"]
   */
  readonly topology?: Array<"http" | "grpc" | "zeromq" | "runner" | "ai" | "graphql">;
  readonly databaseURI?: string; // mongodb://, scylla://, surreal://, etc.
  
  /**
   * Configuración Multi-Proveedor para Inteligencia Artificial (Fase 12)
   */
  readonly aiConfig?: {
    readonly defaultProvider: "openai" | "anthropic" | "gemini" | "ollama" | "custom";
    readonly defaultModel: string;
    readonly ollamaUrl?: string;     // Default: http://localhost:11434
    readonly openAIApiKey?: string;
    readonly anthropicApiKey?: string;
    readonly geminiApiKey?: string;
    readonly customOpenAIEndpoint?: string; // Para LM Studio, vLLM, etc.
  };

  /**
   * Feature Flags (Reducción de Superficie de Ataque) (Fase 19)
   * Permite activar o desactivar capas de negocio para minimizar riesgos
   * en instancias de pura infraestructura.
   */
  readonly features?: {
    readonly saas?: boolean;      // Activa BillingTrait (Facturación y Pagos)
    readonly ai?: boolean;        // Activa AITrait (Agentes LLM y Tokens)
    readonly ecommerce?: boolean; // Activa OpenSearchTrait (Búsqueda B2C y Productos)
    readonly gdpr?: boolean;      // Activa SegmentationTrait (Derecho al olvido, Data Portability)
    
    // Fase 20: El Titán Distribuido
    readonly edge?: boolean;       // Activa EdgeTrait (WebAssembly Sandboxing)
    readonly events?: boolean;     // Activa EventStreamingTrait (Kafka / CQRS)
    readonly web3?: boolean;       // Activa Web3Trait (Logins Crypto e IPFS)
    readonly federation?: boolean; // Activa FederationTrait (Replicación Activo-Activo CRDT)
    readonly graph?: boolean;      // Activa GraphAdapter (Neo4j para relaciones complejas)
    
    // Fase 21: Military-Grade E2EE Media & Signaling
    readonly e2ee_media?: boolean; // Activa E2EEKeysTrait y SFrameSignalingTrait
    readonly e2ee_mode?: "strict_sframe" | "hop_by_hop"; // "strict_sframe" (Zero-Knowledge) o "hop_by_hop" (estándar SFU)

    // Phase 3.A: features adicionales detectados en mod.ts
    readonly vectordb?: boolean;    // Activa VectorDBTrait (Qdrant, Milvus, Weaviate)
    readonly iot?: boolean;         // Activa IoTTrait (MQTT, CoAP, device shadow)
    readonly agents?: boolean;      // Activa AgentOrchestratorTrait (multi-agent workflows)
    readonly timeseries?: boolean;  // Activa TimeSeriesTrait (InfluxDB, TimescaleDB, Scylla)
    readonly workflow?: boolean;    // Activa WorkflowTrait (BPMN, state machines, cron)
    readonly multiTenant?: boolean; // Activa TenantTrait (row-level isolation, tenant routing)
    readonly compliance?: boolean;  // Activa ComplianceTrait (SOC2, HIPAA, GDPR reporting)
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

export interface ZenithQuery {
  readonly where?: Record<string, unknown>;
  readonly order?: string;
  readonly limit?: number;
  readonly skip?: number;
  readonly include?: string[];
  readonly keys?: string[];
  readonly count?: boolean;
}

export interface ZenithObject {
  readonly objectId?: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly className?: string;
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

export interface DatabaseAdapter {
  connect(uri: string): Promise<void>;
  find(collection: string, query: ZenithQuery): Promise<ZenithObject[]>;
  findOne(collection: string, query: ZenithQuery): Promise<ZenithObject | null>;
  insert(collection: string, data: ZenithObject): Promise<ZenithObject>;
  update(collection: string, objectId: string, data: Partial<ZenithObject>): Promise<ZenithObject>;
  /**
   * Actualiza atómicamente solo si el documento cumple las condiciones (igualdad o `$gte`).
   * Devuelve null si no se aplicó. Opcional: no todos los motores pueden garantizarlo.
   */
  updateIf?(collection: string, objectId: string, conditions: Record<string, unknown>, data: Partial<ZenithObject>): Promise<ZenithObject | null>;
  listClasses?(): Promise<string[]>;
  delete(collection: string, objectId: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface StorageAdapter {
  upload(path: string, data: Uint8Array, contentType: string): Promise<string>;
  download(path: string): Promise<Uint8Array>;
  delete: (path: string) => Promise<void>;
  getSignedUrl: (path: string, expiresIn?: number) => Promise<string>;
  
  startResumableUpload?: (path: string, contentType: string) => Promise<string>;
  uploadChunk?: (path: string, uploadId: string, partNumber: number, data: Uint8Array) => Promise<string>;
  completeResumableUpload?: (path: string, uploadId: string, parts: { PartNumber: number, ETag: string }[]) => Promise<void>;
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
  search(index: string, query: Record<string, any>, options?: { limit?: number; skip?: number }): Promise<any[]>;
  vectorSearch(index: string, vectorField: string, vector: number[], limit?: number): Promise<any[]>;
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
  pkiIssue(role: string, commonName: string, opts?: { altNames?: string[]; ipSans?: string[]; ttl?: string }): Promise<unknown>;

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
