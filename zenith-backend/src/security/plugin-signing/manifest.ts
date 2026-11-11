/**
 * Build, sign y parseo de PluginManifest.
 *
 * El manifest se firma sobre la representación canónica (JCS) del
 * campo `plugin` (NO del manifest completo — el signature field está
 * excluido del digest). Esto evita la recursión obvia.
 *
 * Formato en disco:
 * ```json
 * {
 *   "manifestVersion": "1.0",
 *   "plugin": { "name": "...", "version": "...", "sha256": "...", ... },
 *   "signature": { "alg": "Ed25519", "keyId": "...", "value": "base64", "signedAt": "ISO" }
 * }
 * ```
 */

import {
  MANIFEST_VERSION,
  type PluginArtifact,
  type PluginAuthor,
  type PluginPermission,
  type PluginSignature,
  type SignedPluginManifest,
} from "./types.ts";
import { canonicalJson } from "./canonical.ts";
import {
  buildKeyId,
  importPrivateRaw,
  importPublicRaw,
  sign as edSign,
  verify as edVerify,
} from "./keys.ts";

/** Opciones para `buildPluginArtifact`. */
export interface BuildArtifactOptions {
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
  readonly size: number;
  readonly permissions: readonly PluginPermission[];
  readonly author: PluginAuthor;
}

/** Construye un PluginArtifact validado. */
export function buildPluginArtifact(
  opts: BuildArtifactOptions,
): PluginArtifact {
  if (!/^[a-zA-Z0-9._-]+$/.test(opts.name)) {
    throw new Error(`Invalid plugin name: ${opts.name}`);
  }
  if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(opts.version)) {
    throw new Error(`Invalid semver version: ${opts.version}`);
  }
  if (!/^[a-f0-9]{64}$/.test(opts.sha256)) {
    throw new Error(`Invalid SHA-256 (must be 64 hex chars): ${opts.sha256}`);
  }
  if (opts.size < 0 || !Number.isInteger(opts.size)) {
    throw new Error(`Invalid size: ${opts.size}`);
  }
  if (!/^[a-z0-9-]+$/.test(opts.author.id)) {
    throw new Error(
      `Invalid author.id (lowercase alphanumeric + hyphens): ${opts.author.id}`,
    );
  }
  return Object.freeze({
    name: opts.name,
    version: opts.version,
    sha256: opts.sha256,
    size: opts.size,
    permissions: Object.freeze([...opts.permissions]) as readonly PluginPermission[],
    author: Object.freeze({ ...opts.author }),
  });
}

/** Hashea contenido de un plugin. */
export async function sha256OfFile(path: string): Promise<{ sha256: string; size: number }> {
  const content = await Deno.readFile(path);
  // Usamos node:crypto porque está garantizado; deno std también serviría
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { sha256, size: content.byteLength };
}

/** Opciones para `signPlugin`. */
export interface SignOptions {
  readonly artifact: PluginArtifact;
  readonly privateKeyB64: string;
  readonly authorId: string;
  /** Override del keyId (default: derivado de la clave). */
  readonly keyId?: string;
}

/** Firma un PluginArtifact. Devuelve el SignedPluginManifest completo. */
export async function signPlugin(
  opts: SignOptions,
): Promise<SignedPluginManifest> {
  const keyId = opts.keyId ?? buildKeyId(opts.authorId, /* pub */ "");
  // El keyId debe matchear el del author en el artifact
  if (keyId !== opts.artifact.author.keyId) {
    throw new Error(
      `keyId mismatch: artifact.author.keyId=${opts.artifact.author.keyId} but signing with keyId=${keyId}`,
    );
  }

  const privKey = await importPrivateRaw(opts.privateKeyB64);
  const canonical = canonicalJson(opts.artifact);
  const signatureBytes = await edSign(privKey, new TextEncoder().encode(canonical));

  const signature: PluginSignature = {
    alg: "Ed25519",
    keyId,
    value: signatureBytes,
    signedAt: new Date().toISOString(),
  };

  return {
    manifestVersion: MANIFEST_VERSION,
    plugin: opts.artifact,
    signature,
  };
}

/** Opciones para `verifyPluginSignature` (low-level, sin trust check). */
export interface VerifySignatureOptions {
  readonly manifest: SignedPluginManifest;
  readonly publicKeyB64: string;
}

/**
 * Verifica SOLO la firma criptográfica (no la cadena de confianza).
 * Retorna `true` si la firma es válida, `false` si no.
 * Lanza si la clave es inválida.
 */
export async function verifyPluginSignature(
  opts: VerifySignatureOptions,
): Promise<boolean> {
  const pubKey = await importPublicRaw(opts.publicKeyB64);
  const canonical = canonicalJson(opts.manifest.plugin);
  const sigBytes = opts.manifest.signature.value;

  // Validar base64 rápido
  if (sigBytes.length !== 88) {
    // 64 bytes base64 = 88 chars
    return false;
  }

  return await edVerify(
    pubKey,
    new TextEncoder().encode(canonical),
    sigBytes,
  );
}

/** Parsea un manifest desde JSON string. Lanza si no cumple el schema. */
export function parseManifest(raw: string): SignedPluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Manifest JSON parse error: ${(e as Error).message}`);
  }
  return validateManifest(parsed);
}

/** Valida estructura de un manifest (no la firma). */
export function validateManifest(value: unknown): SignedPluginManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Manifest must be an object");
  }
  const v = value as Record<string, unknown>;

  if (v.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(
      `Unsupported manifestVersion: ${v.manifestVersion} (expected ${MANIFEST_VERSION})`,
    );
  }
  if (!v.plugin || typeof v.plugin !== "object") {
    throw new Error("Manifest missing 'plugin' field");
  }
  if (!v.signature || typeof v.signature !== "object") {
    throw new Error("Manifest missing 'signature' field");
  }

  const p = v.plugin as Record<string, unknown>;
  const s = v.signature as Record<string, unknown>;

  if (typeof p.name !== "string") throw new Error("plugin.name must be string");
  if (typeof p.version !== "string") throw new Error("plugin.version must be string");
  if (typeof p.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.sha256 as string)) {
    throw new Error("plugin.sha256 must be 64 hex chars");
  }
  if (typeof p.size !== "number" || !Number.isInteger(p.size)) {
    throw new Error("plugin.size must be integer");
  }
  if (!Array.isArray(p.permissions)) {
    throw new Error("plugin.permissions must be array");
  }
  for (const perm of p.permissions) {
    if (typeof perm !== "string") {
      throw new Error("plugin.permissions entries must be strings");
    }
  }
  if (!p.author || typeof p.author !== "object") {
    throw new Error("plugin.author must be object");
  }
  const a = p.author as Record<string, unknown>;
  if (typeof a.id !== "string" || !/^[a-z0-9-]+$/.test(a.id)) {
    throw new Error("plugin.author.id invalid");
  }
  if (typeof a.keyId !== "string") {
    throw new Error("plugin.author.keyId must be string");
  }

  if (s.alg !== "Ed25519") {
    throw new Error(`Unsupported signature alg: ${s.alg}`);
  }
  if (typeof s.keyId !== "string") {
    throw new Error("signature.keyId must be string");
  }
  if (typeof s.value !== "string") {
    throw new Error("signature.value must be string");
  }
  if (typeof s.signedAt !== "string") {
    throw new Error("signature.signedAt must be ISO string");
  }

  if (s.keyId !== a.keyId) {
    throw new Error(
      `signature.keyId (${s.keyId}) must match plugin.author.keyId (${a.keyId})`,
    );
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    plugin: {
      name: p.name as string,
      version: p.version as string,
      sha256: p.sha256 as string,
      size: p.size as number,
      permissions: Object.freeze([...(p.permissions as readonly PluginPermission[])]),
      author: {
        id: a.id as string,
        keyId: a.keyId as string,
        ...(typeof a.contact === "string" ? { contact: a.contact } : {}),
      },
    },
    signature: {
      alg: "Ed25519",
      keyId: s.keyId as string,
      value: s.value as string,
      signedAt: s.signedAt as string,
    },
  };
}
