/**
 * @module @zenith/security/api-keys/manager
 *
 * Generación, hash (Argon2id) y verificación de API keys.
 *
 * Hash: Argon2id con parámetros OWASP 2026:
 *   - memoryCost: 64 MiB (m=65536)
 *   - timeCost:   3 iterations (t=3)
 *   - parallelism: 4 lanes (p=4)
 *   - hashLength: 32 bytes
 *   - saltLength: 16 bytes (generado por crypto.getRandomValues)
 *
 * Formato del hash: PHC string
 *   $argon2id$v=19$m=65536,t=3,p=4$<base64-salt>$<base64-hash>
 *
 * Verificación: comparación en tiempo constante (Argon2.verify ya es
 * timing-safe por construcción).
 */

import { checkKeyPolicy, ipAllowed, isUnrestricted } from "./policy.ts";
import { randomString } from "../../core/crypto.ts";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { DEFAULT_RATE_LIMITS } from "./scopes.ts";
import type {
  ApiKeyCreateOptions,
  ApiKeyCreateResult,
  ApiKeyEnv,
  ApiKeyPrefix,
  ApiKeyRecord,
  ApiKeyVerification,
} from "./types.ts";

// @node-rs/argon2 expone `Algorithm` como const enum, pero Deno con
// isolatedModules no permite acceder a const enums de dependencias npm.
// Usamos el valor numérico directamente: 2 = Argon2id (RFC 9106).
const ARGON2ID = 2;

const ARGON2_OPTS = {
  algorithm: ARGON2ID as 0 | 1 | 2,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  saltLength: 16,
} as const;

// ─── Random generation ────────────────────────────────────────────────────────

/** Id público: 8 caracteres sin ambiguos (sin 0/O/1/l/I). */
const PUBLIC_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Secreto: 32 caracteres alfanuméricos (~190 bits). */
const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const generatePublicId = (): string => randomString(8, PUBLIC_ID_ALPHABET);
// Uniforme (core/crypto.ts): con `byte % 62`, 8 de los 62 caracteres salían un 25 % más.
const generateSecret = (): string => randomString(32, SECRET_ALPHABET);

/**
 * Parsea una duración estilo Stripe: "30d", "24h", "1y", "90m" → Date futuro.
 * Si es ISO 8601, lo devuelve tal cual. Si es null/undefined, null.
 */
export function parseExpiresIn(value: string | undefined | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value; // ISO 8601 ya

  const match = value.match(/^(\d+)([smhdwMy])$/);
  if (!match) {
    throw new Error(
      `[api-keys] Invalid expiresIn: "${value}". Use ISO 8601 or shorthand like "30d", "24h", "1y".`,
    );
  }
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === "s"
    ? n * 1000
    : unit === "m"
    ? n * 60 * 1000
    : unit === "h"
    ? n * 60 * 60 * 1000
    : unit === "d"
    ? n * 24 * 60 * 60 * 1000
    : unit === "w"
    ? n * 7 * 24 * 60 * 60 * 1000
    : unit === "M"
    ? n * 30 * 24 * 60 * 60 * 1000 // mes ≈ 30 días
    : unit === "y"
    ? n * 365 * 24 * 60 * 60 * 1000
    : 0;
  return new Date(Date.now() + ms).toISOString();
}

// ─── Key format ───────────────────────────────────────────────────────────────

/**
 * Construye la key completa a partir de sus partes.
 */
export function buildKey(prefix: ApiKeyPrefix, env: ApiKeyEnv, id: string, secret: string): string {
  return `${prefix}_${env}_${id}_${secret}`;
}

/**
 * Parsea una key completa. Retorna null si el formato es inválido.
 */
export function parseKey(plaintext: string): {
  prefix: ApiKeyPrefix;
  env: ApiKeyEnv;
  id: string;
  secret: string;
} | null {
  // sk_live_aB3xY9zK_qR7vN2pT8mE4wK6hJ1cV0sZ9bF2dL5gX8n
  // ^^^^^^^^ ^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // prefix   env    <id>_<secret>   (id=8, secret=32, separados por _)
  const m = plaintext.match(/^(sk|pk|rk)_(live|test)_([A-Za-z0-9]{8})_([A-Za-z0-9]{32})$/);
  if (!m) return null;
  return {
    prefix: m[1] as ApiKeyPrefix,
    env: m[2] as ApiKeyEnv,
    id: m[3],
    secret: m[4],
  };
}

// ─── Hash + verify ───────────────────────────────────────────────────────────

/**
 * Hashea un secreto con Argon2id. Retorna el PHC string.
 */
export async function hashSecret(secret: string): Promise<string> {
  return await argon2Hash(secret, ARGON2_OPTS);
}

/**
 * Verifica un secreto contra un PHC string.
 * Argon2.verify es timing-safe por construcción.
 */
export async function verifySecret(secret: string, phc: string): Promise<boolean> {
  try {
    return await argon2Verify(phc, secret);
  } catch {
    return false;
  }
}

// ─── Manager class ───────────────────────────────────────────────────────────

export interface ApiKeyStore {
  /** Recupera un registro por id. */
  get(id: string): Promise<ApiKeyRecord | null>;
  /** Lista todas las keys de una app (sin el hash). */
  listByApp(appId: string): Promise<Omit<ApiKeyRecord, "hash">[]>;
  /** Persiste un registro nuevo. */
  put(record: ApiKeyRecord): Promise<void>;
  /** Actualiza un registro (para lastUsedAt, revocación, etc.). */
  update(id: string, patch: Partial<ApiKeyRecord>): Promise<void>;
  /** Elimina un registro (solo para revocación definitiva; preferir update con revokedAt). */
  delete(id: string): Promise<void>;
}

/**
 * Manager de API keys: orquesta generación, hash, persistencia y verificación.
 */
export class ApiKeyManager {
  constructor(private readonly store: ApiKeyStore) {}

  /**
   * Crea una key nueva. Retorna el plaintext UNA SOLA VEZ; el caller debe
   * mostrárselo al operador y no loggearlo.
   */
  async create(opts: ApiKeyCreateOptions): Promise<ApiKeyCreateResult> {
    const expiresAt = parseExpiresIn(opts.expiresIn) ?? undefined;
    // Before any secret exists: a key that breaks the policy is never created.
    const allowedIps = checkKeyPolicy({
      prefix: opts.prefix,
      scopes: opts.scopes,
      allowedIps: opts.allowedIps,
      expiresAt,
    });
    const id = generatePublicId();
    const secret = generateSecret();
    const plaintext = buildKey(opts.prefix, opts.env, id, secret);
    const hash = await hashSecret(secret);

    const record: ApiKeyRecord = {
      id,
      prefix: opts.prefix,
      env: opts.env,
      appId: opts.appId,
      hash,
      scopes: opts.scopes,
      name: opts.name,
      createdAt: new Date().toISOString(),
      createdBy: opts.createdBy,
      expiresAt,
      ...(allowedIps.length ? { allowedIps } : {}),
      rateLimit: {
        requestsPerMinute: opts.requestsPerMinute ?? DEFAULT_RATE_LIMITS[opts.prefix],
      },
      metadata: opts.metadata ?? {},
    };

    await this.store.put(record);

    // No incluir el hash en el resultado público
    const { hash: _h, ...recordWithoutHash } = record;
    return { record: recordWithoutHash, plaintext, hash };
  }

  /**
   * Verifica una key en texto claro. Retorna el registro o el motivo de rechazo.
   */
  async verify(plaintext: string, clientIp?: string): Promise<ApiKeyVerification> {
    const parsed = parseKey(plaintext);
    if (!parsed) return { valid: false, reason: "malformed" };

    const record = await this.store.get(parsed.id);
    if (!record) return { valid: false, reason: "not_found", keyId: parsed.id };

    const secretOk = await verifySecret(parsed.secret, record.hash);
    if (!secretOk) return { valid: false, reason: "wrong_secret", keyId: parsed.id };

    if (record.revokedAt) {
      // Si la key fue rotada, el periodo de gracia permite el uso temporal
      if (record.rotationExpiresAt && new Date(record.rotationExpiresAt) > new Date()) {
        return { valid: true, key: record };
      }
      return { valid: false, reason: "revoked", keyId: parsed.id };
    }

    if (record.expiresAt && new Date(record.expiresAt) <= new Date()) {
      return { valid: false, reason: "expired", keyId: parsed.id };
    }

    if (record.rotationExpiresAt && new Date(record.rotationExpiresAt) <= new Date()) {
      return { valid: false, reason: "rotated_grace_over", keyId: parsed.id };
    }

    // Access policy (policy.ts): checked last, so a wrong secret never reveals the policy.
    if (record.allowedIps?.length) {
      if (!ipAllowed(clientIp, record.allowedIps)) {
        return { valid: false, reason: "ip_not_allowed", keyId: parsed.id };
      }
    } else if (isUnrestricted(record.scopes)) {
      return { valid: false, reason: "policy_missing", keyId: parsed.id };
    }

    // Update lastUsedAt (fire and forget — no bloqueamos la auth)
    this.store.update(parsed.id, { lastUsedAt: new Date().toISOString() }).catch(() => {});

    return { valid: true, key: record };
  }

  /**
   * Revoca una key inmediatamente.
   */
  async revoke(id: string, revokedBy: string, reason: string): Promise<void> {
    await this.store.update(id, {
      revokedAt: new Date().toISOString(),
      revokedBy,
      revokedReason: reason,
    });
  }

  /**
   * Rota una key: crea una nueva que hereda los scopes de la anterior, y
   * marca la anterior para expirar en `gracePeriodMs` (default 24h).
   */
  async rotate(oldId: string, opts: {
    createdBy: string;
    gracePeriodMs?: number;
  }): Promise<ApiKeyCreateResult> {
    const old = await this.store.get(oldId);
    if (!old) throw new Error(`[api-keys] Key ${oldId} not found for rotation`);
    if (old.revokedAt) throw new Error(`[api-keys] Key ${oldId} is already revoked`);

    // The new key keeps the old one's policy and lifetime: rotating must never widen a key
    // (before, a key that expired rotated into one that never did).
    const lifetimeMs = old.expiresAt
      ? new Date(old.expiresAt).getTime() - new Date(old.createdAt).getTime()
      : undefined;
    const newKey = await this.create({
      appId: old.appId,
      prefix: old.prefix,
      env: old.env,
      scopes: old.scopes,
      name: `${old.name} (rotated)`,
      createdBy: opts.createdBy,
      requestsPerMinute: old.rateLimit.requestsPerMinute,
      ...(lifetimeMs !== undefined
        ? { expiresIn: new Date(Date.now() + Math.max(lifetimeMs, 60_000)).toISOString() }
        : {}),
      ...(old.allowedIps?.length ? { allowedIps: old.allowedIps } : {}),
      metadata: { ...old.metadata, rotatedFrom: oldId },
    });

    const grace = opts.gracePeriodMs ?? 24 * 60 * 60 * 1000; // 24h
    await this.store.update(oldId, {
      rotatedFrom: newKey.record.id,
      rotationExpiresAt: new Date(Date.now() + grace).toISOString(),
    });

    return newKey;
  }

  /**
   * Lista todas las keys de una app (sin el hash).
   */
  async listByApp(appId: string): Promise<Omit<ApiKeyRecord, "hash">[]> {
    return await this.store.listByApp(appId);
  }
}
