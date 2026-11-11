/**
 * @module @zenith/core/feature-catalog
 *
 * Qué funcionalidades forman un motor Zenith y cómo se activan. Cada funcionalidad es una pieza: uno o
 * más traits de barrits que se componen juntos, con un id estable, un grupo y una regla de activación.
 * `selectFeatures` decide qué piezas entran en la composición a partir de `zen.config.ts`.
 *
 * - **`required`:** núcleo del motor (base de datos, usuarios, ACL, CRUD…). No se puede desactivar.
 * - **Opcionales:** se activan o desactivan con `features.<clave>` (`true`/`false`). Sin la clave,
 *   rige `default`.
 * - **`when`:** condición de despliegue (`topology`, base de datos). Si no se cumple, la pieza no entra
 *   aunque esté activada.
 * - **`requires`:** otras piezas de las que depende. Activar una pieza sin sus dependencias es un error
 *   de configuración, que se detecta al arrancar y no en mitad de una petición.
 *
 * Las piezas cargadas se pueden apagar y encender en caliente con `runtime-features.ts`.
 */
import type { ZenithConfig } from "./types.ts";

export type FeatureGroup =
  | "core"
  | "data"
  | "security"
  | "transport"
  | "integrations"
  | "business"
  | "collaboration"
  | "ai"
  | "platform";

export interface FeatureEntry {
  /** Id estable: `features.<id>` y `/zen/features/<id>`. */
  readonly id: string;
  readonly group: FeatureGroup;
  readonly summary: string;
  /** Traits que forman la pieza, en orden de arranque. */
  readonly traits: readonly unknown[] | ((config: ZenithConfig) => readonly unknown[]);
  /** Núcleo del motor: siempre activo. */
  readonly required?: boolean;
  /** Clave de `features` que la activa, si no es `id` (varias piezas pueden compartirla). */
  readonly feature?: string;
  /** Estado sin `features.<clave>`. Obligatorio salvo en el núcleo. */
  readonly default?: boolean;
  readonly when?: (config: ZenithConfig, topology: readonly string[]) => boolean;
  /** Ids de las piezas de las que depende. */
  readonly requires?: readonly string[];
}

/** Topología por defecto cuando `zen.config.ts` no la declara. */
export const DEFAULT_TOPOLOGY: readonly string[] = ["http", "runner", "ai", "graphql", "zeromq"];

export class FeatureConfigError extends Error {
  override name = "FeatureConfigError";
}

const featureKey = (e: FeatureEntry) => e.feature ?? e.id;

/** Si la configuración pide la pieza (sin mirar `when`). */
function requested(entry: FeatureEntry, config: ZenithConfig): boolean {
  if (entry.required) return true;
  const value = (config.features as Record<string, unknown> | undefined)?.[featureKey(entry)];
  return value === undefined ? entry.default === true : value === true;
}

/** Comprueba que el catálogo es coherente: ids únicos, dependencias que existen, defaults declarados. */
export function validateCatalog(catalog: readonly FeatureEntry[]): void {
  const ids = new Set<string>();
  for (const e of catalog) {
    if (ids.has(e.id)) throw new FeatureConfigError(`Feature catalog: duplicated id "${e.id}".`);
    ids.add(e.id);
    if (!e.required && typeof e.default !== "boolean") throw new FeatureConfigError(`Feature catalog: "${e.id}" needs a default.`);
  }
  for (const e of catalog) {
    for (const r of e.requires ?? []) {
      if (!ids.has(r)) throw new FeatureConfigError(`Feature catalog: "${e.id}" requires unknown feature "${r}".`);
    }
  }
}

/**
 * Las piezas activas para `config`, en el orden del catálogo. Falla con `FeatureConfigError` si se
 * intenta desactivar el núcleo o si una pieza activa depende de otra que no lo está. Las claves de
 * `features` que no corresponden a ninguna pieza se avisan con `warn` (suelen ser erratas).
 */
export function selectFeatures(
  catalog: readonly FeatureEntry[],
  config: ZenithConfig,
  warn: (message: string) => void = console.warn,
): FeatureEntry[] {
  const topology = config.topology ?? DEFAULT_TOPOLOGY;
  const features = (config.features ?? {}) as Record<string, unknown>;
  const known = new Set(catalog.map(featureKey));
  for (const [key, value] of Object.entries(features)) {
    if (typeof value === "boolean" && !known.has(key)) warn(`[features] "${key}" is not a Zenith feature; ignored.`);
  }
  for (const e of catalog) {
    if (e.required && features[featureKey(e)] === false) {
      throw new FeatureConfigError(`Feature "${e.id}" is part of the engine core and cannot be disabled.`);
    }
  }
  const active = catalog.filter((e) => requested(e, config) && (e.when?.(config, topology) ?? true));
  const activeIds = new Set(active.map((e) => e.id));
  for (const e of active) {
    const missing = (e.requires ?? []).filter((r) => !activeIds.has(r));
    if (missing.length) {
      throw new FeatureConfigError(`Feature "${e.id}" requires ${missing.map((m) => `"${m}"`).join(", ")}, which is disabled.`);
    }
  }
  return active;
}

/** Los traits de las piezas, aplanados en orden de arranque. */
export function traitsOf(entries: readonly FeatureEntry[], config: ZenithConfig): unknown[] {
  return entries.flatMap((e) => [...(typeof e.traits === "function" ? e.traits(config) : e.traits)]);
}
