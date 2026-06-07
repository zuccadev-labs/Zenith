/**
 * @module zenith/config-loader
 *
 * Cargador de configuración de aplicaciones para Zenith.
 * Resuelve las definiciones de apps (config + mount path) y aplica
 * la política de seguridad FAIL-CLOSED en producción.
 *
 * Política:
 *   - En MODO PRODUCCIÓN (`--mode=production` o `ZENITH_MODE=production`),
 *     cualquier variable de entorno requerida (masterKey, etc.) que falte
 *     ABORTA el arranque. No hay fallback.
 *   - En modo desarrollo, se permiten defaults `unsafe_default_*` SOLO
 *     con un warning explícito y registro en audit log.
 *
 * Esto previene la clase de vulnerabilidad "default credentials" donde
 * un atacante que conoce el nombre de la env var puede adivinar la clave
 * (CWE-798: Use of Hard-coded Credentials).
 */

import type { ZenithConfig } from "./src/core/types.ts";

export interface ZenithAppDefinition {
  mountPath: string;
  config: ZenithConfig;
}

const _isProductionMode = (): boolean => {
  return Deno.args.includes("--mode=production") ||
         Deno.env.get("ZENITH_MODE") === "production";
};

const _auditUnsafeDefault = (envName: string, value: string): void => {
  const ts = new Date().toISOString();
  const line = JSON.stringify({
    "@timestamp": ts,
    "log.level": "warn",
    "event.kind": "event",
    "event.category": "authentication",
    "event.action": "unsafe-default-loaded",
    "event.dataset": "zenith.config",
    "env.variable": envName,
    "security.risk": "CWE-798",
    "message": `Unsafe default loaded for ${envName}. DO NOT use in production.`,
  });
  console.warn(line);
  try {
    Deno.writeTextFileSync("./logs/security-audit.jsonl", line + "\n", { append: true });
  } catch { /* logs dir may not exist yet — best effort */ }
};

/**
 * Lee una variable de entorno con política fail-closed.
 *
 * @param name        Nombre de la variable (ej. "APP1_MASTER_KEY")
 * @param options.minLength  Longitud mínima aceptada (default: 32 para claves criptográficas)
 * @param options.allowDevDefault  Si true, permite fallback `unsafe_default_<name>` en dev
 * @returns El valor de la variable
 * @throws  En producción, si la variable falta o es demasiado corta.
 */
export function requireEnv(
  name: string,
  options: { minLength?: number; allowDevDefault?: boolean } = {},
): string {
  const { minLength = 32, allowDevDefault = !_isProductionMode() } = options;
  const value = Deno.env.get(name);

  if (!value) {
    if (allowDevDefault) {
      _auditUnsafeDefault(name, `unsafe_default_${name}`);
      return `unsafe_default_${name}`;
    }
    throw new Error(
      `[SecOps FATAL] Environment variable ${name} is missing and the server is running in PRODUCTION mode. ` +
      `Refusing to start with insecure defaults (CWE-798 prevention). ` +
      `Set ${name} in your environment or secrets manager.`,
    );
  }

  if (value.length < minLength) {
    if (allowDevDefault && value.startsWith("unsafe_default_")) {
      _auditUnsafeDefault(name, value);
      return value;
    }
    throw new Error(
      `[SecOps FATAL] Environment variable ${name} is too short (${value.length} < ${minLength}). ` +
      `Use a cryptographically random value of at least ${minLength} characters.`,
    );
  }

  return value;
}

/**
 * Resuelve el modo de operación actual.
 * Usado por el resto del runtime para ajustar comportamiento.
 */
export const RuntimeMode = {
  isProduction: _isProductionMode(),
  isDevelopment: !_isProductionMode(),
  enforceStrict: _isProductionMode(),
} as const;

/**
 * Carga las definiciones de apps desde la configuración.
 *
 * Si el archivo `apps.config.ts` no existe, devuelve un array vacío
 * (útil para microservicios que solo exponen un subconjunto de traits).
 */
export async function loadAppDefinitions(): Promise<ZenithAppDefinition[]> {
  try {
    const module = await import("./apps.config.ts");
    return (module.apps ?? []) as ZenithAppDefinition[];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log("[Zenith] No apps.config.ts found — running with no mounted apps.");
      return [];
    }
    throw err;
  }
}
