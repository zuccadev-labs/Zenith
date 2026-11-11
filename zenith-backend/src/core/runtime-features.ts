/**
 * @module @zenith/core/runtime-features
 *
 * Encender y apagar en caliente las piezas cargadas (`feature-catalog.ts`), sin reiniciar.
 *
 * - **Qué apaga:** las rutas HTTP de la pieza responden 404, como si no se hubiera cargado. Los traits
 *   que trabajan en segundo plano (webhooks, automatizaciones…) consultan `isEnabled(id)` con
 *   `uses:runtime-features`.
 * - **Qué no hace:** cargar código que no arrancó. Para eso está `features.<id>` en `zen.config.ts` y
 *   un reinicio. Tampoco se apaga el núcleo.
 * - **Persistencia:** si hay `db`, el estado se guarda en `_ZenithFeature` y las demás instancias lo
 *   recogen en `refreshMs` (30 s por defecto). Sin `db`, vive en el proceso.
 * - **API (solo master key):** `GET /zen/features` y `PUT /zen/features/:id` con `{ "enabled": bool }`.
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { FeatureEntry, FeatureGroup } from "./feature-catalog.ts";
import type { ZenithConfig } from "./types.ts";
import { ZenithError, ZenithErrorCode, ZenithErrors } from "./errors.ts";

/** Clase interna donde se guarda el estado (solo master key, como `_Hooks` en Parse). */
export const FEATURE_STATE_CLASS = "_ZenithFeature";
export const RUNTIME_FEATURES_CAPABILITY = "runtime-features";

export interface FeatureStatus {
  readonly id: string;
  readonly group: FeatureGroup;
  readonly summary: string;
  readonly required: boolean;
  readonly enabled: boolean;
}

interface FeatureStore {
  load(): Promise<Record<string, boolean>>;
  save(id: string, enabled: boolean, actor: string): Promise<void>;
}

export class RuntimeFeatures {
  readonly #entries = new Map<string, FeatureEntry>();
  readonly #byCapability = new Map<string, string>();
  readonly #off = new Set<string>();
  #store: FeatureStore | null = null;
  #refreshMs = 30_000;
  #started: Promise<void> | null = null;

  constructor(entries: readonly FeatureEntry[], config: ZenithConfig) {
    for (const e of entries) {
      this.#entries.set(e.id, e);
      const traits = typeof e.traits === "function" ? e.traits(config) : e.traits;
      for (const t of traits) {
        for (const cap of (t as { provides?: readonly string[] }).provides ?? []) this.#byCapability.set(cap, e.id);
      }
    }
  }

  /** Pieza dueña de una capacidad (las rutas se agrupan por capacidad). */
  featureOf(capability: string): string | undefined {
    return this.#byCapability.get(capability);
  }

  /** Si la pieza está cargada y encendida. Una pieza que no arrancó nunca está encendida. */
  isEnabled(id: string): boolean {
    return this.#entries.has(id) && !this.#off.has(id);
  }

  list(): FeatureStatus[] {
    return [...this.#entries.values()].map((e) => ({
      id: e.id,
      group: e.group,
      summary: e.summary,
      required: e.required === true,
      enabled: this.isEnabled(e.id),
    }));
  }

  /** Enciende o apaga una pieza cargada. Falla con el núcleo, con una pieza no cargada o con dependientes encendidos. */
  async set(id: string, enabled: boolean, actor = "master"): Promise<FeatureStatus> {
    const e = this.#entries.get(id);
    if (!e) throw ZenithErrors.notFound("Feature", id);
    if (e.required) throw new ZenithError(ZenithErrorCode.OPERATION_FORBIDDEN, `Feature "${id}" is part of the engine core.`, 403);
    if (!enabled) {
      const dependents = [...this.#entries.values()].filter((x) => x.requires?.includes(id) && this.isEnabled(x.id)).map((x) => x.id);
      if (dependents.length) {
        throw new ZenithError(ZenithErrorCode.OPERATION_FORBIDDEN, `Feature "${id}" is required by ${dependents.join(", ")}: turn those off first.`, 409);
      }
    } else {
      const missing = (e.requires ?? []).filter((r) => !this.isEnabled(r));
      if (missing.length) {
        throw new ZenithError(ZenithErrorCode.OPERATION_FORBIDDEN, `Feature "${id}" requires ${missing.join(", ")}.`, 409);
      }
    }
    this.#apply(id, enabled);
    await this.#store?.save(id, enabled, actor);
    return this.list().find((s) => s.id === id)!;
  }

  /** Almacén del estado. No lee nada hasta `start()`, así que componer sin servidor no toca la base. */
  useStore(store: FeatureStore, refreshMs = 30_000): void {
    this.#store = store;
    this.#refreshMs = refreshMs;
  }

  /**
   * Aplica el estado guardado y lo vuelve a leer cada `refreshMs`. Lo llama el router al montarse
   * (`buildDynamicRouter`); las llamadas siguientes devuelven la misma carga.
   */
  start(warn: (m: string) => void = console.warn): Promise<void> {
    if (!this.#store) return Promise.resolve();
    if (!this.#started) {
      const timer = setInterval(() => this.refresh().catch(() => {}), this.#refreshMs);
      Deno.unrefTimer(timer);
      this.#started = this.refresh().catch((e) => warn(`[features] Could not load the saved feature state: ${(e as Error).message}`));
    }
    return this.#started;
  }

  /** Vuelve a leer el estado guardado (otras instancias pueden haberlo cambiado). */
  async refresh(): Promise<void> {
    if (!this.#store) return;
    const saved = await this.#store.load();
    for (const [id, enabled] of Object.entries(saved)) {
      const e = this.#entries.get(id);
      if (e && !e.required) this.#apply(id, enabled);
    }
  }

  #apply(id: string, enabled: boolean) {
    if (enabled) this.#off.delete(id);
    else this.#off.add(id);
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Almacén sobre la capa `db` común (`db.trait.ts`). */
function dbStore(db: any): FeatureStore {
  return {
    load: async () => {
      const rows = await db.find(FEATURE_STATE_CLASS, {});
      return Object.fromEntries((rows ?? []).map((r: any) => [r.featureId, r.enabled === true]));
    },
    save: async (id, enabled, actor) => {
      await db.upsert(FEATURE_STATE_CLASS, { featureId: id }, { featureId: id, enabled, changedBy: actor });
    },
  };
}

/**
 * El trait de núcleo que publica el registro como capacidad `runtime-features` y sirve `/zen/features`.
 * Lo añade `selectTraits` con las piezas seleccionadas.
 */
export function runtimeFeaturesTrait(entries: readonly FeatureEntry[], config: ZenithConfig, options: { refreshMs?: number } = {}) {
  return createTraitDescriptor({
    name: "ZenithRuntimeFeatures",
    provides: [RUNTIME_FEATURES_CAPABILITY, "feature_routes"],
    consumes: [],
    tags: ["uses:db"],
    state: [],
    runtimes: ["deno"],
    summary: "Turns loaded features on and off at runtime (/zen/features, master key only).",
    create: (deps: Record<string, any>) => {
      const registry = new RuntimeFeatures(entries, config);
      const db = deps.traits?.["db"];
      if (db?.find && db?.upsert) registry.useStore(dbStore(db), options.refreshMs);
      const feature_routes = [
        {
          method: "GET" as const,
          path: "/zen/features",
          access: "master" as const,
          _openapi: { tag: "Features", summary: "Loaded features and whether each one is on" },
          handler: async () => json({ results: registry.list() }),
        },
        {
          method: "PUT" as const,
          path: "/zen/features/:id",
          access: "master" as const,
          _openapi: {
            tag: "Features",
            summary: "Turn a loaded feature on or off without restarting. Its routes answer 404 while it is off",
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
          },
          handler: async (req: Request, ctx: any) => {
            let body: any;
            try {
              body = await req.json();
            } catch {
              body = null;
            }
            if (typeof body?.enabled !== "boolean") throw new ZenithError(ZenithErrorCode.INVALID_JSON, "Body: { \"enabled\": true | false }.", 400);
            return json(await registry.set(String(ctx.params?.id ?? ""), body.enabled, "master"));
          },
        },
      ];
      return { [RUNTIME_FEATURES_CAPABILITY]: registry, feature_routes };
    },
  });
}
