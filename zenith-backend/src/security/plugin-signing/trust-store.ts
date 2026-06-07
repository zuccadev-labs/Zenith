/**
 * TrustStore: registro local de claves de autor confiables.
 *
 * Persistencia:
 *   1. `~/.zenith/trusted-keys.json` (user-global)
 *   2. `<project>/.zenith/trusted-keys.json` (project-local override)
 *
 * El project-local pisa al user-global en caso de conflicto.
 *
 * Política TOFU (Trust On First Use):
 *   - Si un manifest trae un keyId desconocido, NO se rechaza de inmediato
 *     en modo dev. Se loggea WARN y se permite al operador aprobarlo con
 *     `zenith plugin trust <keyId> <publicKey>`.
 *   - En modo producción, se rechaza (fail-closed).
 *
 * Razones para esta política:
 *   - Evita fricción en desarrollo sin sacrificar seguridad en prod
 *   - Un atacante en dev no es tan catastrófico como en prod
 *   - El operador ve el log WARN y decide
 */

import { canonicalJson } from "./canonical.ts";
import type { TrustedAuthorKey, TrustStore } from "./types.ts";

/** Path del trust store global del usuario. */
export function globalTrustPath(): string {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "/tmp";
  return `${home}/.zenith/trusted-keys.json`;
}

/** Path del trust store del proyecto (override). */
export function projectTrustPath(projectRoot: string = Deno.cwd()): string {
  return `${projectRoot}/.zenith/trusted-keys.json`;
}

/** Crea un trust store vacío. */
export function emptyTrustStore(): TrustStore {
  return { version: "1.0", keys: [] };
}

/** Carga trust store desde un path. Si no existe, retorna vacío. */
export async function loadTrustStore(path: string): Promise<TrustStore> {
  try {
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content);
    return validateTrustStore(parsed);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return emptyTrustStore();
    }
    throw new Error(`Failed to load trust store at ${path}: ${(e as Error).message}`);
  }
}

/** Carga trust store merge: global + project (project wins). */
export async function loadMergedTrustStore(
  projectRoot: string = Deno.cwd(),
): Promise<TrustStore> {
  const globalStore = await loadTrustStore(globalTrustPath());
  const projectStore = await loadTrustStore(projectTrustPath(projectRoot));

  // Merge: project pisa a global si tienen el mismo keyId
  const merged = new Map<string, TrustedAuthorKey>();
  for (const k of globalStore.keys) merged.set(k.keyId, k);
  for (const k of projectStore.keys) merged.set(k.keyId, k);

  return {
    version: "1.0",
    keys: [...merged.values()].sort((a, b) => a.keyId.localeCompare(b.keyId)),
  };
}

/** Persiste trust store. Crea el directorio si no existe. */
export async function saveTrustStore(
  path: string,
  store: TrustStore,
): Promise<void> {
  // Encontrar el último separador (Windows usa \, Unix usa /)
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = lastSep >= 0 ? path.substring(0, lastSep) : "";
  if (dir) {
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    }
  }
  // Canonical JSON para que diffs en git sean estables
  const content = canonicalJson(store) + "\n";
  await Deno.writeTextFile(path, content);
}

/** Busca una key en el trust store. */
export function findKey(
  store: TrustStore,
  keyId: string,
): TrustedAuthorKey | undefined {
  return store.keys.find((k) => k.keyId === keyId);
}

/** Busca keys por author ID. */
export function findKeysByAuthor(
  store: TrustStore,
  authorId: string,
): TrustedAuthorKey[] {
  return store.keys.filter((k) => k.keyId.startsWith(`${authorId}-`));
}

/** Agrega una key al trust store. Lanza si ya existe. */
export function addKey(
  store: TrustStore,
  key: TrustedAuthorKey,
): TrustStore {
  if (findKey(store, key.keyId)) {
    throw new Error(`Key already trusted: ${key.keyId}`);
  }
  return {
    version: "1.0",
    keys: [...store.keys, key].sort((a, b) => a.keyId.localeCompare(b.keyId)),
  };
}

/** Revoca una key. Retorna nuevo store. */
export function revokeKey(
  store: TrustStore,
  keyId: string,
  reason: string,
): TrustStore {
  const updated = store.keys.map((k) => {
    if (k.keyId !== keyId) return k;
    return {
      ...k,
      revokedAt: new Date().toISOString(),
      revokedReason: reason,
    };
  });
  return { version: "1.0", keys: updated };
}

/** Quita una key del trust store. Retorna nuevo store. */
export function removeKey(
  store: TrustStore,
  keyId: string,
): TrustStore {
  return {
    version: "1.0",
    keys: store.keys.filter((k) => k.keyId !== keyId),
  };
}

/** Valida estructura de un trust store. */
export function validateTrustStore(value: unknown): TrustStore {
  if (!value || typeof value !== "object") {
    throw new Error("Trust store must be an object");
  }
  const v = value as Record<string, unknown>;
  if (v.version !== "1.0") {
    throw new Error(`Unsupported trust store version: ${v.version}`);
  }
  if (!Array.isArray(v.keys)) {
    throw new Error("Trust store keys must be an array");
  }
  const seen = new Set<string>();
  for (const k of v.keys) {
    if (!k || typeof k !== "object") {
      throw new Error("Each trust store key must be an object");
    }
    const key = k as Record<string, unknown>;
    if (typeof key.keyId !== "string") throw new Error("keyId must be string");
    if (seen.has(key.keyId)) {
      throw new Error(`Duplicate keyId in trust store: ${key.keyId}`);
    }
    seen.add(key.keyId);
    if (typeof key.publicKey !== "string") {
      throw new Error("publicKey must be string");
    }
    if (key.alg !== "Ed25519") {
      throw new Error(`Unsupported alg: ${key.alg}`);
    }
    if (typeof key.addedAt !== "string") {
      throw new Error("addedAt must be ISO string");
    }
    if (key.addedBy !== "user" && key.addedBy !== "root" && key.addedBy !== "tofu") {
      throw new Error("addedBy must be 'user', 'root' or 'tofu'");
    }
  }
  return value as TrustStore;
}
