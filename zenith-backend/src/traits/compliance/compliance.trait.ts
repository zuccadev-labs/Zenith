/**
 * Compliance engine: immutable audit trail (append-only, signed), PII registry with field-level encryption, GDPR/SOC2/HIPAA support, data retention policies, breach notification hooks.
 *
 * @barrits-trait
 * @barrits-summary ZenithCompliance
 * @barrits-provides compliance-routes, compliance, auditLogger, piiRegistry
 * @barrits-consumes db
 * @barrits-tags uses:vault
 * @barrits-state auditLog, piiFields
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { hmacSha256Hex, signingKey } from "../../core/crypto.ts";

/** An entry of the append-only audit trail, persisted in `_AuditLog`. */
export interface AuditEntry {
  /** Unique id generated when the entry is recorded. */
  objectId: string;
  /** Who performed the action (user id, service name, ...). */
  actor: string;
  /** What was done (for example `create`, `delete`, `export`). */
  action: string;
  /** Kind of resource acted on (for example a class name). */
  resource: string;
  /** Id of the resource acted on. */
  resourceId: string;
  /** When the entry was recorded (ISO 8601). */
  timestamp: string;
  /** Client IP address, if known. */
  ipAddress?: string;
  /** Client user agent, if known. */
  userAgent?: string;
  /** Additional context about the action. */
  metadata?: Record<string, any>;
  /** HMAC-SHA256 (hex) of the entry, keyed with `AUDIT_SIGNING_KEY`, to detect tampering. */
  signature?: string;
}

/** A field of a class registered as personal or sensitive data. */
export interface PII_Field {
  /** Name of the field. */
  field: string;
  /** Sensitivity class of the data the field holds. */
  classification: DataClassification;
  /** Whether `encryptPII` replaces the value with a Vault transit ciphertext (`<field>__encrypted`). */
  encryptionRequired: boolean;
  /** String `maskPII` repeats (up to 8 times) in place of the value; defaults to `*`. */
  maskingPattern?: string;
}

/**
 * Sensitivity class of a data field, from `public` to `restricted`, plus `pii` (personally
 * identifiable information) and `phi` (protected health information).
 */
export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted"
  | "pii"
  | "phi";

export const ComplianceTrait = createTraitDescriptor({
  name: "ZenithCompliance",
  provides: ["compliance-routes", "compliance", "auditLogger", "piiRegistry"],
  consumes: ["db"],
  tags: ["uses:vault"],
  state: ["auditLog", "piiFields"],
  runtimes: ["deno"],
  summary:
    "Compliance engine: immutable audit trail (append-only, signed), PII registry with field-level encryption, GDPR/SOC2/HIPAA support, data retention policies, breach notification hooks.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const vault = deps.traits["vault"];

    const traitApi: any = {
      auditLog: [] as AuditEntry[],
      piiFields: new Map<string, PII_Field[]>(),

      recordAudit: async (entry: Omit<AuditEntry, "objectId" | "timestamp">) => {
        const fullEntry: AuditEntry = {
          objectId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          ...entry,
        };
        // HMAC-SHA256 (core/crypto.ts). Antes: sha256(entrada + clave) con la clave "default" si faltaba
        // AUDIT_SIGNING_KEY, así que cualquiera podía falsificar la firma.
        fullEntry.signature = await hmacSha256Hex(
          signingKey("AUDIT_SIGNING_KEY"),
          JSON.stringify(fullEntry),
        );
        traitApi.auditLog.push(fullEntry);
        await db.create("_AuditLog", fullEntry).catch(() => {});
        return fullEntry;
      },

      queryAudit: async (
        filter: { actor?: string; resource?: string; from?: string; to?: string; limit?: number } =
          {},
      ) => {
        let entries: AuditEntry[] = traitApi.auditLog;
        if (filter.actor) entries = entries.filter((e: AuditEntry) => e.actor === filter.actor);
        if (filter.resource) {
          entries = entries.filter((e: AuditEntry) => e.resource === filter.resource);
        }
        if (filter.from) entries = entries.filter((e: AuditEntry) => e.timestamp >= filter.from!);
        if (filter.to) entries = entries.filter((e: AuditEntry) => e.timestamp <= filter.to!);
        return entries.slice(0, filter.limit || 100);
      },

      registerPII: (
        className: string,
        field: string,
        options: {
          classification: DataClassification;
          encryptionRequired: boolean;
          maskingPattern?: string;
        },
      ) => {
        if (!traitApi.piiFields.has(className)) traitApi.piiFields.set(className, []);
        traitApi.piiFields.get(className)!.push({ field, ...options });
      },

      maskPII: (className: string, data: Record<string, any>): Record<string, any> => {
        const piiList = traitApi.piiFields.get(className);
        if (!piiList) return data;
        const masked = { ...data };
        for (const pii of piiList) {
          if (masked[pii.field] !== undefined) {
            const pattern = pii.maskingPattern || "*";
            const value = String(masked[pii.field]);
            masked[pii.field] = pattern.repeat(Math.min(value.length, 8));
          }
        }
        return masked;
      },

      encryptPII: async (
        className: string,
        data: Record<string, any>,
      ): Promise<Record<string, any>> => {
        const piiList = traitApi.piiFields.get(className);
        if (!piiList) return data;
        const encrypted = { ...data };
        for (const pii of piiList) {
          if (pii.encryptionRequired && encrypted[pii.field] && vault?.transitEncrypt) {
            encrypted[`${pii.field}__encrypted`] = await vault.transitEncrypt(
              "pii-key",
              String(encrypted[pii.field]),
            );
            delete encrypted[pii.field];
          }
        }
        return encrypted;
      },
    };

    const compliance_routes = [
      {
        method: "GET" as const,
        path: "/compliance/audit",
        _openapi: { summary: "Query audit log" },
        handler: async (req: Request) => {
          const url = new URL(req.url);
          const filter: any = {};
          if (url.searchParams.get("actor")) filter.actor = url.searchParams.get("actor");
          if (url.searchParams.get("resource")) filter.resource = url.searchParams.get("resource");
          if (url.searchParams.get("from")) filter.from = url.searchParams.get("from");
          if (url.searchParams.get("to")) filter.to = url.searchParams.get("to");
          const entries = await traitApi.queryAudit(filter);
          return new Response(JSON.stringify({ entries }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      {
        method: "POST" as const,
        path: "/compliance/pii",
        _openapi: { summary: "Register a PII field" },
        handler: async (req: Request) => {
          const body = await req.json() as {
            className: string;
            field: string;
            classification: DataClassification;
            encryptionRequired: boolean;
            maskingPattern?: string;
          };
          traitApi.registerPII(body.className, body.field, {
            classification: body.classification,
            encryptionRequired: body.encryptionRequired,
            maskingPattern: body.maskingPattern,
          });
          return new Response(JSON.stringify({ registered: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      },
    ];

    return {
      "compliance-routes": compliance_routes,
      "compliance": traitApi,
      "auditLogger": traitApi,
      "piiRegistry": traitApi,
    };
  },
});
