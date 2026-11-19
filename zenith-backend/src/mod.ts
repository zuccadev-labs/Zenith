/**
 * @module @zenith/mod
 *
 * Punto de entrada principal del motor Zenith.
 * Exporta `createZenithApp()` que compone traits vía Barrits, conecta
 * adaptadores (MongoDB, ScyllaDB, RustFS/S3, Kafka, etc.), carga claves
 * JWT desde Vault o MongoDB, y retorna un engine listo para manejar
 * requests HTTP, WebSocket, gRPC y ZeroMQ.
 *
 * En `if (import.meta.main)` arranca el servidor multi-app usando la
 * configuración de `apps.config.ts`.
 *
 * @barrits-runtime deno
 */
import { composeZenith } from "./core/compose.ts";
import { serveMetrics } from "./observability/metrics-server.ts";
import { selectFeatures, traitsOf } from "./core/feature-catalog.ts";
import { FEATURE_CATALOG } from "./traits/catalog.ts";
import { runtimeFeaturesTrait } from "./core/runtime-features.ts";
import { startBackground } from "./core/lifecycle.ts";
import { generateOpenApiSchema } from "./core/openapi.ts";
import {
  loadMergedTrustStore,
  parseManifest,
  verifyPlugin,
} from "./security/plugin-signing/mod.ts";
import { createMongoAdapter } from "./adapters/database/mongo.adapter.ts";
import { createScyllaAdapter } from "./adapters/database/scylla.adapter.ts";
import { createRustFSAdapter } from "./adapters/storage/rustfs.adapter.ts";
import { MongoClient } from "mongodb";
import cassandra from "cassandra-driver";
import { S3Client } from "@aws-sdk/client-s3";
import { generateKeyPairSync } from "node:crypto";
import { createKafkaAdapter } from "./adapters/events/kafka.adapter.ts";
import { createIPFSAdapter } from "./adapters/storage/ipfs.adapter.ts";
import { createNeo4jAdapter } from "./adapters/database/neo4j.adapter.ts";
import { createStripeAdapter } from "./adapters/billing/stripe.adapter.ts";
import { initialSchemaMigration } from "./migrations/001_initial_schema.ts";
import "./adapters/git.adapter.ts";
import "./adapters/vault.adapter.ts";
import "./adapters/lux-cache.adapter.ts";
import type { ZenithConfig } from "./core/types.ts";
import type { BillingMeteringService, CloudFunctionService, EngineAPI } from "./core/engine-api.ts";
import { _cloudCodeRegistry, ZENITH_ENGINE } from "./core/cloud.ts";

export { createSurrealAdapter, SurrealClient } from "./adapters/database/surreal.adapter.ts";
export { createQdrantAdapter } from "./adapters/vectordb/qdrant.adapter.ts";
export {
  createOllamaEmbedProvider,
  createOpenAIEmbedProvider,
} from "./traits/vectordb/vectordb.trait.ts";
// The namespace cloud code uses: `import { Zen } from "@zuccadev-labs/zenith"` (cloud/main.ts).
export { Zen } from "./core/cloud.ts";
export { installERPPlugin } from "./plugins/erp.plugin.ts";
export { installCRMPlugin } from "./plugins/crm.plugin.ts";
export { installEcommercePlugin } from "./plugins/ecommerce.plugin.ts";
export { CRMTrait } from "./traits/crm/crm.trait.ts";
export { ERPTrait } from "./traits/erp/erp.trait.ts";
export { CollaborationTrait } from "./traits/collaboration/collaboration.trait.ts";
export { WorkspaceTrait } from "./traits/workspace/workspace.trait.ts";
export { ViewsTrait } from "./traits/views/views.trait.ts";
export { SearchTrait } from "./traits/search/search.trait.ts";
export { TimelineTrait } from "./traits/timeline/timeline.trait.ts";
export { MetadataTrait } from "./traits/metadata/metadata.trait.ts";
export { BlogForumTrait } from "./traits/blogforum/blogforum.trait.ts";
export { ADKAgentsTrait } from "./traits/agents/adk.agents.trait.ts";
export {
  type AlarmInvocationInfo,
  type CellClass,
  type CellClassOptions,
  type CelldCellClass,
  CelldCellsClient,
  type CelldClientOptions,
  celldDeploy,
  type CelldDeployOptions,
  type CelldDevNode,
  type CelldNamespace,
  type CelldProject,
  type CelldProjectOptions,
  type CelldWranglerConfig,
  celldWranglerConfig,
  type CellEnv,
  CellError,
  type CellErrorCode,
  type CellHandlers,
  type CellsApi,
  type CellsConfig,
  type CellsDeps,
  type CellsHandle,
  type CellsStats,
  CellsTrait,
  type CellValue,
  createCellsApi,
  DurableObject,
  type DurableObjectId,
  type DurableObjectListOptions,
  type DurableObjectNamespace,
  type DurableObjectState,
  type DurableObjectStorage,
  type DurableObjectStub,
  type DurableObjectTransaction,
  generateCelldProject,
  type JobQueueLike,
  type KVGetType,
  type KVListOptions,
  type KVListResult,
  type KVNamespace,
  type KVPutOptions,
  type LocalCellsOptions,
  LocalCellsProvider,
  type MessageBatch,
  type Queue,
  type QueueConsumer,
  type QueueMessage,
  type QueueSendOptions,
  type RpcMethods,
  type SqlRow,
  type SqlStorage,
  type SqlStorageCursor,
  type SqlStorageValue,
  startCelldDev,
  type SyncKvStorage,
  type ZenCellsAPI,
} from "./traits/cells/mod.ts";
export { PluginMarketplaceTrait } from "./traits/marketplace/marketplace.trait.ts";
export type { FieldType, MetaField, MetaObject } from "./traits/metadata/metadata.trait.ts";
export type { ADKAgentDef, ADKSession, ADKTool } from "./traits/agents/adk.agents.trait.ts";
export type { InstalledPlugin, PluginManifest } from "./traits/marketplace/marketplace.trait.ts";
export { NotificationsTrait } from "./traits/notifications/notifications.trait.ts";
export { FavoritesTagsTrait } from "./traits/favtags/favtags.trait.ts";
export { WebhookManagerTrait } from "./traits/webhooks/webhook.manager.trait.ts";
export { CSVTrait } from "./traits/csv/csv.trait.ts";
export { EmailSyncTrait } from "./traits/email/email.sync.trait.ts";
export type {
  EmailAdapterDef,
  EmailChannel,
  EmailMessage,
  MessageThread,
} from "./traits/email/email.sync.trait.ts";
export { CalendarSyncTrait } from "./traits/calendar/calendar.sync.trait.ts";
export type {
  CalendarAdapterDef,
  CalendarChannel,
  CalendarEvent,
  CalendarSlot,
} from "./traits/calendar/calendar.sync.trait.ts";
export { AutomationTrait } from "./traits/automation/automation.trait.ts";
export type {
  ActionType,
  AutoAction,
  AutoCondition,
  AutoConditionGroup,
  AutomationRule,
} from "./traits/automation/automation.trait.ts";
export { CacheTrait } from "./traits/cache/cache.trait.ts";
export { PushTrait } from "./traits/push/push.trait.ts";
export { JobQueueTrait } from "./traits/queue/job.queue.trait.ts";
export { CircuitBreakerTrait } from "./traits/resilience/circuit.breaker.trait.ts";
export { createScyllaTimeSeriesAdapter } from "./adapters/timeseries/scylla.timeseries.adapter.ts";
export type {
  TimeSeriesPoint,
  TimeSeriesQuery,
} from "./adapters/timeseries/scylla.timeseries.adapter.ts";
export type { IoTAlert, IoTDevice, SenMLRecord, TelemetryPayload } from "./traits/iot/iot.trait.ts";
export type {
  AgentDefinition,
  AgentRunResult,
  AgentTool,
} from "./traits/agents/agent.orchestrator.trait.ts";
export { FEATURE_FLAGS, PLAN_LIMITS } from "./traits/featureflags/featureflags.trait.ts";
export type { Plan, PlanLimits } from "./traits/featureflags/featureflags.trait.ts";
export type { TenantConfig } from "./traits/tenant/tenant.trait.ts";
export type {
  AuditEntry,
  DataClassification,
  PII_Field,
} from "./traits/compliance/compliance.trait.ts";

function optionalCall<T>(obj: unknown, key: string, ...args: unknown[]): unknown {
  const fn = (obj as Record<string, unknown>)[key];
  if (typeof fn === "function") return fn(...args);
  return undefined;
}

/**
 * The traits a configuration activates, in boot order. Pure: `createZenithApp` composes exactly
 * this list, and the composition tests check it for every topology/feature combination.
 */
export function selectTraits(config: ZenithConfig): unknown[] {
  const features = selectFeatures(FEATURE_CATALOG, config);
  console.log(`[ZenithBoot] Features: ${features.map((f) => f.id).join(", ")}.`);
  // The runtime registry goes first: it is core and the router gates every route with it.
  return [runtimeFeaturesTrait(features, config), ...traitsOf(features, config)];
}

/**
 * Composes and bootstraps a complete Zenith Engine instance for the given application configuration.
 *
 * Orchestrates the full startup sequence:
 *   1. Selects active traits based on topology and feature flags (database, billing, AI, edge, etc.)
 *   2. Composes traits with `composeZenith` (barrits, ordered by consumed capabilities)
 *   3. Generates OpenAPI v3.1 spec with live cloud code function discovery
 *   4. Initializes database adapters (MongoDB, ScyllaDB) and storage (RustFS/S3)
 *   5. Conditionally connects optional adapters (Kafka, IPFS, Neo4j, Stripe)
 *   6. Loads JWT signing keys from Vault or MongoDB (with auto-generation)
 *   7. Verifies and loads plugins from the plugins directory with integrity checking
 *   8. Loads cloud code from the cloudCodePath
 *   9. Returns the composed engine and HTTP handler
 *
 * @param config - ZenithConfig with appId, masterKey, databaseURI, features, topology, etc.
 * @returns Object with `engine` (composed EngineAPI) and `handler` (HTTP request handler or null)
 */
export async function createZenithApp(
  config: ZenithConfig,
): Promise<{ engine: EngineAPI; handler: ((req: Request) => Promise<Response>) | null }> {
  console.log(`🚀 Bootstrapping Zenith Engine for App: ${config.appId}...`);

  try {
    const activeTraits = selectTraits(config);
    const composition = composeZenith(activeTraits);
    const engine = composition.traits as unknown as EngineAPI;
    console.log("[ZenithBoot] Final Composed Capabilities:", Object.keys(engine));

    const openApiOptions = {
      title: `${config.appId} — Zenith API`,
      description: "Auto-generated from Barrits Trait AST. Parse Server-compatible BaaS.",
      version: "1.0.0",
      serverURL: config.serverURL || `http://localhost:${config.port || 23614}`,
      appId: config.appId,
    };

    const buildLiveOpenApiSpec = () => {
      const dynamicFnRoutes = _cloudCodeRegistry.listFunctions().map((fnName) => ({
        method: "POST",
        path: `/functions/${fnName}`,
      }));
      const dynamicJobRoutes = _cloudCodeRegistry.listJobs().map((jobName) => ({
        method: "POST",
        path: `/jobs/${jobName}`,
      }));

      const augmentedEngine = {
        ...engine,
        __dynamic_fn_routes: dynamicFnRoutes,
        __dynamic_job_routes: dynamicJobRoutes,
      };

      return generateOpenApiSchema(augmentedEngine, openApiOptions);
    };

    const metaRoutes = [
      {
        access: "public",
        method: "GET",
        path: "/openapi.json",
        handler: (_req: Request, _ctx: unknown) =>
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
        access: "public",
        method: "GET",
        path: "/swagger",
        handler: (_req: Request, _ctx: unknown) =>
          new Response(
            `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${config.appId} — Zenith API Docs</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"/></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"./openapi.json",dom_id:"#swagger-ui",presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset],layout:"BaseLayout",deepLinking:true,persistAuthorization:true})</script></body></html>`,
            { status: 200, headers: { "Content-Type": "text/html" } },
          ),
      },
    ];

    if (Array.isArray(engine.routes)) {
      (engine.routes as unknown[]).push(...metaRoutes);
    } else {
      engine.routes = metaRoutes;
    }

    console.log(
      `✅ Zenith Engine Composed for ${config.appId}. OpenAPI spec ready at /openapi.json`,
    );

    const allowedCommands = config.allowedShellCommands || ["git", "vault", "kubectl", "lux-db"];
    if (engine.Plugins && (engine as unknown as Record<string, unknown>).Shell) {
      optionalCall(
        (engine as unknown as Record<string, unknown>).Shell,
        "setAllowedCommands",
        allowedCommands,
      );
      console.log(
        `[ZenithBoot] 🛡️ Zen.Shell allowlist configured: [${allowedCommands.join(", ")}]`,
      );
    }

    const mongoUri = config.databaseURI || "mongodb://localhost:27614";
    const mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    const mongoPlugin = createMongoAdapter(mongoClient.db(config.appId));

    // ScyllaDB only when this app uses it (database or auth/time-series store): an unconfigured
    // Scylla used to block every boot.
    const scyllaUri =
      (config as unknown as Record<string, unknown>).authDatabaseURI as string | undefined ??
        (config.databaseURI?.match(/^(?:cassandra|scylla):\/\/(.+)$/)?.[1]);
    if (scyllaUri) {
      const scyllaHost = scyllaUri.split(":")[0];
      const scyllaPort = parseInt(scyllaUri.split(":")[1] || "9042", 10);
      const scyllaClient = new cassandra.Client({
        contactPoints: [scyllaHost],
        protocolOptions: { port: scyllaPort },
        localDataCenter: "datacenter1",
      });
      await scyllaClient.connect();
      optionalCall(engine, "injectScyllaPlugin", createScyllaAdapter(scyllaClient));
    }

    optionalCall(engine, "injectMongoPlugin", mongoPlugin);

    // engine-auth: users, sessions and token verification. A bad configuration stops the boot
    // (fail closed); without one the user routes answer 503 and every request is anonymous.
    const userManager =
      (engine as unknown as Record<string, { configure?: (c: unknown) => void }>)["user-manager"];
    if (config.engineAuth && userManager?.configure) {
      userManager.configure(config.engineAuth);
      console.log(
        `[ZenithBoot] 🔐 engine-auth: issuer ${config.engineAuth.issuer}, audience ${config.engineAuth.audience}`,
      );
    } else {
      console.warn(
        "[ZenithBoot] ⚠️ engineAuth not configured: user routes answer 503, all requests are anonymous.",
      );
    }

    // engine-push: notices to people by its socket; the owners carry this app's id.
    const enginePush =
      (engine as unknown as Record<string, { configure?: (c: unknown) => void }>)["enginePush"];
    enginePush?.configure?.({ appId: config.appId, ...(config.enginePush ?? {}) });

    // cells (ADR-019): this app's provider and directory; the local one arms its pending alarms now.
    const cells = (engine as unknown as Record<
      string,
      { configure?: (c: unknown) => void; start?: () => void }
    >)["cells"];
    cells?.configure?.({ appId: config.appId, ...(config.cells ?? {}) });
    cells?.start?.();

    // /classes for users: only schema-defined classes unless the app opts into client class creation.
    const crud =
      (engine as unknown as Record<string, { configure?: (c: unknown) => void }>)["crud"];
    crud?.configure?.({ allowClientClassCreation: config.allowClientClassCreation === true });

    const s3Uri = (config as unknown as Record<string, unknown>).mediaStorageURI as string ||
      "http://localhost:8614";
    const s3Client = new S3Client({
      region: "us-east-1",
      endpoint: s3Uri,
      forcePathStyle: true,
      credentials: {
        accessKeyId: Deno.env.get("RUSTFS_ACCESS_KEY") || "admin",
        secretAccessKey: Deno.env.get("RUSTFS_SECRET_KEY") || "admin",
      },
    });
    const rustfsPlugin = createRustFSAdapter(s3Client, `${config.appId}-storage`);
    optionalCall(engine, "injectRustFSPlugin", rustfsPlugin);

    if (config.features?.events) {
      const kafkaPlugin = createKafkaAdapter(config.appId);
      optionalCall(engine, "injectEventPlugin", kafkaPlugin);
      await kafkaPlugin.connect(["localhost:9092"]);
    }

    if (config.features?.web3) {
      const ipfsPlugin = createIPFSAdapter("https://ipfs.io");
      optionalCall(engine, "injectIPFSPlugin", ipfsPlugin);
    }

    if (config.features?.graph) {
      const neo4jPlugin = createNeo4jAdapter();
      const neo4jUri = Deno.env.get("NEO4J_URI") || "bolt://localhost:7687";
      const neo4jUser = Deno.env.get("NEO4J_USER") || "neo4j";
      const neo4jPassword = Deno.env.get("NEO4J_PASSWORD");
      if (!neo4jPassword) {
        console.warn(
          "[ZenithBoot] Warning: NEO4J_PASSWORD is not set. Neo4j graph capabilities might fail to authenticate.",
        );
      }
      await neo4jPlugin.connect(neo4jUri, neo4jUser, neo4jPassword || "unsafe_default");
    }

    if (config.features?.saas) {
      const stripePlugin = createStripeAdapter(Deno.env.get("STRIPE_API_KEY") || "sk_test_mock");
      const billing = engine["billing-metering"] as BillingMeteringService | undefined;
      if (billing?.injectAdapter) billing.injectAdapter(stripePlugin);
    }

    if (config.features?.e2ee_media) {
      console.log(
        `[Zenith] Loading E2EE Media Module (Mode: ${
          config.features.e2ee_mode || "strict_sframe"
        })`,
      );
      if (engine.setE2EEMode) engine.setE2EEMode(config.features.e2ee_mode || "strict_sframe");
    }

    // Background work (webhook deliveries…) starts once, with the data adapters connected.
    startBackground(engine as unknown as Record<string, unknown>);

    const globalConfigCol = mongoClient.db(config.appId).collection<
      { _id: string; [k: string]: unknown }
    >("_GlobalConfig");
    let privateKeyStr: string;
    let publicKeyStr: string;

    const vaultAddr = Deno.env.get("VAULT_ADDR");
    if (vaultAddr) {
      console.log(`[ZenithBoot] 🔑 Cargando llaves JWT desde Vault (${vaultAddr})...`);
      const { ZenPlugins } = await import("./core/cloud.ts");
      if (!ZenPlugins.Vault?.isActive()) {
        throw new Error(
          "[ZenithBoot] VAULT_ADDR is set but Vault plugin is not active. " +
            "Check VAULT_TOKEN or AppRole credentials in environment.",
        );
      }
      const vaultClient = ZenPlugins.Vault.client() as {
        kvGet: (path: string) => Promise<
          {
            data?: { privateKey?: string; publicKey?: string };
            metadata?: { version: number };
          } | null
        >;
      };
      const secret = await vaultClient.kvGet(`zenith/${config.appId}/jwt-keys`);
      if (secret?.data?.privateKey && secret?.data?.publicKey) {
        privateKeyStr = secret.data.privateKey;
        publicKeyStr = secret.data.publicKey;
        console.log(
          `[ZenithBoot] 🔑 Llaves RSA cargadas desde Vault (v${secret.metadata?.version ?? "?"}).`,
        );
      } else {
        console.log(
          `[ZenithBoot] 🔑 No se encontraron llaves en Vault. Generando nuevas y guardando...`,
        );
        const { publicKey, privateKey } = generateKeyPairSync("rsa", {
          modulusLength: 2048,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        privateKeyStr = privateKey;
        publicKeyStr = publicKey;
        await ZenPlugins.Vault.kvPut(`zenith/${config.appId}/jwt-keys`, {
          privateKey: privateKeyStr,
          publicKey: publicKeyStr,
          createdAt: new Date().toISOString(),
        });
        console.log(`[ZenithBoot] 🔑 Llaves RSA generadas y guardadas en Vault.`);
      }
    } else {
      const jwtKeys = await globalConfigCol.findOne({ _id: "jwt_keys" });
      if (!jwtKeys) {
        console.log(`[ZenithBoot] 🔑 Generando nuevas llaves RSA para App: ${config.appId}...`);
        const { publicKey, privateKey } = generateKeyPairSync("rsa", {
          modulusLength: 2048,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        privateKeyStr = privateKey;
        publicKeyStr = publicKey;

        await globalConfigCol.insertOne({
          _id: "jwt_keys",
          privateKey: privateKeyStr,
          publicKey: publicKeyStr,
          createdAt: new Date(),
        });
      } else {
        console.log(`[ZenithBoot] 🔑 Llaves RSA cargadas desde base de datos.`);
        privateKeyStr = jwtKeys.privateKey as string;
        publicKeyStr = jwtKeys.publicKey as string;
      }
    }

    if (engine.initKeys) engine.initKeys(privateKeyStr, publicKeyStr);

    if (engine.schema_init) await engine.schema_init(config);
    if (engine.observability_init) engine.observability_init();
    if (engine.acl_init) engine.acl_init(config);
    if (engine.ratelimit_init) await engine.ratelimit_init();
    if (engine.ai_init) engine.ai_init(config);

    if (config.pluginsPath) {
      console.log(`[ZenithBoot] 🔌 Loading plugins from ${config.pluginsPath}...`);
      try {
        let lockfile: Record<string, string> = {};

        const lockfilePath = `${Deno.cwd()}/plugins.lock.json`;
        try {
          const lockContent = await Deno.readTextFile(lockfilePath);
          lockfile = JSON.parse(lockContent);
          console.log(
            `[SecOps] ✅ plugins.lock.json cargado desde raíz del proyecto (${lockfilePath})`,
          );
        } catch (_e) {
          console.warn(`[SecOps] ⚠️ No se encontró plugins.lock.json en ${lockfilePath}.`);
          if (Deno.args.includes("--mode=production")) {
            throw new Error(
              `[SecOps] ABORT: Missing plugins.lock.json at project root in Production Mode. ACE Prevention. Run 'zenith plugins:lock' to generate it.`,
            );
          }
        }

        let trust = null;
        try {
          trust = await loadMergedTrustStore();
          if (trust.keys.length > 0) {
            console.log(
              `[SecOps H-05] ✅ Trust store cargado: ${trust.keys.length} clave(s) de autor confiable(s).`,
            );
          }
        } catch (e) {
          console.warn(`[SecOps H-05] ⚠️ No se pudo cargar trust store: ${(e as Error).message}`);
        }

        const crypto = await import("node:crypto");
        const isProduction = Deno.args.includes("--mode=production");

        for await (const entry of Deno.readDir(config.pluginsPath)) {
          if (!entry.isFile) continue;
          if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;

          try {
            const absPath = await Deno.realPath(`${config.pluginsPath}/${entry.name}`);

            const fileContent = await Deno.readFile(absPath);
            const hash = crypto.createHash("sha256").update(fileContent).digest("hex");

            if (lockfile[entry.name] && lockfile[entry.name] !== hash) {
              throw new Error(
                `[SecOps] ABORT: Plugin integrity check FAILED for '${entry.name}'. ` +
                  `Expected ${lockfile[entry.name].substring(0, 16)}... but got ${
                    hash.substring(0, 16)
                  }...`,
              );
            }
            if (!lockfile[entry.name] && isProduction) {
              throw new Error(
                `[SecOps] ABORT: Plugin '${entry.name}' not found in plugins.lock.json. ` +
                  `Run 'zenith plugins:lock' to register it.`,
              );
            }

            if (trust && trust.keys.length > 0) {
              const manifestPath = `${absPath}.manifest.json`;
              try {
                const manifestRaw = await Deno.readTextFile(manifestPath);
                const manifest = parseManifest(manifestRaw);
                const result = await verifyPlugin({ pluginPath: absPath, manifest, trust });
                if (!result.ok) {
                  throw new Error(
                    `[SecOps H-05] ABORT: Plugin signature verification FAILED for '${entry.name}': ${result.reason}${
                      result.detail ? ` (${result.detail})` : ""
                    }`,
                  );
                }
                console.log(
                  `  [H-05] ✅ ${entry.name} signed by ${result.author} (keyId: ${result.keyId})`,
                );
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

            const pluginUrl = `file:///${absPath.replace(/\\/g, "/")}`;
            console.log(
              `  -> Loading plugin: ${entry.name} [SHA-256: ${hash.substring(0, 16)}...]`,
            );
            await import(pluginUrl);
            console.log(`  ✅ Loaded plugin: ${entry.name}`);
          } catch (err) {
            const msg = `[PluginLoader] Failed to load '${entry.name}': ${(err as Error).message}`;
            if (isProduction) {
              console.error(msg);
              throw err;
            }
            console.warn(
              `${msg} — skipping. Set ZENITH_STRICT_PLUGINS=true to abort on plugin errors.`,
            );
            if (Deno.env.get("ZENITH_STRICT_PLUGINS") === "true") throw err;
          }
        }
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          console.log(
            `[ZenithBoot] 🔌 Plugin directory '${config.pluginsPath}' not found, skipping.`,
          );
        } else {
          console.error(`[ZenithBoot] ❌ Error loading plugins:`, err);
          throw err;
        }
      }
    }

    if (config.cloudCodePath) {
      const isProduction = Deno.args.includes("--mode=production");
      if (!isProduction) {
        const cloudFunctions = engine["cloud-functions"] as CloudFunctionService | undefined;
        if (cloudFunctions?.loadCloudCode) {
          console.log(`[ZenithBoot] 📦 Loading cloud code from: ${config.cloudCodePath}`);
          await cloudFunctions.loadCloudCode(config.cloudCodePath);
        }
      } else {
        console.log(
          `[ZenithBoot] 🔒 Production Mode: Dynamic import skipped. Relying on statically linked manifest by CLI.`,
        );
      }
    }

    if (engine.buildSchema) await engine.buildSchema();

    const handler = engine.getHandler ? engine.getHandler(config) : null;

    // Store engine reference for Zen.Cloud to access
    (ZENITH_ENGINE as { current: EngineAPI | null }).current = engine;

    return { engine, handler };
  } catch (error) {
    console.error(`❌ Failed to compose Zenith Engine for ${config.appId}:`, error);
    throw error;
  }
}

if (import.meta.main) {
  // The monorepo's multi-app boot (Docker image, `deno task start`). These files are not part of the
  // published package; projects boot through `zen dev` / `zen compile` instead.
  const { apps } = await import(new URL("../apps.config.ts", import.meta.url).href);
  const { RuntimeMode } = await import(new URL("../config-loader.ts", import.meta.url).href);

  if (RuntimeMode.isProduction) {
    console.log("[Zenith] 🔒 Production mode — fail-closed security enforced.");
  }

  const mountedApps = new Map<
    string,
    Map<string, {
      httpHandler: (req: Request) => Promise<Response>;
      liveQueryWsHandler?: (
        socket: WebSocket,
        authPayload: { appId: string; sessionToken: string | undefined },
      ) => void;
      mediaWsHandler?: (
        socket: WebSocket,
        roomId: string,
        authPayload: { appId: string; sessionToken: string | undefined },
      ) => void;
    }>
  >();

  const metricsSources: Array<{ labels: Record<string, string>; text: () => string }> = [];
  for (const appDef of apps) {
    const { engine, handler } = await createZenithApp(appDef.config);
    const registry = engine["metric-registry"] as { toPrometheus?: () => string } | undefined;
    if (registry?.toPrometheus) {
      metricsSources.push({
        labels: { app: appDef.config.appId },
        text: () => registry.toPrometheus!(),
      });
    }
    if (handler) {
      if (!mountedApps.has(appDef.mountPath)) {
        mountedApps.set(appDef.mountPath, new Map());
      }

      const realtimeApi = engine["realtime-pubsub"];
      const liveQueryWsHandler = realtimeApi?.handleWebSocket;

      const mediaWsHandler = engine.handleWebSocket;

      mountedApps.get(appDef.mountPath)!.set(appDef.config.appId, {
        httpHandler: handler,
        liveQueryWsHandler,
        mediaWsHandler,
      });
      console.log(`🔗 Mounted App ID '${appDef.config.appId}' at ${appDef.mountPath}`);
    } else {
      console.log(
        `⚙️  Node ${appDef.config.appId} started without HTTP routing (Topology: ${
          appDef.config.topology?.join(",")
        })`,
      );
    }

    if (engine.runPendingMigrations) {
      await engine.runPendingMigrations([initialSchemaMigration]);
    }
  }

  // Prometheus scrape listener (observability/metrics-server.ts): its own port, metrics only, every app.
  const metricsPort = Number(Deno.env.get("ZENITH_METRICS_PORT") ?? 0);
  if (metricsPort > 0 && metricsSources.length > 0) {
    serveMetrics({
      port: metricsPort,
      hostname: Deno.env.get("ZENITH_METRICS_HOST") ?? undefined,
      sources: () => metricsSources,
    });
  }

  if (mountedApps.size > 0) {
    const port = apps.length > 0 ? apps[0].config.port : 23614;

    Deno.serve({ port }, async (req: Request, info: Deno.ServeHandlerInfo) => {
      const url = new URL(req.url);
      // Process health for Kubernetes probes and load balancers: no Application ID, no mount path. The server only
      // listens once every app is composed, so answering means it is up. Before, /health outside a mount was 404
      // and the chart's probes never passed.
      if ((url.pathname === "/health" || url.pathname === "/healthz") && req.method === "GET") {
        return Response.json({ status: "ok", apps: apps.length });
      }
      const appIdHeader = req.headers.get("Zen-Application-Id") ??
        req.headers.get("X-Parse-Application-Id") ?? url.searchParams.get("appId");

      if (req.method !== "OPTIONS") {
        console.log(`[RouterDebug] ${req.method} ${url.pathname} - appIdHeader: ${appIdHeader}`);
      }

      for (const [mountPath, appHandlers] of mountedApps.entries()) {
        if (url.pathname.startsWith(mountPath)) {
          if (req.method === "OPTIONS") {
            return new Response(null, {
              status: 204,
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers":
                  "Content-Type, Authorization, Zen-Application-Id, Zen-Master-Key, Zen-Session-Token, Zen-Api-Key, Zen-Tenant-Id, Zen-Workspace-Id, Zen-Client-Version, Zen-Installation-Id, Zen-JavaScript-Key, Zen-Client-Key, X-Parse-Application-Id, X-Parse-Master-Key, X-Parse-Session-Token, X-Parse-REST-API-Key, X-Parse-JavaScript-Key, X-Parse-Client-Key, X-Parse-Installation-Id, X-Parse-Client-Version",
              },
            });
          }

          let appEntry: typeof appHandlers extends Map<string, infer V> ? V : never = null as never;
          if (appIdHeader && appHandlers.has(appIdHeader)) {
            appEntry = appHandlers.get(appIdHeader)!;
          } else if (appHandlers.size === 1) {
            appEntry = Array.from(appHandlers.values())[0];
          }

          if (appEntry) {
            if (req.headers.get("upgrade") === "websocket") {
              const sessionToken = req.headers.get("Zen-Session-Token") ??
                req.headers.get("X-Parse-Session-Token") ??
                url.searchParams.get("sessionToken") ??
                undefined;

              const authPayload = { appId: appIdHeader ?? "", sessionToken };

              if (url.pathname.includes("/media/") && appEntry.mediaWsHandler) {
                const { socket, response } = Deno.upgradeWebSocket(req);
                const roomId = url.pathname.split("/media/")[1]?.split("?")[0] || "global";
                appEntry.mediaWsHandler(socket, roomId, authPayload);
                return response;
              }

              if (appEntry.liveQueryWsHandler) {
                const { socket, response } = Deno.upgradeWebSocket(req);
                appEntry.liveQueryWsHandler(socket, authPayload);
                return response;
              }

              return new Response(
                JSON.stringify({ code: 107, error: "WebSocket endpoint not found or disabled." }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }

            const newPathname = url.pathname.slice(mountPath.length) || "/";
            const newUrl = new URL(newPathname + url.search, url.origin);
            // The app sees paths without its mount: X-Forwarded-Prefix tells it (absolute URLs it
            // returns, such as signed file URLs). Set here, overwriting any value from the client.
            const forwardedHeaders = new Headers(req.headers);
            forwardedHeaders.set("x-forwarded-prefix", mountPath);
            const newReq = new Request(
              newUrl.href,
              {
                method: req.method,
                headers: forwardedHeaders,
                body: req.body,
                duplex: "half",
              } as RequestInit & { duplex: "half" },
            );
            // The pipeline reads the client address from here (master key only from localhost,
            // rate limits per client). Without it every request looked local.
            (newReq as unknown as { __socketAddr: Deno.NetAddr }).__socketAddr = info
              .remoteAddr as Deno.NetAddr;
            return await appEntry.httpHandler(newReq);
          } else {
            return new Response(
              JSON.stringify({
                code: 212,
                error: "Invalid or missing Application ID for this mount path.",
              }),
              {
                status: 403,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                  "Access-Control-Allow-Headers":
                    "Content-Type, Authorization, Zen-Application-Id, Zen-Master-Key, Zen-Session-Token",
                },
              },
            );
          }
        }
      }

      return new Response(
        JSON.stringify({ code: 101, error: "No Zenith App mounted at this path." }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    });

    console.log(`🌐 Zenith Master Server listening on http://localhost:${port}`);
  } else {
    console.log(`🚀 Zenith Cluster Node running in purely specialized topology (No HTTP Server).`);
  }
}
