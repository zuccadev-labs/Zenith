/**
 * @module @zenith/security/api-keys/types
 *
 * Tipos del sistema de API Keys estilo Stripe.
 *
 * Formato de key: `<prefix>_<env>_<id>_<secret>`
 *   - prefix: sk (server), pk (publishable/client), rk (restricted)
 *   - env:    live, test
 *   - id:     8 chars alfanuméricos (público, aparece en logs)
 *   - secret: 32 chars alfanuméricos (secreto, hasheado con Argon2id)
 *
 * Ejemplo: sk_live_aB3xY9zK_qR7vN2pT8mE4wK6hJ1cV0sZ9bF2dL5gX8n
 */

export type ApiKeyPrefix = "sk" | "pk" | "rk";
export type ApiKeyEnv = "live" | "test";

/**
 * Scopes disponibles. Ver ./scopes.ts para la jerarquía completa
 * y la función `hasScope()` para verificación.
 */
export type ApiKeyScope =
  | "*"
  | "admin:*"
  | "admin:read"
  | "admin:write"
  | "data:*"
  | "data:read"
  | "data:write"
  | "data:create"
  | "data:delete"
  | "users:*"
  | "users:read"
  | "users:write"
  | "functions:*"
  | "functions:invoke"
  | "functions:deploy"
  | "files:*"
  | "files:read"
  | "files:write"
  | "files:delete"
  | "push:*"
  | "push:send"
  | "analytics:read"
  | "webhooks:*"
  | "webhooks:read"
  | "webhooks:write";

/**
 * Registro completo de una API key (lo que se guarda en la DB).
 * El secreto NUNCA se almacena en claro — solo el hash Argon2id.
 */
export interface ApiKeyRecord {
  /** Identificador público (los 8 chars del medio de la key) */
  id: string;
  /** Prefijo funcional */
  prefix: ApiKeyPrefix;
  /** Ambiente */
  env: ApiKeyEnv;
  /** Aplicación a la que pertenece */
  appId: string;
  /** Hash Argon2id en formato PHC (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`) */
  hash: string;
  /** Scopes concedidos a esta key */
  scopes: ApiKeyScope[];
  /** Etiqueta legible por humanos (ej. "Production server #1") */
  name: string;
  /** ISO 8601 */
  createdAt: string;
  /** Actor que la creó (user id, admin id, o "system:bootstrap") */
  createdBy: string;
  /** Última vez que se usó para autenticar (ISO 8601) */
  lastUsedAt?: string;
  /** ISO 8601; null = no expira */
  expiresAt?: string;
  /** Si está revocada, ISO 8601 */
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
  /** id de la key que esta reemplaza (para rotación) */
  rotatedFrom?: string;
  /** Cuándo deja de ser válida la key rotada (grace period) */
  rotationExpiresAt?: string;
  /**
   * Access policy: IPv4/IPv6 addresses or CIDR ranges the key may be used from (policy.ts, ADR-015).
   * Absent or empty = any address, except for unrestricted keys (scope `*`), which require it.
   */
  allowedIps?: string[];
  /** Rate limit por key (además del global) */
  rateLimit: {
    /** requests por minuto; null = sin límite específico */
    requestsPerMinute: number;
  };
  /** Metadata libre (IP de origen esperada, descripción, etc.) */
  metadata: Record<string, unknown>;
}

/**
 * Resultado de verificar una key. NUNCA contiene el secreto.
 */
export type ApiKeyVerification =
  | { valid: true; key: ApiKeyRecord }
  | { valid: false; reason: ApiKeyInvalidReason; keyId?: string };

export type ApiKeyInvalidReason =
  | "malformed" // formato incorrecto
  | "not_found" // id no existe
  | "wrong_secret" // id existe pero el secret no coincide
  | "revoked" // key revocada
  | "expired" // expirada
  | "rotated_grace_over" // periodo de gracia de rotación terminado
  | "ip_not_allowed" // la IP del cliente está fuera de la política de la key
  | "policy_missing"; // key con scope * sin lista de IP (dato antiguo): se rechaza

/**
 * Resultado de generar una key nueva. El `plaintext` solo se devuelve UNA VEZ.
 */
export interface ApiKeyCreateResult {
  /** El registro persistido (sin el plaintext) */
  record: Omit<ApiKeyRecord, "hash">;
  /** La key completa en claro. MOSTRAR UNA SOLA VEZ al operador. */
  plaintext: string;
  /** El hash Argon2id (para persistir) */
  hash: string;
}

/**
 * Opciones al crear una key.
 */
export interface ApiKeyCreateOptions {
  appId: string;
  prefix: ApiKeyPrefix;
  env: ApiKeyEnv;
  scopes: ApiKeyScope[];
  name: string;
  createdBy: string;
  /** ISO 8601 o duración relativa ("90d", "1y"). null = no expira. */
  expiresIn?: string;
  /** Rate limit requests/min. Default: sk=1000, pk=∞, rk=60 */
  requestsPerMinute?: number;
  /** Access policy (policy.ts). Required, with an expiry, for scope `*`. */
  allowedIps?: string[];
  metadata?: Record<string, unknown>;
}
