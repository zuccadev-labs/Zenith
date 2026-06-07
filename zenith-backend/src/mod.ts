// deno-lint-ignore-file no-unused-vars
import { composeTraitDescriptors } from "@zuccadev-labs/barrits";
import { generateOpenApiSchema } from "./core/openapi.ts";
import { ServerTrait } from "./core/server.trait.ts";
import { loadMergedTrustStore, parseManifest, verifyPlugin } from "./security/plugin-signing/mod.ts";
import { DatabaseMongoTrait, createMongoAdapter } from "./adapters/database/mongo.adapter.ts";
import { DatabaseScyllaTrait, createScyllaAdapter } from "./adapters/database/scylla.adapter.ts";
import type { DatabaseSurrealTrait, SurrealClient, createSurrealAdapter } from "./adapters/database/surreal.adapter.ts";
import { StorageRustfsTrait, createRustFSAdapter } from "./adapters/storage/rustfs.adapter.ts";
import { MongoClient } from "mongodb";
import cassandra from "cassandra-driver";
import { S3Client } from "@aws-sdk/client-s3";
import { generateKeyPairSync } from "node:crypto";
import { CryptoTrait } from "./traits/auth/crypto.trait.ts";
import { UserManagementTrait } from "./traits/auth/user.trait.ts";
import { MediaStreamTrait } from "./traits/media/mediastream.trait.ts";
import { RealtimeTrait } from "./traits/realtime/realtime.trait.ts";
import { SchemaManagementTrait } from "./traits/schema/schema.trait.ts";
import { ObservabilityTrait } from "./traits/observability/observability.trait.ts";
import { ACLTrait } from "./traits/security/acl.trait.ts";
import { RateLimitTrait } from "./traits/security/ratelimit.trait.ts";
import { RestCrudTrait } from "./traits/rest/crud.trait.ts";
import { CloudCodeTrait } from "./traits/cloud/cloudcode.trait.ts";
import { FileStorageTrait } from "./traits/storage/storage.trait.ts";
import { GraphQLTrait } from "./traits/graphql/graphql.trait.ts";
import { MigrationTrait } from "./traits/migration/migration.trait.ts";
import { AITrait } from "./traits/ai/ai.trait.ts";
import { RunnerTrait } from "./traits/runner/runner.trait.ts";
import { ShellApiTrait } from "./traits/runner/shell.trait.ts";
import { WebhookTrait } from "./traits/cloud/webhook.trait.ts";
import { gRPCTrait } from "./traits/cluster/grpc.trait.ts";
import { ZeroMQTrait } from "./traits/cluster/zeromq.trait.ts";
import { BillingTrait } from "./traits/billing/billing.trait.ts";
import { OpenSearchTrait } from "./adapters/database/opensearch.adapter.ts";
import { SegmentationTrait } from "./traits/users/segmentation.trait.ts";
import { EdgeTrait } from "./traits/edge/edge.trait.ts";
import { EventStreamingTrait } from "./traits/events/events.trait.ts";
import { Web3Trait } from "./traits/web3/web3.trait.ts";
import { FederationTrait } from "./traits/cluster/federation.trait.ts";
import { IPFSStorageTrait } from "./adapters/storage/ipfs.adapter.ts";
import { E2EEKeysTrait } from "./traits/media/e2ee-keys.trait.ts";
import { SFrameSignalingTrait } from "./traits/media/sframe-signaling.trait.ts";
import { createKafkaAdapter } from "./adapters/events/kafka.adapter.ts";
import { createIPFSAdapter } from "./adapters/storage/ipfs.adapter.ts";
import { createNeo4jAdapter } from "./adapters/database/neo4j.adapter.ts";
import { createStripeAdapter } from "./adapters/billing/stripe.adapter.ts";
import { initialSchemaMigration } from "./migrations/001_initial_schema.ts";
// ── UBB: Universal Business Backend Traits ───────────────────────────────
import { VectorDBTrait, type createOllamaEmbedProvider, type createOpenAIEmbedProvider } from "./traits/vectordb/vectordb.trait.ts";
import { IoTTrait } from "./traits/iot/iot.trait.ts";
import { AgentOrchestratorTrait } from "./traits/agents/agent.orchestrator.trait.ts";
import { FeatureFlagsTrait } from "./traits/featureflags/featureflags.trait.ts";
import type { createQdrantAdapter } from "./adapters/vectordb/qdrant.adapter.ts";
// ── UBB Phase 2 Traits ───────────────────────────────────────────
import { TimeSeriesTrait } from "./traits/timeseries/timeseries.trait.ts";
import { WorkflowTrait } from "./traits/workflow/workflow.trait.ts";
import { TenantTrait } from "./traits/tenant/tenant.trait.ts";
import { ComplianceTrait } from "./traits/compliance/compliance.trait.ts";
import type { createScyllaTimeSeriesAdapter } from "./adapters/timeseries/scylla.timeseries.adapter.ts";
// ── Phase 0.A: DevOps Adapters (auto-registered, see ADR-001) ────────────
// Phase 0.A movió git/vault/lux-cache de `plugins/` a `src/adapters/`.
// Como son plugins con side-effects (registran en `ZenPlugins` global),
// importarlos aquí garantiza que `Zen.Plugins.Git/Vault/CacheAdapter`
// estén disponibles sin que el usuario tenga que importarlos manualmente.
// Lux-cache adicionalmente chequea `LUX_DB_URL` antes de activarse.
import "./adapters/git.adapter.ts";
import "./adapters/vault.adapter.ts";
import "./adapters/lux-cache.adapter.ts";
import type { ZenithConfig } from "./core/types.ts";
import { _cloudCodeRegistry } from "./core/cloud.ts";

// Re-export UBB building blocks for plugin authors
export { createSurrealAdapter, SurrealClient } from "./adapters/database/surreal.adapter.ts";
export { createQdrantAdapter } from "./adapters/vectordb/qdrant.adapter.ts";
export { createOllamaEmbedProvider, createOpenAIEmbedProvider } from "./traits/vectordb/vectordb.trait.ts";
export { installERPPlugin } from "./plugins/erp.plugin.ts";
export { installCRMPlugin } from "./plugins/crm.plugin.ts";
export { installEcommercePlugin } from "./plugins/ecommerce.plugin.ts";
export { createScyllaTimeSeriesAdapter } from "./adapters/timeseries/scylla.timeseries.adapter.ts";
export type { TimeSeriesPoint, TimeSeriesQuery } from "./adapters/timeseries/scylla.timeseries.adapter.ts";
export type { IoTDevice, TelemetryPayload, IoTAlert, SenMLRecord } from "./traits/iot/iot.trait.ts";
export type { AgentDefinition, AgentTool, AgentRunResult } from "./traits/agents/agent.orchestrator.trait.ts";
export { PLAN_LIMITS, FEATURE_FLAGS } from "./traits/featureflags/featureflags.trait.ts";
export type { Plan, PlanLimits } from "./traits/featureflags/featureflags.trait.ts";
export type { TenantConfig } from "./traits/tenant/tenant.trait.ts";
export type { AuditEntry, PII_Field, DataClassification } from "./traits/compliance/compliance.trait.ts";

export async function createZenithApp(config: ZenithConfig) {
  console.log(`🚀 Bootstrapping Zenith Engine for App: ${config.appId}...`);

  try {
    const topology = config.topology || ["http", "runner", "ai", "graphql", "zeromq"];
    
    // Base traits that all nodes need (Data plane & Auth plane)
    const activeTraits: any[] = [
      StorageRustfsTrait,    
      CryptoTrait,
      SchemaManagementTrait,
      UserManagementTrait,
      MediaStreamTrait,
      ACLTrait,
      RateLimitTrait,
      RestCrudTrait,
      CloudCodeTrait,
      FileStorageTrait,
      ObservabilityTrait,
      MigrationTrait
    ];

    // EXPERT AUDIT: Dynamically resolve DB driver to avoid Barrits capability collision
    if (config.databaseURI?.startsWith("mongodb")) {
      activeTraits.push(DatabaseMongoTrait);
    } else if (config.databaseURI?.startsWith("cassandra") || config.databaseURI?.startsWith("scylla")) {
      activeTraits.push(DatabaseScyllaTrait);
    } else {
      // Default to Mongo if not specified
      activeTraits.push(DatabaseMongoTrait);
    }

    // Feature Flags (Fase 19): Attack Surface Reduction
    // Solo cargamos en RAM y habilitamos Endpoints si el usuario lo solicita explícitamente.
    if (config.features?.saas) {
      activeTraits.push(BillingTrait);
      console.log(`[ZenithBoot] 🛒 SaaS/Billing Layer Enabled.`);
    }
    
    if (config.features?.ecommerce) {
      activeTraits.push(OpenSearchTrait);
      console.log(`[ZenithBoot] 🛍️ E-Commerce/Search Layer Enabled.`);
    }

    if (config.features?.gdpr) {
      activeTraits.push(SegmentationTrait);
      console.log(`[ZenithBoot] 🛡️ GDPR/Segmentation Layer Enabled.`);
    }
    
    if (config.features?.edge) {
      activeTraits.push(EdgeTrait);
      console.log(`[ZenithBoot] ⚡ WASM Edge Computing Enabled.`);
    }

    if (config.features?.events) {
      activeTraits.push(EventStreamingTrait);
      console.log(`[ZenithBoot] 📬 Event Sourcing (Kafka) Enabled.`);
    }

    if (config.features?.web3) {
      activeTraits.push(Web3Trait);
      activeTraits.push(IPFSStorageTrait);
      console.log(`[ZenithBoot] 🌐 Web3 & IPFS Storage Enabled.`);
    }

    if (config.features?.federation) {
      activeTraits.push(FederationTrait);
      console.log(`[ZenithBoot] 🌍 Multi-Region Federation (CRDT) Enabled.`);
    }

    if (topology.includes("http")) {
      activeTraits.push(ServerTrait);
      activeTraits.push(RealtimeTrait); // WebSockets usually tied to HTTP
    }
    
    if (topology.includes("graphql")) {
      activeTraits.push(GraphQLTrait);
    }
    
    if (topology.includes("ai") && config.features?.ai) {
      activeTraits.push(AITrait);
      console.log(`[ZenithBoot] 🧠 AI Agent Layer Enabled.`);
    }

    if (topology.includes("runner")) {
      activeTraits.push(RunnerTrait);
      activeTraits.push(ShellApiTrait);
    }

    if (topology.includes("http")) {
      activeTraits.push(WebhookTrait);
    }

    if (topology.includes("grpc")) {
      activeTraits.push(gRPCTrait);
    }

    if (topology.includes("zeromq")) {
      activeTraits.push(ZeroMQTrait);
    }

    if (config.features?.e2ee_media) {
      activeTraits.push(E2EEKeysTrait);
      activeTraits.push(SFrameSignalingTrait);
      console.log(`[ZenithBoot] 🔒 E2EE Media & Signaling Enabled.`);
    }

    // ── UBB Phase 1: Feature-flag-gated UBB Traits ───────────────────────
    // Always loaded: Feature Flags (needed by all other UBB traits)
    activeTraits.push(FeatureFlagsTrait);

    if (config.features?.vectordb) {
      activeTraits.push(VectorDBTrait);
      console.log(`[ZenithBoot] 🧠 Vector DB (Semantic Search + RAG) Enabled.`);
    }

    if (config.features?.iot) {
      activeTraits.push(IoTTrait);
      console.log(`[ZenithBoot] 📡 IoT Layer (MQTT + Device Registry + SenML) Enabled.`);
    }

    if (config.features?.agents) {
      activeTraits.push(AgentOrchestratorTrait);
      console.log(`[ZenithBoot] 🤖 Agent Orchestrator (ReAct Loop + Tool Calling) Enabled.`);
    }

    // ── UBB Phase 2: TimeSeries, Workflow, Multi-Tenant, Compliance ───
    if (config.features?.timeseries) {
      activeTraits.push(TimeSeriesTrait);
      console.log(`[ZenithBoot] 📈 TimeSeries (ScyllaDB + Grafana DS API) Enabled.`);
    }

    if (config.features?.workflow) {
      activeTraits.push(WorkflowTrait);
      console.log(`[ZenithBoot] ⚡ Workflow Engine (iPaaS Trigger→Action) Enabled.`);
    }

    if (config.features?.multiTenant) {
      activeTraits.push(TenantTrait);
      console.log(`[ZenithBoot] 🏢 Multi-Tenant RLS Enabled.`);
    }

    if (config.features?.compliance) {
      activeTraits.push(ComplianceTrait);
      console.log(`[ZenithBoot] ⚖️  Compliance (GDPR/SOC2 + Immutable Audit Trail) Enabled.`);
    }

    const composition = composeTraitDescriptors(activeTraits);
    const engine = composition.traits as any;
    console.log("[ZenithBoot] Final Composed Capabilities:", Object.keys(engine));

    // ── Auto-generate OpenAPI v3.1 from Barrits trait route capabilities ──
    // Dynamic: recalculated on each /openapi.json request to include any
    // Cloud Functions registered AFTER boot (Zen.Cloud.define).

    const openApiOptions = {
      title: `${config.appId} — Zenith API`,
      description: "Auto-generated from Barrits Trait AST. Parse Server-compatible BaaS.",
      version: "1.0.0",
      serverURL: config.serverURL || `http://localhost:${config.port || 23614}`,
      appId: config.appId,
    };

    /**
     * Generates a fresh OpenAPI spec including all currently registered Cloud Functions.
     * This makes /openapi.json & Swagger always up-to-date without a server restart.
     */
    const buildLiveOpenApiSpec = () => {
      // Inject virtual routes for every registered Cloud Function
      const dynamicFnRoutes = _cloudCodeRegistry.listFunctions().map(fnName => ({
        method: "POST",
        path: `/functions/${fnName}`,
      }));
      const dynamicJobRoutes = _cloudCodeRegistry.listJobs().map(jobName => ({
        method: "POST",
        path: `/jobs/${jobName}`,
      }));

      // Augment engine with live function routes
      const augmentedEngine = {
        ...engine,
        __dynamic_fn_routes: dynamicFnRoutes,
        __dynamic_job_routes: dynamicJobRoutes,
      };

      return generateOpenApiSchema(augmentedEngine, openApiOptions);
    };

    // Expose /openapi.json (dynamic) and /swagger as built-in routes
    const metaRoutes = [
      {
        method: "GET",
        path: "/openapi.json",
        handler: (_req: Request, _ctx: any) =>
          new Response(JSON.stringify(buildLiveOpenApiSpec(), null, 2), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-cache, no-store, must-revalidate",
            },
          }),
      },
      {
        method: "GET",
        path: "/swagger",
        handler: (_req: Request, _ctx: any) =>
          new Response(
            `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${config.appId} — Zenith API Docs</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"/></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"./openapi.json",dom_id:"#swagger-ui",presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset],layout:"BaseLayout",deepLinking:true,persistAuthorization:true})</script></body></html>`,
            { status: 200, headers: { "Content-Type": "text/html" } },
          ),
      },
    ];

    // Inject meta routes — append to the existing `routes` capability array or create it
    if (Array.isArray(engine.routes)) {
      engine.routes.push(...metaRoutes);
    } else {
      engine.routes = metaRoutes;
    }

    console.log(`✅ Zenith Engine Composed for ${config.appId}. OpenAPI spec ready at /openapi.json`);

    // ── Military-Grade Security: Initialize Shell Allowlist ──
    const allowedCommands = config.allowedShellCommands || ["git", "vault", "kubectl", "lux-db"];
    if (engine.Plugins && engine.Shell) {
       engine.Shell.setAllowedCommands(allowedCommands);
       console.log(`[ZenithBoot] 🛡️ Zen.Shell allowlist configured: [${allowedCommands.join(", ")}]`);
    }

    // Conectar adaptadores de Base de Datos para esta app
    const mongoUri = (config as any).databaseURI || "mongodb://localhost:27614";
    const mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    const mongoPlugin = createMongoAdapter(mongoClient.db(config.appId));

    const scyllaUri = (config as any).authDatabaseURI || "localhost:90614";
    const scyllaHost = scyllaUri.split(":")[0];
    const scyllaPort = parseInt(scyllaUri.split(":")[1] || "9042", 10);
    const scyllaClient = new cassandra.Client({ 
      contactPoints: [scyllaHost], 
      protocolOptions: { port: scyllaPort },
      localDataCenter: 'datacenter1' 
    });
    await scyllaClient.connect();
    const scyllaPlugin = createScyllaAdapter(scyllaClient);

    // @ts-ignore
    if (engine.injectMongoPlugin) engine.injectMongoPlugin(mongoPlugin);
    // @ts-ignore
    if (engine.injectScyllaPlugin) engine.injectScyllaPlugin(scyllaPlugin);

    // RustFS (S3-compatible) para Media/Storage
    const s3Uri = (config as any).mediaStorageURI || "http://localhost:8614";
    const s3Client = new S3Client({
      region: "us-east-1",
      endpoint: s3Uri,
      forcePathStyle: true,
      credentials: {
        accessKeyId: Deno.env.get("RUSTFS_ACCESS_KEY") || "admin",
        secretAccessKey: Deno.env.get("RUSTFS_SECRET_KEY") || "admin",
      }
    });
    const rustfsPlugin = createRustFSAdapter(s3Client, `${config.appId}-storage`);
    // @ts-ignore
    if (engine.injectRustFSPlugin) engine.injectRustFSPlugin(rustfsPlugin);

    // Inyección de Plugins Avanzados (Fase 20)
    if (config.features?.events) {
       const kafkaPlugin = createKafkaAdapter(config.appId);
       // @ts-ignore
       if (engine.injectEventPlugin) engine.injectEventPlugin(kafkaPlugin);
       await kafkaPlugin.connect(["localhost:9092"]);
    }

    if (config.features?.web3) {
       const ipfsPlugin = createIPFSAdapter("https://ipfs.io");
       // @ts-ignore
       if (engine.injectPlugin) engine.injectPlugin(ipfsPlugin);
    }

    // Neo4j Plugin si está configurado para Graph (El trait dependerá del Data layer genérico)
    if (config.features?.graph) {
       const neo4jPlugin = createNeo4jAdapter();
       const neo4jUri = Deno.env.get("NEO4J_URI") || "bolt://localhost:7687";
       const neo4jUser = Deno.env.get("NEO4J_USER") || "neo4j";
       const neo4jPassword = Deno.env.get("NEO4J_PASSWORD");
       if (!neo4jPassword) {
         console.warn("[ZenithBoot] Warning: NEO4J_PASSWORD is not set. Neo4j graph capabilities might fail to authenticate.");
       }
       await neo4jPlugin.connect(neo4jUri, neo4jUser, neo4jPassword || "unsafe_default");
       // Lo expondríamos a través de un trait específico o como extensión del Schema Management
    }

    if (config.features?.saas) {
       const stripePlugin = createStripeAdapter(Deno.env.get("STRIPE_API_KEY") || "sk_test_mock");
       if (engine["billing-metering"]?.injectAdapter) engine["billing-metering"].injectAdapter(stripePlugin);
    }

    if (config.features?.e2ee_media) {
       console.log(`[Zenith] Loading E2EE Media Module (Mode: ${config.features.e2ee_mode || "strict_sframe"})`);
       // @ts-ignore
       if (engine.setE2EEMode) engine.setE2EEMode(config.features.e2ee_mode || "strict_sframe");
    }

    // Llaves JWT: Persistencia Corporativa.
    // Prioridad: (1) Vault si está configurado, (2) MongoDB (legacy).
    // H-4 ADR-008: producción enterprise usa Vault para KMS / HSM backing.
    const globalConfigCol = mongoClient.db(config.appId).collection("_GlobalConfig");
    let privateKeyStr: string;
    let publicKeyStr: string;

    const vaultAddr = Deno.env.get("VAULT_ADDR");
    if (vaultAddr) {
      console.log(`[ZenithBoot] 🔑 Cargando llaves JWT desde Vault (${vaultAddr})...`);
      // El adapter se auto-registra en src/mod.ts (import "./adapters/vault.adapter.ts").
      // Verificamos que está activo antes de usarlo.
      // @ts-ignore
      const ZenPlugins = (await import("./core/cloud.ts")).ZenPlugins;
      if (!ZenPlugins.Vault?.isActive()) {
        throw new Error(
          "[ZenithBoot] VAULT_ADDR is set but Vault plugin is not active. " +
          "Check VAULT_TOKEN or AppRole credentials in environment.",
        );
      }
      // @ts-ignore
      const vaultClient = ZenPlugins.Vault.client() as {
        kvGet: (path: string) => Promise<{
          data?: { privateKey?: string; publicKey?: string };
          metadata?: { version: number };
        } | null>;
      };
      const secret = await vaultClient.kvGet(`zenith/${config.appId}/jwt-keys`);
      if (secret?.data?.privateKey && secret?.data?.publicKey) {
        privateKeyStr = secret.data.privateKey as string;
        publicKeyStr = secret.data.publicKey as string;
        console.log(`[ZenithBoot] 🔑 Llaves RSA cargadas desde Vault (v${secret.metadata?.version ?? "?"}).`);
      } else {
        console.log(`[ZenithBoot] 🔑 No se encontraron llaves en Vault. Generando nuevas y guardando...`);
        const { publicKey, privateKey } = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        privateKeyStr = privateKey;
        publicKeyStr = publicKey;
        // @ts-ignore
        await ZenPlugins.Vault.kvPut(`zenith/${config.appId}/jwt-keys`, {
          privateKey: privateKeyStr,
          publicKey: publicKeyStr,
          createdAt: new Date().toISOString(),
        });
        console.log(`[ZenithBoot] 🔑 Llaves RSA generadas y guardadas en Vault.`);
      }
    } else {
      // Fallback legacy: persistencia en MongoDB.
      const jwtKeys = await globalConfigCol.findOne({ _id: "jwt_keys" as any });
      if (!jwtKeys) {
        console.log(`[ZenithBoot] 🔑 Generando nuevas llaves RSA para App: ${config.appId}...`);
        const { publicKey, privateKey } = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        privateKeyStr = privateKey;
        publicKeyStr = publicKey;

        await globalConfigCol.insertOne({
          _id: "jwt_keys" as any,
          privateKey: privateKeyStr,
          publicKey: publicKeyStr,
          createdAt: new Date()
        });
      } else {
        console.log(`[ZenithBoot] 🔑 Llaves RSA cargadas desde base de datos.`);
        privateKeyStr = jwtKeys.privateKey;
        publicKeyStr = jwtKeys.publicKey;
      }
    }

    // @ts-ignore
    if (engine.initKeys) engine.initKeys(privateKeyStr, publicKeyStr);

    // Inicializaciones
    // @ts-ignore
    if (engine.schema_init) await engine.schema_init(config);
    // @ts-ignore
    if (engine.observability_init) engine.observability_init();
    // @ts-ignore
    if (engine.acl_init) engine.acl_init(config);
    // @ts-ignore
    if (engine.ratelimit_init) await engine.ratelimit_init();

    // @ts-ignore
    if (engine.ai_init) engine.ai_init(config);

    if (config.pluginsPath) {
      console.log(`[ZenithBoot] 🔌 Loading plugins from ${config.pluginsPath}...`);
      try {
        let lockfile: Record<string, string> = {};

        // [SecOps H-06] El lockfile se lee desde la RAÍZ del proyecto (Deno.cwd()),
        // NO desde dentro del directorio de plugins. Un atacante con acceso de escritura
        // a plugins/ no puede reemplazar el lockfile si está en un directorio separado.
        const lockfilePath = `${Deno.cwd()}/plugins.lock.json`;
        try {
          const lockContent = await Deno.readTextFile(lockfilePath);
          lockfile = JSON.parse(lockContent);
          console.log(`[SecOps] ✅ plugins.lock.json cargado desde raíz del proyecto (${lockfilePath})`);
        } catch (_e) {
          console.warn(`[SecOps] ⚠️ No se encontró plugins.lock.json en ${lockfilePath}.`);
          if (Deno.args.includes("--mode=production")) {
            throw new Error(`[SecOps] ABORT: Missing plugins.lock.json at project root in Production Mode. ACE Prevention. Run 'zenith plugins:lock' to generate it.`);
          }
        }

        // [SecOps H-05] Trust store de claves de autor para plugin signing.
        // Si existe, los plugins deben estar firmados y el backend verifica la
        // cadena de confianza antes de cargarlos. Si no existe, se cae al modo
        // legacy (solo SHA-256 contra lockfile).
        let trust = null;
        try {
          trust = await loadMergedTrustStore();
          if (trust.keys.length > 0) {
            console.log(`[SecOps H-05] ✅ Trust store cargado: ${trust.keys.length} clave(s) de autor confiable(s).`);
          }
        } catch (e) {
          console.warn(`[SecOps H-05] ⚠️ No se pudo cargar trust store: ${(e as Error).message}`);
        }

        const crypto = await import("node:crypto");

        for await (const entry of Deno.readDir(config.pluginsPath)) {
          if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
            const absPath = await Deno.realPath(`${config.pluginsPath}/${entry.name}`);

            // Verificación de Integridad SHA-256
            const fileContent = await Deno.readFile(absPath);
            const hash = crypto.createHash("sha256").update(fileContent).digest("hex");

            if (lockfile[entry.name] && lockfile[entry.name] !== hash) {
              throw new Error(`[SecOps] ABORT: Plugin integrity check FAILED for '${entry.name}'. Expected ${lockfile[entry.name].substring(0, 16)}... but got ${hash.substring(0, 16)}... — posible modificación maliciosa.`);
            } else if (!lockfile[entry.name] && Deno.args.includes("--mode=production")) {
              throw new Error(`[SecOps] ABORT: Plugin '${entry.name}' not found in plugins.lock.json. Run 'zenith plugins:lock' to register it.`);
            }

            // [SecOps H-05] Si hay trust store Y existe el .manifest.json firmado,
            // verificar la cadena Ed25519 antes de cargar.
            if (trust && trust.keys.length > 0) {
              const manifestPath = `${absPath}.manifest.json`;
              try {
                const manifestRaw = await Deno.readTextFile(manifestPath);
                const manifest = parseManifest(manifestRaw);
                const result = await verifyPlugin({
                  pluginPath: absPath,
                  manifest,
                  trust,
                });
                if (!result.ok) {
                  throw new Error(
                    `[SecOps H-05] ABORT: Plugin signature verification FAILED for '${entry.name}': ${result.reason}${
                      result.detail ? ` (${result.detail})` : ""
                    }`,
                  );
                }
                console.log(`  [H-05] ✅ ${entry.name} signed by ${result.author} (keyId: ${result.keyId})`);
              } catch (e) {
                if (e instanceof Deno.errors.NotFound) {
                  throw new Error(
                    `[SecOps H-05] ABORT: Plugin '${entry.name}' has no .manifest.json but trust store is configured. ` +
                      `Run 'zenith plugin sign ${entry.name}' to sign it.`,
                  );
                }
                throw e;
              }
            }

            // Fix file URL for Windows (replace \ with / and prefix with file:///)
            const pluginUrl = `file:///${absPath.replace(/\\/g, "/")}`;
            console.log(`  -> Loading plugin: ${entry.name} [SHA-256: ${hash.substring(0, 16)}...]`);
            await import(pluginUrl);
          }
        }
      } catch (err: any) {
        if (err instanceof Deno.errors.NotFound) {
          console.log(`[ZenithBoot] 🔌 Plugin directory '${config.pluginsPath}' not found, skipping.`);
        } else {
          console.error(`[ZenithBoot] ❌ Error loading plugins:`, err);
          throw err; // Re-throw en producción para detener el boot
        }
      }
    }

    if (config.cloudCodePath) {
      const isProduction = Deno.args.includes("--mode=production");
      if (!isProduction) {
        // En Modo Desarrollo, cargamos dinámicamente desde el disco.
        // @ts-ignore
        if (engine["cloud-functions"]?.loadCloudCode) await engine["cloud-functions"].loadCloudCode(config.cloudCodePath);
      } else {
        console.log(`[ZenithBoot] 🔒 Production Mode: Dynamic import skipped. Relying on statically linked manifest by CLI.`);
      }
    }

    // Inicializar GraphQL Dinámico
    // @ts-ignore
    if (engine.buildSchema) await engine.buildSchema();

    // @ts-ignore
    const handler = engine.getHandler ? engine.getHandler(config) : null;

    return { engine, handler };
  } catch (error) {
    console.error(`❌ Failed to compose Zenith Engine for ${config.appId}:`, error);
    throw error;
  }
}

if (import.meta.main) {
  // Master Server Router: Carga la configuración Multi-App
  // y enruta según el mountPath (ej. /parse/app1)

  const { apps } = await import("../apps.config.ts");
  const { loadAppDefinitions, RuntimeMode } = await import("../config-loader.ts");

  if (RuntimeMode.isProduction) {
    console.log("[Zenith] 🔒 Production mode — fail-closed security enforced.");
  }
  
  // ─── Per-app handler registry ──────────────────────────────────────────────
  // Stores both the HTTP handler and the WebSocket handler per app.
  // The WS handler is exposed by the realtime-pubsub trait and MUST be called
  // with a pre-upgraded socket — not via new Request() which loses Deno's
  // internal connection resource ID.
  const mountedApps = new Map<string, Map<string, {
    httpHandler: (req: Request) => Promise<Response>;
    liveQueryWsHandler?: (socket: WebSocket, authPayload: { appId: string; sessionToken: string | undefined }) => void;
    mediaWsHandler?: (socket: WebSocket, roomId: string, authPayload: { appId: string; sessionToken: string | undefined }) => void;
  }>>();

  for (const appDef of apps) {
    const { engine, handler } = await createZenithApp(appDef.config);
    if (handler) {
      if (!mountedApps.has(appDef.mountPath)) {
        mountedApps.set(appDef.mountPath, new Map());
      }
      
      const realtimeApi = (engine as any)["realtime-pubsub"];
      const liveQueryWsHandler = realtimeApi?.handleWebSocket;

      const mediaWsHandler = (engine as any).handleWebSocket;

      mountedApps.get(appDef.mountPath)!.set(appDef.config.appId, {
        httpHandler: handler,
        liveQueryWsHandler,
        mediaWsHandler,
      });
      console.log(`🔗 Mounted App ID '${appDef.config.appId}' at ${appDef.mountPath}`);
    } else {
      console.log(`⚙️  Node ${appDef.config.appId} started without HTTP routing (Topology: ${appDef.config.topology?.join(',')})`);
    }

    // Run pending migrations per app
    // @ts-ignore
    if (engine.runPendingMigrations) {
      await engine.runPendingMigrations([initialSchemaMigration]);
    }
  }

  if (mountedApps.size > 0) {
    const port = apps.length > 0 ? apps[0].config.port : 23614;

    Deno.serve({ port }, async (req: Request, info: Deno.ServeHandlerInfo) => {
      const url = new URL(req.url);
      const appIdHeader = req.headers.get("Zen-Application-Id") ?? req.headers.get("X-Parse-Application-Id") ?? url.searchParams.get("appId");
      
      if (req.method !== "OPTIONS") {
        console.log(`[RouterDebug] ${req.method} ${url.pathname} - appIdHeader: ${appIdHeader}`);
      }

      for (const [mountPath, appHandlers] of mountedApps.entries()) {
        if (url.pathname.startsWith(mountPath)) {
          // Handle CORS Preflight globally for this mount path
          if (req.method === "OPTIONS") {
             return new Response(null, {
               status: 204,
               headers: {
                 "Access-Control-Allow-Origin": "*",
                 "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                 "Access-Control-Allow-Headers": "Content-Type, Authorization, Zen-Application-Id, Zen-Master-Key, Zen-Session-Token, Zen-Api-Key, Zen-Tenant-Id, Zen-Workspace-Id, Zen-Client-Version, Zen-Installation-Id, Zen-JavaScript-Key, Zen-Client-Key, X-Parse-Application-Id, X-Parse-Master-Key, X-Parse-Session-Token, X-Parse-REST-API-Key, X-Parse-JavaScript-Key, X-Parse-Client-Key, X-Parse-Installation-Id, X-Parse-Client-Version"
               }
             });
          }

          let appEntry: { httpHandler: (req: Request) => Promise<Response>; liveQueryWsHandler?: (socket: WebSocket, authPayload: { appId: string; sessionToken: string | undefined }) => void; mediaWsHandler?: (socket: WebSocket, roomId: string, authPayload: { appId: string; sessionToken: string | undefined }) => void; } | null = null;
          if (appIdHeader && appHandlers.has(appIdHeader)) {
            appEntry = appHandlers.get(appIdHeader)!;
          } else if (appHandlers.size === 1) {
            // Fallback: single app on this mount path
            appEntry = Array.from(appHandlers.values())[0];
          }

          if (appEntry) {
            // ── WebSocket Routing ──────────────────────────────────
            // CRITICAL: Deno.upgradeWebSocket() MUST receive the original Deno request
            if (req.headers.get("upgrade") === "websocket") {
              const sessionToken =
                req.headers.get("Zen-Session-Token") ??
                req.headers.get("X-Parse-Session-Token") ??
                url.searchParams.get("sessionToken") ??
                undefined;

              const authPayload = { appId: appIdHeader ?? '', sessionToken };

              // Route WebRTC Signaling Sockets
              if (url.pathname.includes("/media/") && appEntry.mediaWsHandler) {
                const { socket, response } = Deno.upgradeWebSocket(req);
                const roomId = url.pathname.split("/media/")[1]?.split("?")[0] || "global";
                appEntry.mediaWsHandler(socket, roomId, authPayload);
                return response;
              }

              // Route LiveQuery Sockets
              if (appEntry.liveQueryWsHandler) {
                const { socket, response } = Deno.upgradeWebSocket(req);
                appEntry.liveQueryWsHandler(socket, authPayload);
                return response;
              }

              return new Response(
                JSON.stringify({ code: 107, error: "WebSocket endpoint not found or disabled." }),
                { status: 400, headers: { "Content-Type": "application/json" } }
              );
            }

            // ── Regular HTTP — rewrite URL to strip mount prefix ───────────────
            const newPathname = url.pathname.slice(mountPath.length) || "/";
            const newUrl = new URL(newPathname + url.search, url.origin);
            const newReq = new Request(newUrl.href, {
              method: req.method,
              headers: req.headers,
              body: req.body,
              // @ts-ignore — Deno fetch dup
              duplex: "half",
            });
            return await appEntry.httpHandler(newReq);
          } else {
             return new Response(JSON.stringify({ code: 212, error: "Invalid or missing Application ID for this mount path." }), { 
               status: 403, 
               headers: { 
                 "Content-Type": "application/json",
                 "Access-Control-Allow-Origin": "*",
                 "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                 "Access-Control-Allow-Headers": "Content-Type, Authorization, Zen-Application-Id, Zen-Master-Key, Zen-Session-Token"
               } 
             });
          }
        }
      }

      return new Response(JSON.stringify({ code: 101, error: "No Zenith App mounted at this path." }), { 
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    });

    console.log(`🌐 Zenith Master Server listening on http://localhost:${port}`);
  } else {
    console.log(`🚀 Zenith Cluster Node running in purely specialized topology (No HTTP Server).`);
  }
}
