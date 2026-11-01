/**
 * spec-extractor.ts — Extrae las rutas de todos los traits sin levantar el servidor.
 *
 * Estrategia: importa cada TraitDescriptor directamente y llama a create()
 * con un mock de deps. El trait retorna sus routes arrays en el resultado.
 * No requiere MongoDB, ScyllaDB ni ninguna conexión real.
 *
 * Este script se ejecuta desde el CLI con:
 *   deno run -A zenith-cli/spec-extractor.ts
 * y emite el state compuesto como JSON en stdout.
 */

// Mock de adaptadores — retorna objetos vacíos para satisfacer los type checks
function mockDB() {
  const noop = async () => ({});
  return {
    create: noop, read: noop, update: noop, delete: noop,
    find: async () => [], count: async () => 0,
    aggregate: async () => [], createIndex: noop,
  };
}

function mockEvents() {
  return { emit: () => {}, on: () => {}, off: () => {} };
}

function mockStorage() {
  return {
    upload: async () => ({}), download: async () => new Uint8Array(),
    delete: async () => {}, list: async () => [],
  };
}

function mockCache() { return { get: async () => null, set: async () => {}, del: async () => {} }; }
function mockQueue() { return { enqueue: async () => ({}), process: () => {} }; }
function mockACL()   { return { check: async () => true }; }
function mockTelemetry() { return { record: () => {}, increment: () => {}, timing: () => {} }; }

const MOCK_DEPS: Record<string, unknown> = {
  db:          mockDB(),
  events:      mockEvents(),
  storage:     mockStorage(),
  cache:       mockCache(),
  queue:       mockQueue(),
  acl:         mockACL(),
  telemetry:   mockTelemetry(),
  config:      {},
  notifications: null,
  emailSync:   null,
  adkAgents:   null,
};

// ── Importar todos los traits ─────────────────────────────────────────────────

const BASE = new URL("../zenith-backend/src/traits/", import.meta.url).href;

async function tryCreate(descriptor: any): Promise<Record<string, unknown>> {
  try {
    if (!descriptor?.create) return {};
    const result = descriptor.create(MOCK_DEPS);
    return result ?? {};
  } catch {
    return {};
  }
}

// Lista de todos los traits a introspeccionar
const TRAIT_MODULES: Array<[string, string]> = [
  // Fases 1-3 (traits propios del negocio — más importantes para la spec)
  ["collaboration", "collaboration/collaboration.trait.ts"],
  ["workspace",     "workspace/workspace.trait.ts"],
  ["views",         "views/views.trait.ts"],
  ["search",        "search/search.trait.ts"],
  ["timeline",      "timeline/timeline.trait.ts"],
  ["metadata",      "metadata/metadata.trait.ts"],
  ["blogforum",     "blogforum/blogforum.trait.ts"],
  ["adk_agents",    "agents/adk.agents.trait.ts"],
  ["marketplace",   "marketplace/marketplace.trait.ts"],
  ["notifications", "notifications/notifications.trait.ts"],
  ["favtags",       "favtags/favtags.trait.ts"],
  ["webhooks",      "webhooks/webhook.manager.trait.ts"],
  ["csv",           "csv/csv.trait.ts"],
  ["email",         "email/email.sync.trait.ts"],
  ["calendar",      "calendar/calendar.sync.trait.ts"],
  ["automation",    "automation/automation.trait.ts"],
  // Base
  ["iot",           "iot/iot.trait.ts"],
  ["vectordb",      "vectordb/vectordb.trait.ts"],
  ["featureflags",  "featureflags/featureflags.trait.ts"],
  ["workflow",      "workflow/workflow.trait.ts"],
  ["compliance",    "compliance/compliance.trait.ts"],
];

// Mapping de export names por módulo
const EXPORT_NAMES: Record<string, string> = {
  collaboration: "CollaborationTrait",
  workspace:     "WorkspaceTrait",
  views:         "ViewsTrait",
  search:        "SearchTrait",
  timeline:      "TimelineTrait",
  metadata:      "MetadataTrait",
  blogforum:     "BlogForumTrait",
  adk_agents:    "ADKAgentsTrait",
  marketplace:   "PluginMarketplaceTrait",
  notifications: "NotificationsTrait",
  favtags:       "FavoritesTagsTrait",
  webhooks:      "WebhookManagerTrait",
  csv:           "CSVTrait",
  email:         "EmailSyncTrait",
  calendar:      "CalendarSyncTrait",
  automation:    "AutomationTrait",
  iot:           "IoTTrait",
  vectordb:      "VectorDBTrait",
  featureflags:  "FeatureFlagsTrait",
  workflow:      "WorkflowTrait",
  compliance:    "ComplianceTrait",
};

async function main() {
  const composedState: Record<string, unknown> = {};

  for (const [key, path] of TRAIT_MODULES) {
    try {
      const mod        = await import(BASE + path);
      const exportName = EXPORT_NAMES[key];
      const descriptor = mod[exportName];
      if (!descriptor) continue;

      const result = await tryCreate(descriptor);

      // Cada trait retorna { <name>_routes: [...], <name>: api, ... }
      for (const [k, v] of Object.entries(result)) {
        composedState[k] = v;
      }
    } catch {
      // Silenciar errores de import — trait puede tener deps externas
    }
  }

  // Emitir como JSON para que el CLI lo capture
  console.log(JSON.stringify(composedState));
}

await main();
