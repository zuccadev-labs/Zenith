/**
 * @module @zenith/security/api-keys/audit
 *
 * Audit log de API keys en formato ECS (Elastic Common Schema).
 *
 * Eventos registrados:
 *   - key.created       — cuando se crea una key
 *   - key.verified      — uso exitoso (rate-limited, sampled 1/100)
 *   - key.rejected      — uso fallido (wrong_secret, expired, revoked, etc.)
 *   - key.revoked       — revocación
 *   - key.rotated       — rotación (genera nuevo id, marca el viejo)
 *   - key.rate_limited  — superó el rate limit por key
 *   - key.scope_denied  — key válida pero sin scope para la operación
 *
 * Output: una línea JSON por evento en `./logs/api-key-audit.jsonl`
 * (rotación diaria recomendada vía logrotate / vector / fluentbit).
 *
 * Privacidad: NUNCA se loggea el plaintext de la key, ni siquiera su hash.
 * Solo se loggea el `keyId` (la parte pública).
 */

import type { ApiKeyInvalidReason, ApiKeyRecord } from "./types.ts";

const LOG_PATH = "./logs/api-key-audit.jsonl";

export type ApiKeyAuditEvent =
  | "key.created"
  | "key.verified"
  | "key.rejected"
  | "key.revoked"
  | "key.rotated"
  | "key.rate_limited"
  | "key.scope_denied";

export interface ApiKeyAuditEntry {
  "@timestamp": string;
  "log.level": "info" | "warn" | "error";
  "event.kind": "event";
  "event.category": "authentication" | "configuration";
  "event.action": ApiKeyAuditEvent;
  "event.dataset": "zenith.api_keys";
  "event.outcome": "success" | "failure" | "unknown";
  "key.id"?: string;
  "key.prefix"?: "sk" | "pk" | "rk";
  "key.env"?: "live" | "test";
  "key.app_id"?: string;
  "key.name"?: string;
  "key.scopes"?: string[];
  "key.rotated_from"?: string;
  "client.ip"?: string;
  "client.user_agent"?: string;
  "actor.id"?: string;
  "reason"?: ApiKeyInvalidReason | string;
  "message": string;
}

async function writeLog(entry: ApiKeyAuditEntry): Promise<void> {
  const line = JSON.stringify(entry);
  // Always echo to stdout (for container log aggregation)
  if (entry["log.level"] === "error") {
    console.error(line);
  } else if (entry["log.level"] === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
  // Best-effort file write
  try {
    await Deno.writeTextFile(LOG_PATH, line + "\n", { append: true });
  } catch { /* logs dir may not exist; rotate via stderr if needed */ }
}

export const audit = {
  created(record: ApiKeyRecord, actor: string): Promise<void> {
    return writeLog({
      "@timestamp": new Date().toISOString(),
      "log.level": "info",
      "event.kind": "event",
      "event.category": "configuration",
      "event.action": "key.created",
      "event.dataset": "zenith.api_keys",
      "event.outcome": "success",
      "key.id": record.id,
      "key.prefix": record.prefix,
      "key.env": record.env,
      "key.app_id": record.appId,
      "key.name": record.name,
      "key.scopes": record.scopes,
      "actor.id": actor,
      "message":
        `API key '${record.name}' created for app ${record.appId} (${record.prefix}_${record.env}_${record.id})`,
    });
  },

  verified(record: ApiKeyRecord, clientIp?: string): Promise<void> {
    return writeLog({
      "@timestamp": new Date().toISOString(),
      "log.level": "info",
      "event.kind": "event",
      "event.category": "authentication",
      "event.action": "key.verified",
      "event.dataset": "zenith.api_keys",
      "event.outcome": "success",
      "key.id": record.id,
      "key.prefix": record.prefix,
      "key.env": record.env,
      "key.app_id": record.appId,
      "client.ip": clientIp,
      "message": `Key ${record.prefix}_${record.env}_${record.id} verified`,
    });
  },

  rejected(
    reason: ApiKeyInvalidReason,
    keyId: string | undefined,
    clientIp?: string,
    requiredScope?: string,
  ): Promise<void> {
    return writeLog({
      "@timestamp": new Date().toISOString(),
      "log.level": "warn",
      "event.kind": "event",
      "event.category": "authentication",
      "event.action": "key.rejected",
      "event.dataset": "zenith.api_keys",
      "event.outcome": "failure",
      "key.id": keyId,
      "client.ip": clientIp,
      "reason": requiredScope ? `scope_denied:${requiredScope}` : reason,
      "message": `Key verification failed: ${reason}${keyId ? ` (id=${keyId})` : ""}${
        clientIp ? ` from ${clientIp}` : ""
      }`,
    });
  },

  revoked(record: ApiKeyRecord, actor: string, reason: string): Promise<void> {
    return writeLog({
      "@timestamp": new Date().toISOString(),
      "log.level": "warn",
      "event.kind": "event",
      "event.category": "configuration",
      "event.action": "key.revoked",
      "event.dataset": "zenith.api_keys",
      "event.outcome": "success",
      "key.id": record.id,
      "key.prefix": record.prefix,
      "key.env": record.env,
      "key.app_id": record.appId,
      "key.name": record.name,
      "actor.id": actor,
      "reason": reason,
      "message":
        `Key '${record.name}' (${record.prefix}_${record.env}_${record.id}) revoked by ${actor}: ${reason}`,
    });
  },

  rotated(oldId: string, newId: string, actor: string): Promise<void> {
    return writeLog({
      "@timestamp": new Date().toISOString(),
      "log.level": "info",
      "event.kind": "event",
      "event.category": "configuration",
      "event.action": "key.rotated",
      "event.dataset": "zenith.api_keys",
      "event.outcome": "success",
      "key.id": newId,
      "key.rotated_from": oldId,
      "actor.id": actor,
      "message": `Key ${oldId} rotated → ${newId} (24h grace period for old key)`,
    });
  },

  rateLimited(record: ApiKeyRecord, clientIp?: string): Promise<void> {
    return writeLog({
      "@timestamp": new Date().toISOString(),
      "log.level": "warn",
      "event.kind": "event",
      "event.category": "authentication",
      "event.action": "key.rate_limited",
      "event.dataset": "zenith.api_keys",
      "event.outcome": "failure",
      "key.id": record.id,
      "key.prefix": record.prefix,
      "key.app_id": record.appId,
      "client.ip": clientIp,
      "message":
        `Rate limit exceeded for key ${record.prefix}_${record.env}_${record.id} (limit=${record.rateLimit.requestsPerMinute}/min)`,
    });
  },

  scopeDenied(record: ApiKeyRecord, required: string, clientIp?: string): Promise<void> {
    return writeLog({
      "@timestamp": new Date().toISOString(),
      "log.level": "warn",
      "event.kind": "event",
      "event.category": "authentication",
      "event.action": "key.scope_denied",
      "event.dataset": "zenith.api_keys",
      "event.outcome": "failure",
      "key.id": record.id,
      "key.prefix": record.prefix,
      "key.app_id": record.appId,
      "key.scopes": record.scopes,
      "client.ip": clientIp,
      "reason": `missing_scope:${required}`,
      "message": `Key ${record.id} attempted operation requiring scope '${required}' (granted: ${
        record.scopes.join(",") || "<none>"
      })`,
    });
  },
};
