/**
 * Plugin Marketplace Trait — Registro, instalación y gestión de plugins.
 *
 * El binario Zenith es la base — el CLI (`zen`) es la herramienta de desarrollo.
 * Este trait implementa el marketplace en el servidor para que los usuarios
 * puedan descubrir, instalar y gestionar plugins sin tocar código:
 *
 *   zen plugin install @vendor/mi-plugin    (CLI → llama a este API)
 *   zen plugin list                          (CLI → llama a este API)
 *
 * Patrón Adaptador: cada plugin registra su propio Trait mediante
 * `registerPlugin()`. El motor los compone en el pipeline de Barrits.
 *
 * @barrits-trait
 * @barrits-summary ZenithPluginMarketplace
 * @barrits-provides marketplace_routes, pluginRegistry
 * @barrits-consumes db
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import {
  errRes,
  jsonRes,
  NO_CONTENT,
  now,
  parsePage,
  pathParams,
  queryParams,
} from "../../core/trait-utils.ts";

/** Catalog entry describing a plugin that can be installed from the marketplace. */
export interface PluginManifest {
  /** Scoped package identifier, e.g. `@vendor/plugin-name`. */
  id: string;
  /** Human-readable name shown in the catalog. */
  name: string;
  /** Semantic version of the plugin. */
  version: string;
  /** Short description of what the plugin adds. */
  description: string;
  /** Author or vendor that publishes the plugin. */
  author: string;
  /** Optional icon URL for catalog listings. */
  icon?: string;
  /** Free-form tags matched by the catalog text search. */
  tags: string[];
  /** Catalog category, usable as a filter in `GET /zen/plugins/catalog`. */
  category: "crm" | "erp" | "analytics" | "integration" | "ai" | "media" | "dev" | "other";
  /** Path or URL of the plugin's main module. */
  entryPoint: string;
  /** Capabilities the plugin exposes, e.g. `["email-sync", "slack-notifications"]`. */
  provides: string[];
  /** Core capabilities the plugin needs, e.g. `["db", "events"]`. */
  requires: string[];
  /** Optional project homepage URL. */
  homepage?: string;
  /** Optional source repository URL. */
  repository?: string;
  /** Optional SPDX license identifier. */
  license?: string;
  /** Pricing model, usable as a filter in the catalog. */
  pricing: "free" | "freemium" | "paid";
  /** Monthly price in USD when `pricing` is `"paid"`. */
  price?: number;
}

/** A plugin installed in this server, persisted in the `_InstalledPlugin` collection. */
export interface InstalledPlugin {
  /** Database object id of the installation record. */
  objectId: string;
  /** Identifier of the installed plugin (matches {@linkcode PluginManifest.id}). */
  pluginId: string;
  /** Installed version (`"latest"` when the install config gives none). */
  version: string;
  /** Whether the plugin is running, turned off by an admin, or failed. */
  status: "active" | "disabled" | "error";
  /** Plugin-specific configuration given at install time and merged by updates. */
  config: Record<string, any>;
  /** ISO timestamp of the installation. */
  installedAt: string;
  /** ISO timestamp of the last enable, disable or config change. */
  updatedAt: string;
  /** Error message when `status` is `"error"`. */
  error?: string;
}

/** Registro en memoria — sincronizado con _InstalledPlugin en DB */
const INSTALLED = new Map<string, InstalledPlugin>();
/** Adaptador: handlers registrados por plugins en runtime */
const PLUGIN_ADAPTERS = new Map<string, { manifest: PluginManifest; adapter: any }>();

/**
 * Barrits trait for the server-side plugin marketplace. Provides `marketplace_routes` (the
 * `/zen/plugins/*` HTTP API used by `zen plugin`: browse the catalog, install, enable, disable,
 * reconfigure and uninstall) and `pluginRegistry`, where plugins register their adapters at
 * startup. Installations are persisted through the `db` capability.
 */
export const PluginMarketplaceTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithPluginMarketplace",
  provides: ["marketplace_routes", "pluginRegistry"],
  consumes: ["db"],
  state: [],
  runtimes: ["deno"],

  summary:
    "Plugin Marketplace: discover, install, enable/disable plugins. Adapter pattern — plugins register their own Trait. CLI `zen plugin` commands use this API.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    // Bootstrap: cargar plugins instalados de la DB
    (async () => {
      try {
        const list = await db.find("_InstalledPlugin", {});
        for (const p of list) INSTALLED.set(p.pluginId, p);
      } catch { /* tabla vacía en primer boot */ }
    })();

    const api = {
      // ── Catálogo (puede expandirse conectando a un registry remoto) ───────

      async listCatalog(q: Record<string, any>) {
        // En producción: fetch desde https://registry.zuccadev.com/plugins
        // Por ahora retorna plugins instalados + builtin
        const builtin: PluginManifest[] = [
          {
            id: "@zenith/crm-core",
            name: "CRM Core",
            version: "1.0.0",
            description: "Contacts, Leads, Deals, Pipeline.",
            author: "Zenith",
            tags: ["crm"],
            category: "crm",
            pricing: "free",
            entryPoint: "traits/crm/crm.trait.ts",
            provides: ["crm_routes"],
            requires: ["db", "cloud"],
            license: "MIT",
          },
          {
            id: "@zenith/erp-core",
            name: "ERP Core",
            version: "1.0.0",
            description: "Products, Orders, Invoices, Employees.",
            author: "Zenith",
            tags: ["erp"],
            category: "erp",
            pricing: "free",
            entryPoint: "traits/erp/erp.trait.ts",
            provides: ["erp_routes"],
            requires: ["db", "cloud"],
            license: "MIT",
          },
          {
            id: "@zenith/blog-forum",
            name: "Blog & Forum",
            version: "1.0.0",
            description: "Monetizable blog + community forum.",
            author: "Zenith",
            tags: ["content", "forum"],
            category: "other",
            pricing: "free",
            entryPoint: "traits/blogforum/blogforum.trait.ts",
            provides: ["blogforum_routes"],
            requires: ["db"],
            license: "MIT",
          },
          {
            id: "@zenith/adk-agents",
            name: "AI Agents (ADK)",
            version: "1.0.0",
            description: "CRM, Marketing, Support AI agents.",
            author: "Zenith",
            tags: ["ai", "agents"],
            category: "ai",
            pricing: "free",
            entryPoint: "traits/agents/adk.agents.trait.ts",
            provides: ["adk_routes"],
            requires: ["ai", "db"],
            license: "MIT",
          },
          {
            id: "@zenith/email-sync",
            name: "Email Sync",
            version: "0.9.0",
            description: "Sync IMAP/SMTP emails to CRM records.",
            author: "Zenith",
            tags: ["email"],
            category: "integration",
            pricing: "freemium",
            entryPoint: "traits/integrations/email.trait.ts",
            provides: ["email_routes"],
            requires: ["db", "events"],
            license: "Apache-2.0",
          },
          {
            id: "@zenith/slack-notify",
            name: "Slack Notifications",
            version: "1.0.0",
            description: "Send CRM events to Slack channels.",
            author: "Zenith",
            tags: ["slack", "notify"],
            category: "integration",
            pricing: "free",
            entryPoint: "traits/integrations/slack.trait.ts",
            provides: ["slack_notify"],
            requires: ["events"],
            license: "MIT",
          },
          {
            id: "@zenith/stripe-billing",
            "name": "Stripe Billing",
            version: "1.0.0",
            description: "Invoice payments via Stripe.",
            author: "Zenith",
            tags: ["billing", "stripe"],
            category: "integration",
            pricing: "free",
            entryPoint: "traits/billing/billing.trait.ts",
            provides: ["billing_routes"],
            requires: ["db", "events"],
            license: "MIT",
          },
        ];

        let results: any[] = builtin;
        if (q.category) results = results.filter((p) => p.category === q.category);
        if (q.pricing) results = results.filter((p) => p.pricing === q.pricing);
        if (q.q) {
          results = results.filter((p) =>
            `${p.name} ${p.description} ${p.tags.join(" ")}`.toLowerCase().includes(
              q.q.toLowerCase(),
            )
          );
        }

        const { limit, skip } = parsePage(q);
        return { results: results.slice(skip, skip + limit), total: results.length };
      },

      // ── Plugins instalados ────────────────────────────────────────────────

      listInstalled: () => ({ results: Array.from(INSTALLED.values()) }),

      async getInstalled(pluginId: string) {
        const p = INSTALLED.get(pluginId);
        if (!p) throw ZenithErrors.notFound("InstalledPlugin", pluginId);
        return p;
      },

      async install(pluginId: string, config: Record<string, any> = {}) {
        if (INSTALLED.has(pluginId)) {
          throw ZenithErrors.validationFailed(`Plugin '${pluginId}' ya está instalado.`);
        }
        const record: InstalledPlugin = {
          objectId: crypto.randomUUID(),
          pluginId,
          version: config.version ?? "latest",
          status: "active",
          config,
          installedAt: now(),
          updatedAt: now(),
        };
        await db.create("_InstalledPlugin", record);
        INSTALLED.set(pluginId, record);
        return record;
      },

      async enable(pluginId: string) {
        const p = INSTALLED.get(pluginId);
        if (!p) throw ZenithErrors.notFound("InstalledPlugin", pluginId);
        const updated = { ...p, status: "active" as const, updatedAt: now() };
        await db.update("_InstalledPlugin", { objectId: p.objectId }, updated);
        INSTALLED.set(pluginId, updated);
        return updated;
      },

      async disable(pluginId: string) {
        const p = INSTALLED.get(pluginId);
        if (!p) throw ZenithErrors.notFound("InstalledPlugin", pluginId);
        const updated = { ...p, status: "disabled" as const, updatedAt: now() };
        await db.update("_InstalledPlugin", { objectId: p.objectId }, updated);
        INSTALLED.set(pluginId, updated);
        return updated;
      },

      async uninstall(pluginId: string) {
        const p = INSTALLED.get(pluginId);
        if (!p) throw ZenithErrors.notFound("InstalledPlugin", pluginId);
        await db.delete("_InstalledPlugin", { objectId: p.objectId });
        INSTALLED.delete(pluginId);
        return { success: true };
      },

      async updateConfig(pluginId: string, config: Record<string, any>) {
        const p = INSTALLED.get(pluginId);
        if (!p) throw ZenithErrors.notFound("InstalledPlugin", pluginId);
        const updated = { ...p, config: { ...p.config, ...config }, updatedAt: now() };
        await db.update("_InstalledPlugin", { objectId: p.objectId }, updated);
        INSTALLED.set(pluginId, updated);
        return updated;
      },

      // ── Adapter Pattern ────────────────────────────────────────────────────

      /** Los plugins llaman esto al arrancar para registrar su adaptador */
      registerPlugin: (manifest: PluginManifest, adapter: any) => {
        PLUGIN_ADAPTERS.set(manifest.id, { manifest, adapter });
        return { registered: true, pluginId: manifest.id };
      },

      getAdapter: (pluginId: string) => PLUGIN_ADAPTERS.get(pluginId),

      listAdapters: () => Array.from(PLUGIN_ADAPTERS.values()).map(({ manifest }) => manifest),
    };

    const marketplace_routes = [
      // Catálogo
      {
        method: "GET" as const,
        path: "/zen/plugins/catalog",
        _openapi: { summary: "Explorar catálogo de plugins", tags: ["Plugins"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            return jsonRes(await api.listCatalog(queryParams(new URL(req.url))));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Instalados
      {
        method: "GET" as const,
        path: "/zen/plugins/installed",
        _openapi: { summary: "Listar plugins instalados", tags: ["Plugins"] },
        handler: (_req: Request, _ctx: any) => jsonRes(api.listInstalled()),
      },
      {
        method: "GET" as const,
        path: "/zen/plugins/installed/:pluginId",
        _openapi: { summary: "Obtener estado de un plugin instalado", tags: ["Plugins"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/plugins/installed/:pluginId", req.url)!;
            return jsonRes(await api.getInstalled(decodeURIComponent(p.pluginId)));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/plugins/install",
        _openapi: { summary: "Instalar plugin (CLI: zen plugin install)", tags: ["Plugins"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const b = await req.json();
            return jsonRes(await api.install(b.pluginId, b.config), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/plugins/installed/:pluginId/enable",
        _openapi: { summary: "Activar plugin desactivado", tags: ["Plugins"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/plugins/installed/:pluginId/enable", req.url)!;
            return jsonRes(await api.enable(decodeURIComponent(p.pluginId)));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/plugins/installed/:pluginId/disable",
        _openapi: { summary: "Desactivar plugin", tags: ["Plugins"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/plugins/installed/:pluginId/disable", req.url)!;
            return jsonRes(await api.disable(decodeURIComponent(p.pluginId)));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "PUT" as const,
        path: "/zen/plugins/installed/:pluginId/config",
        _openapi: { summary: "Actualizar configuración de un plugin instalado", tags: ["Plugins"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/plugins/installed/:pluginId/config", req.url)!;
            return jsonRes(
              await api.updateConfig(decodeURIComponent(p.pluginId), await req.json()),
            );
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "DELETE" as const,
        path: "/zen/plugins/installed/:pluginId",
        _openapi: { summary: "Desinstalar plugin", tags: ["Plugins"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/plugins/installed/:pluginId", req.url)!;
            await api.uninstall(decodeURIComponent(p.pluginId));
            return NO_CONTENT;
          } catch (e) {
            return errRes(e);
          }
        },
      },
    ];

    return { marketplace_routes, pluginRegistry: api };
  },
});
