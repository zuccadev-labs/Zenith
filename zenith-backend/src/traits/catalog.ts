/**
 * @module @zenith/traits/catalog
 *
 * El catálogo de funcionalidades de Zenith: cada pieza, sus traits, su grupo y cómo se activa
 * (`core/feature-catalog.ts`). Es la única lista. `selectTraits` (mod.ts), `zen generate openapi` y las
 * pruebas de composición la leen, así que añadir una funcionalidad es añadir una entrada aquí.
 *
 * Convenciones:
 * - **El orden es el orden de arranque:** proveedores antes que consumidores. `composeZenith` reordena
 *   por `consumes` y `uses:`, pero el catálogo ya los respeta.
 * - **Ids en camelCase:** `features.<id>` en `zen.config.ts`. Algunas piezas conservan su clave
 *   histórica en `feature` (`saas`, `ecommerce`, `gdpr`, `e2ee_media`…).
 * - **`requires`:** solo cuando una pieza no puede componerse sin otra (lo comprueban las pruebas,
 *   desactivando cada pieza por separado).
 */
import type { FeatureEntry } from "../core/feature-catalog.ts";
import type { ZenithConfig } from "../core/types.ts";
import { ServerTrait } from "../core/server.trait.ts";
import { DbTrait } from "./db/db.trait.ts";
import { EventBusTrait } from "./events/event-bus.trait.ts";
import { DatabaseMongoTrait } from "../adapters/database/mongo.adapter.ts";
import { DatabaseScyllaTrait } from "../adapters/database/scylla.adapter.ts";
import { StorageRustfsTrait } from "../adapters/storage/rustfs.adapter.ts";
import { IPFSStorageTrait } from "../adapters/storage/ipfs.adapter.ts";
import { OpenSearchTrait } from "../adapters/database/opensearch.adapter.ts";
import { CryptoTrait } from "./auth/crypto.trait.ts";
import { UserManagementTrait } from "./auth/user.trait.ts";
import { MediaStreamTrait } from "./media/mediastream.trait.ts";
import { RealtimeTrait } from "./realtime/realtime.trait.ts";
import { SchemaManagementTrait } from "./schema/schema.trait.ts";
import { ObservabilityTrait } from "./observability/observability.trait.ts";
import { ACLTrait } from "./security/acl.trait.ts";
import { RateLimitTrait } from "./security/ratelimit.trait.ts";
import { RestCrudTrait } from "./rest/crud.trait.ts";
import { CloudCodeTrait } from "./cloud/cloudcode.trait.ts";
import { FileStorageTrait } from "./storage/storage.trait.ts";
import { GraphQLTrait } from "./graphql/graphql.trait.ts";
import { MigrationTrait } from "./migration/migration.trait.ts";
import { AITrait } from "./ai/ai.trait.ts";
import { RunnerTrait } from "./runner/runner.trait.ts";
import { ShellApiTrait } from "./runner/shell.trait.ts";
import { gRPCTrait } from "./cluster/grpc.trait.ts";
import { ZeroMQTrait } from "./cluster/zeromq.trait.ts";
import { BillingTrait } from "./billing/billing.trait.ts";
import { SegmentationTrait } from "./users/segmentation.trait.ts";
import { EdgeTrait } from "./edge/edge.trait.ts";
import { EventStreamingTrait } from "./events/events.trait.ts";
import { Web3Trait } from "./web3/web3.trait.ts";
import { FederationTrait } from "./cluster/federation.trait.ts";
import { E2EEKeysTrait } from "./media/e2ee-keys.trait.ts";
import { SFrameSignalingTrait } from "./media/sframe-signaling.trait.ts";
import { VectorDBTrait } from "./vectordb/vectordb.trait.ts";
import { IoTTrait } from "./iot/iot.trait.ts";
import { AgentOrchestratorTrait } from "./agents/agent.orchestrator.trait.ts";
import { FeatureFlagsTrait } from "./featureflags/featureflags.trait.ts";
import { TimeSeriesTrait } from "./timeseries/timeseries.trait.ts";
import { WorkflowTrait } from "./workflow/workflow.trait.ts";
import { TenantTrait } from "./tenant/tenant.trait.ts";
import { ComplianceTrait } from "./compliance/compliance.trait.ts";
import { CacheTrait } from "./cache/cache.trait.ts";
import { PushTrait } from "./push/push.trait.ts";
import { JobQueueTrait } from "./queue/job.queue.trait.ts";
import { CircuitBreakerTrait } from "./resilience/circuit.breaker.trait.ts";
import { CRMTrait } from "./crm/crm.trait.ts";
import { ERPTrait } from "./erp/erp.trait.ts";
import { CollaborationTrait } from "./collaboration/collaboration.trait.ts";
import { WorkspaceTrait } from "./workspace/workspace.trait.ts";
import { ViewsTrait } from "./views/views.trait.ts";
import { SearchTrait } from "./search/search.trait.ts";
import { TimelineTrait } from "./timeline/timeline.trait.ts";
import { MetadataTrait } from "./metadata/metadata.trait.ts";
import { BlogForumTrait } from "./blogforum/blogforum.trait.ts";
import { ADKAgentsTrait } from "./agents/adk.agents.trait.ts";
import { PluginMarketplaceTrait } from "./marketplace/marketplace.trait.ts";
import { NotificationsTrait } from "./notifications/notifications.trait.ts";
import { FavoritesTagsTrait } from "./favtags/favtags.trait.ts";
import { WebhookManagerTrait } from "./webhooks/webhook.manager.trait.ts";
import { CloudHooksTrait } from "./cloud/hooks.trait.ts";
import { CSVTrait } from "./csv/csv.trait.ts";
import { EmailSyncTrait } from "./email/email.sync.trait.ts";
import { CalendarSyncTrait } from "./calendar/calendar.sync.trait.ts";
import { AutomationTrait } from "./automation/automation.trait.ts";

const on = (t: string) => (_c: ZenithConfig, topology: readonly string[]) => topology.includes(t);

/** Adaptador de base de datos según `databaseURI` (MongoDB por defecto). */
const databaseAdapter = (config: ZenithConfig) => {
  const uri = config.databaseURI ?? "";
  return uri.startsWith("cassandra") || uri.startsWith("scylla")
    ? [DatabaseScyllaTrait]
    : [DatabaseMongoTrait];
};

export const FEATURE_CATALOG: readonly FeatureEntry[] = [
  // ── Núcleo ──────────────────────────────────────────────────────────────────
  {
    id: "db",
    group: "core",
    required: true,
    summary: "Capa de datos común (find/create/update/delete)",
    traits: [DbTrait],
  },
  {
    id: "eventBus",
    group: "core",
    required: true,
    summary: "Bus de eventos de dominio en proceso (on/emit)",
    traits: [EventBusTrait],
  },
  {
    id: "objectStorage",
    group: "core",
    required: true,
    summary: "Almacenamiento de objetos S3 (RustFS)",
    traits: [StorageRustfsTrait],
  },
  {
    id: "crypto",
    group: "security",
    required: true,
    summary: "Argon2id, HMAC y AES-GCM",
    traits: [CryptoTrait],
  },
  {
    id: "schema",
    group: "core",
    required: true,
    summary: "Esquemas de clases (Parse /schemas)",
    traits: [SchemaManagementTrait],
  },
  {
    id: "users",
    group: "core",
    required: true,
    summary: "Usuarios y sesiones (Parse /users, engine-auth)",
    traits: [UserManagementTrait],
  },
  {
    id: "mediaStream",
    group: "platform",
    default: true,
    summary: "Streaming de medios WebRTC (WHIP/WHEP)",
    traits: [MediaStreamTrait],
  },
  {
    id: "acl",
    group: "security",
    required: true,
    summary: "ACL y CLP por objeto y clase",
    traits: [ACLTrait],
  },
  {
    id: "rateLimit",
    group: "security",
    required: true,
    summary: "Límite de peticiones",
    traits: [RateLimitTrait],
  },
  {
    id: "rest",
    group: "core",
    required: true,
    summary: "CRUD REST de clases (Parse /classes, /batch)",
    traits: [RestCrudTrait],
  },
  {
    id: "cloudCode",
    group: "core",
    required: true,
    summary: "Cloud Code: funciones, jobs y triggers",
    traits: [CloudCodeTrait],
  },
  {
    id: "files",
    group: "core",
    required: true,
    summary: "Archivos (Parse /files)",
    traits: [FileStorageTrait],
  },
  {
    id: "observability",
    group: "platform",
    required: true,
    summary: "Salud, métricas y trazas",
    traits: [ObservabilityTrait],
  },
  {
    id: "migrations",
    group: "data",
    required: true,
    summary: "Migraciones de esquema",
    traits: [MigrationTrait],
  },
  {
    id: "database",
    group: "data",
    required: true,
    summary: "Adaptador de base de datos (MongoDB o ScyllaDB)",
    traits: databaseAdapter,
  },

  // ── Datos e integraciones opcionales ─────────────────────────────────────────
  {
    id: "billing",
    feature: "saas",
    group: "business",
    default: false,
    summary: "Facturación y pagos (Stripe)",
    traits: [BillingTrait],
  },
  {
    id: "search.opensearch",
    feature: "ecommerce",
    group: "data",
    default: false,
    summary: "Búsqueda de catálogo (OpenSearch)",
    traits: [OpenSearchTrait],
  },
  {
    id: "segmentation",
    feature: "gdpr",
    group: "security",
    default: false,
    summary: "Segmentación, derecho al olvido y portabilidad",
    traits: [SegmentationTrait],
  },
  {
    id: "edge",
    group: "platform",
    default: false,
    summary: "Ejecución WebAssembly en el borde",
    traits: [EdgeTrait],
  },
  {
    id: "eventStreaming",
    feature: "events",
    group: "integrations",
    default: false,
    summary: "Registro de eventos (_Event) y reproducción",
    traits: [EventStreamingTrait],
  },
  {
    id: "web3",
    group: "integrations",
    default: false,
    summary: "Login con wallet e IPFS",
    traits: [Web3Trait, IPFSStorageTrait],
  },
  {
    id: "federation",
    group: "platform",
    default: false,
    summary: "Replicación multirregión (CRDT)",
    traits: [FederationTrait],
  },

  // ── Transporte (según topology) ─────────────────────────────────────────────
  {
    id: "http",
    group: "transport",
    required: true,
    when: on("http"),
    summary: "Servidor HTTP",
    traits: [ServerTrait],
  },
  {
    id: "realtime",
    group: "transport",
    default: true,
    when: on("http"),
    requires: ["http"],
    summary: "LiveQuery por WebSocket",
    traits: [RealtimeTrait],
  },
  {
    id: "graphql",
    group: "transport",
    default: true,
    when: on("graphql"),
    summary: "API GraphQL",
    traits: [GraphQLTrait],
  },
  {
    id: "ai",
    group: "ai",
    default: false,
    when: on("ai"),
    summary: "Capa de IA (LLM y tokens)",
    traits: [AITrait],
  },
  {
    id: "runner",
    group: "platform",
    default: true,
    when: on("runner"),
    summary: "Runner y API de shell",
    traits: [RunnerTrait, ShellApiTrait],
  },
  {
    id: "grpc",
    group: "transport",
    default: true,
    when: on("grpc"),
    summary: "Transporte gRPC entre nodos",
    traits: [gRPCTrait],
  },
  {
    id: "zeromq",
    group: "transport",
    default: true,
    when: on("zeromq"),
    summary: "Transporte ZeroMQ entre nodos",
    traits: [ZeroMQTrait],
  },
  {
    id: "e2eeMedia",
    feature: "e2ee_media",
    group: "security",
    default: false,
    summary: "Claves E2EE y señalización SFrame",
    traits: [E2EEKeysTrait, SFrameSignalingTrait],
  },

  // ── Plataforma ──────────────────────────────────────────────────────────────
  {
    id: "featureFlags",
    group: "platform",
    required: true,
    summary: "Flags por plan y kill switches",
    traits: [FeatureFlagsTrait],
  },
  {
    id: "vectordb",
    group: "ai",
    default: false,
    summary: "Base vectorial (búsqueda semántica y RAG)",
    traits: [VectorDBTrait],
  },
  {
    id: "iot",
    group: "integrations",
    default: false,
    summary: "IoT: MQTT, registro de dispositivos y SenML",
    traits: [IoTTrait],
  },
  {
    id: "agents.orchestrator",
    feature: "agents",
    group: "ai",
    default: false,
    summary: "Orquestador de agentes (ReAct y herramientas)",
    traits: [AgentOrchestratorTrait],
  },
  {
    id: "timeseries",
    group: "data",
    default: false,
    summary: "Series temporales (ScyllaDB y Grafana)",
    traits: [TimeSeriesTrait],
  },
  {
    id: "workflow",
    group: "integrations",
    default: false,
    summary: "Motor de flujos (disparador → acción)",
    traits: [WorkflowTrait],
  },
  {
    id: "multiTenant",
    group: "security",
    default: false,
    summary: "Multi-tenant con aislamiento por fila",
    traits: [TenantTrait],
  },
  {
    id: "compliance",
    group: "security",
    default: false,
    summary: "Cumplimiento y auditoría inmutable",
    traits: [ComplianceTrait],
  },
  {
    id: "cache",
    group: "platform",
    default: true,
    summary: "Caché LRU y Redis con invalidación por etiquetas",
    traits: [CacheTrait],
  },
  {
    id: "push",
    group: "integrations",
    default: false,
    summary: "Notificaciones push (FCM y APNs)",
    traits: [PushTrait],
  },
  {
    id: "queue",
    group: "platform",
    default: true,
    summary: "Cola de trabajos persistente (reintentos, DLQ, prioridad)",
    traits: [JobQueueTrait],
  },
  {
    id: "resilience",
    group: "platform",
    default: true,
    summary: "Circuit breaker",
    traits: [CircuitBreakerTrait],
  },

  // ── Negocio ─────────────────────────────────────────────────────────────────
  { id: "crm", group: "business", default: true, summary: "CRM", traits: [CRMTrait] },
  { id: "erp", group: "business", default: true, summary: "ERP", traits: [ERPTrait] },

  // ── Colaboración ────────────────────────────────────────────────────────────
  {
    id: "collaboration",
    group: "collaboration",
    default: true,
    summary: "Notas, tareas, comentarios y adjuntos",
    traits: [CollaborationTrait],
  },
  {
    id: "workspace",
    group: "collaboration",
    default: true,
    summary: "Miembros e invitaciones",
    traits: [WorkspaceTrait],
  },
  {
    id: "views",
    group: "collaboration",
    default: true,
    summary: "Vistas guardadas",
    traits: [ViewsTrait],
  },
  {
    id: "timeline",
    group: "collaboration",
    default: true,
    summary: "Línea de tiempo de actividad",
    traits: [TimelineTrait],
  },
  { id: "search", group: "data", default: true, summary: "Búsqueda global", traits: [SearchTrait] },
  {
    id: "metadata",
    group: "data",
    default: true,
    summary: "Objetos y campos personalizados",
    traits: [MetadataTrait],
  },
  {
    id: "blogForum",
    group: "business",
    default: true,
    summary: "Blog y foro",
    traits: [BlogForumTrait],
  },
  {
    id: "agents.adk",
    feature: "agents",
    group: "ai",
    default: true,
    summary: "Agentes de negocio (Google ADK)",
    traits: [ADKAgentsTrait],
  },
  {
    id: "marketplace",
    group: "platform",
    default: true,
    summary: "Marketplace de plugins",
    traits: [PluginMarketplaceTrait],
  },
  {
    id: "notifications",
    group: "collaboration",
    default: true,
    summary: "Notificaciones in-app (SSE)",
    traits: [NotificationsTrait],
  },
  {
    id: "favoritesTags",
    group: "collaboration",
    default: true,
    summary: "Favoritos y etiquetas",
    traits: [FavoritesTagsTrait],
  },
  {
    id: "webhooks",
    group: "integrations",
    default: true,
    summary: "Webhooks salientes (Standard Webhooks) con outbox, reintentos y rotación",
    traits: [WebhookManagerTrait],
  },
  {
    id: "cloudHooks",
    group: "integrations",
    default: true,
    summary:
      "Cloud Code Hooks de Parse Server (/hooks): funciones y triggers servidos por URLs externas",
    traits: [CloudHooksTrait],
  },
  {
    id: "csv",
    group: "data",
    default: true,
    summary: "Importación y exportación CSV",
    traits: [CSVTrait],
  },
  {
    id: "emailSync",
    group: "integrations",
    default: true,
    summary: "Sincronización de correo (IMAP/SMTP)",
    traits: [EmailSyncTrait],
  },
  {
    id: "calendarSync",
    group: "integrations",
    default: true,
    summary: "Sincronización de calendario",
    traits: [CalendarSyncTrait],
  },
  {
    id: "automation",
    group: "integrations",
    default: true,
    summary: "Reglas de automatización",
    traits: [AutomationTrait],
  },
];
