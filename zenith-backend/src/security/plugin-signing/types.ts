/**
 * Tipos del sistema de firma de plugins.
 *
 * El modelo sigue una cadena de confianza similar a la de npm/GitHub:
 *
 *   Author (Ed25519 keypair)
 *     └─> firma PluginManifest
 *            └─> backend verifica con TrustStore (TOFU)
 *
 * Ver ADR-004-plugin-signing.md para el threat model completo.
 */

/** Versión del formato de manifest. Incrementar si cambia la estructura. */
export const MANIFEST_VERSION = "1.0" as const;

/** Algoritmo de firma soportado. Ed25519 (RFC 8032). */
export type SignatureAlgorithm = "Ed25519";

/** Permisos que un plugin puede solicitar. Mismo set que API key scopes. */
export type PluginPermission =
  | "data:read"
  | "data:write"
  | "users:read"
  | "users:write"
  | "files:read"
  | "files:write"
  | "functions:invoke"
  | "analytics:read"
  | "webhooks:read"
  | "webhooks:write";

/** Información del autor del plugin. */
export interface PluginAuthor {
  /** ID único y estable (ej. "acme-corp"). Lowercase, alphanumeric + hyphens. */
  readonly id: string;
  /** Identificador de la clave pública dentro del keyring del autor. */
  readonly keyId: string;
  /** Email de contacto (opcional, no validado criptográficamente). */
  readonly contact?: string;
}

/** El cuerpo del plugin dentro del manifest (lo que se firma). */
export interface PluginArtifact {
  /** Nombre del archivo del plugin (ej. "crm.plugin.ts"). */
  readonly name: string;
  /** Versión semver del plugin. */
  readonly version: string;
  /** SHA-256 del contenido del archivo, en hex. */
  readonly sha256: string;
  /** Tamaño en bytes del archivo. */
  readonly size: number;
  /** Permisos requeridos. El backend rechaza el plugin si el scope de la API key no los cubre. */
  readonly permissions: readonly PluginPermission[];
  /** Información del autor. */
  readonly author: PluginAuthor;
}

/** Firma criptográfica. */
export interface PluginSignature {
  /** Algoritmo usado. */
  readonly alg: SignatureAlgorithm;
  /** ID de la clave que firmó. Debe matchear `PluginAuthor.keyId`. */
  readonly keyId: string;
  /** Firma en base64 (64 bytes para Ed25519 → 88 chars base64). */
  readonly value: string;
  /** Timestamp ISO-8601 de cuándo se firmó. No se usa para validar (sin clock skew), solo para auditoría. */
  readonly signedAt: string;
}

/**
 * Manifest firmado completo.
 *
 * Estructura en disco (`<plugin-file>.manifest.json`):
 * ```json
 * {
 *   "manifestVersion": "1.0",
 *   "plugin": { ... },
 *   "signature": { ... }
 * }
 * ```
 */
export interface SignedPluginManifest {
  /** Manifest format version; always {@link MANIFEST_VERSION}. */
  readonly manifestVersion: typeof MANIFEST_VERSION;
  /** The signed artifact: its canonical JSON is exactly what `signature` covers. */
  readonly plugin: PluginArtifact;
  /** Ed25519 signature of the canonical JSON of `plugin`. */
  readonly signature: PluginSignature;
}

/** Entrada en el trust store. */
export interface TrustedAuthorKey {
  /** Key ID. Formato: `<author-id>-ed25519-<fingerprint-short>`. */
  readonly keyId: string;
  /** Clave pública Ed25519 en base64 (32 bytes raw → 44 chars base64). */
  readonly publicKey: string;
  /** Algoritmo. Por ahora solo Ed25519. */
  readonly alg: SignatureAlgorithm;
  /** ISO-8601 timestamp de cuándo se agregó al trust store. */
  readonly addedAt: string;
  /** Quién lo agregó: "user" (manual), "root" (firmado por root), "tofu" (auto-aprobado). */
  readonly addedBy: "user" | "root" | "tofu";
  /** Etiqueta humana para identificar la clave (ej. "acme-corp prod key 2024"). */
  readonly label?: string;
  /** Si está revocada. Una clave revocada sigue contando para validar firmas previas (auditoría) pero no para nuevas. */
  readonly revokedAt?: string;
  /** Razón de la revocación. */
  readonly revokedReason?: string;
}

/** Trust store completo. */
export interface TrustStore {
  /** Trust store file format version. */
  readonly version: "1.0";
  /** Author keys trusted to sign plugins, including revoked ones kept for auditing. */
  readonly keys: TrustedAuthorKey[];
}

/** Resultado de una verificación. */
export type VerificationResult =
  | { readonly ok: true; readonly keyId: string; readonly author: string }
  | {
    readonly ok: false;
    readonly reason: VerificationFailure;
    readonly detail?: string;
  };

/** Razones de fallo. Cada una tiene un código que se puede loggear / alertar. */
export type VerificationFailure =
  | "manifest_version_unsupported"
  | "manifest_malformed"
  | "signature_alg_unsupported"
  | "signature_missing"
  | "signature_value_malformed"
  | "signature_invalid"
  | "keyid_mismatch"
  | "key_not_trusted"
  | "key_revoked"
  | "plugin_name_mismatch"
  | "plugin_sha256_mismatch"
  | "plugin_size_mismatch";

/** Opciones del verifier. */
export interface VerifyOptions {
  /** Path del archivo del plugin. Se re-hashea para validar sha256. */
  readonly pluginPath: string;
  /** Manifest firmado (parsed). */
  readonly manifest: SignedPluginManifest;
  /** Trust store. */
  readonly trust: TrustStore;
  /** Si true, una key revocada todavía verifica (modo auditoría). Default false. */
  readonly allowRevoked?: boolean;
}
