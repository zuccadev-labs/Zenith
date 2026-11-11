/**
 * @module @zenith/security/api-keys/bootstrap
 *
 * Bootstrap de API keys al primer arranque.
 *
 * Comportamiento:
 *   - Dev: si no hay keys para la app, crea una `sk_live` con todos los scopes
 *     y la imprime en stdout con un banner loud (incluye "SAVE THIS NOW").
 *   - Prod: si no hay keys, NO crea nada — fuerza al operador a correr
 *     `zenith api-keys create` explícitamente. Solo loggea una advertencia.
 *
 * La key bootstrap se persiste (su HASH, no el plaintext) en el store, igual
 * que cualquier otra. El plaintext solo se muestra una vez en stdout.
 *
 * Detección de "primer arranque": si la app no tiene NINGUNA key activa
 * (no revocada, no expirada) en el store.
 */

import type { ApiKeyManager } from "./manager.ts";
// deno-lint-ignore no-unused-vars
import type { DEFAULT_SCOPES } from "./scopes.ts";
import { audit } from "./audit.ts";

export interface BootstrapOptions {
  appId: string;
  appName?: string;
  /** Si true, fuerza la creación aunque ya haya keys (idempotente, evita duplicados) */
  force?: boolean;
  /** Si true, también crea en producción (default: false) */
  allowInProduction?: boolean;
}

export interface BootstrapResult {
  /** Si se creó una key nueva */
  created: boolean;
  /** El plaintext SOLO si se creó. NUNCA persistir este valor. */
  plaintext?: string;
  /** El id de la key creada (o de la primera key activa existente) */
  keyId: string;
  /** Mensaje para mostrar al operador */
  message: string;
}

const isProduction = (): boolean => {
  return Deno.args.includes("--mode=production") ||
    Deno.env.get("ZENITH_MODE") === "production";
};

const BANNER_TOP = `
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   🔐  ZENITH BOOTSTRAP API KEY GENERATED                         ║
║                                                                  ║`;

const BANNER_BOTTOM = `║                                                                  ║
║   ⚠️  This is the ONLY time the secret will be displayed.         ║
║   📋  Store it in your secret manager NOW.                       ║
║   🔄  Rotate it after the first 24h of use.                      ║
║   🚫  Never commit it to git. Never log it.                      ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
`;

/**
 * Asegura que la app tenga al menos una key activa. Si no la tiene, crea
 * una `sk_live` bootstrap y la imprime en stdout (solo en dev).
 */
export async function bootstrapApiKey(
  manager: ApiKeyManager,
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  // 1. Buscar si ya hay keys activas
  const existing = await manager.listByApp(opts.appId);
  const active = existing.find((k) =>
    !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt) > new Date())
  );
  if (active && !opts.force) {
    return {
      created: false,
      keyId: active.id,
      message:
        `App '${opts.appId}' already has an active key (id=${active.id}). Use --force to create a new one.`,
    };
  }

  // 2. En producción, NO creamos automáticamente
  if (isProduction() && !opts.allowInProduction) {
    const msg =
      `App '${opts.appId}' has no API keys. In production, keys must be created explicitly via 'zenith api-keys create'.`;
    console.warn(`[Zenith Bootstrap] ⚠️  ${msg}`);
    return {
      created: false,
      keyId: "",
      message: msg,
    };
  }

  // 3. Crear la key bootstrap
  const result = await manager.create({
    appId: opts.appId,
    prefix: "sk",
    env: "live",
    scopes: ["*"], // super admin — solo para bootstrap
    name: `${opts.appName ?? opts.appId} - bootstrap (created on first boot)`,
    createdBy: "system:bootstrap",
    expiresIn: "24h", // corta por seguridad — el operador debe rotarla
    // Printed to stdout, so it may end up in logs: usable only from this machine, like the master key.
    allowedIps: ["127.0.0.1", "::1"],
    metadata: {
      bootstrap: true,
      createdAt: new Date().toISOString(),
      warning: "Replace this key after initial setup",
    },
  });

  await audit.created(
    { ...result.record, hash: result.hash } as any,
    "system:bootstrap",
  );

  // 4. Imprimir banner loud
  console.log(BANNER_TOP);
  console.log(`║   App:        ${opts.appId.padEnd(50)} ║`);
  console.log(`║   Key ID:     ${result.record.id.padEnd(50)} ║`);
  console.log(`║   Scopes:     * (super admin — rotate after setup)         ║`);
  console.log(`║   Expires:    ${(result.record.expiresAt ?? "never").padEnd(50)} ║`);
  console.log(`║                                                                 ║`);
  console.log(`║   🔑  KEY:  ${result.plaintext.slice(0, 50)} ║`);
  if (result.plaintext.length > 50) {
    console.log(`║         ${result.plaintext.slice(50).padEnd(50)} ║`);
  }
  console.log(BANNER_BOTTOM);

  return {
    created: true,
    plaintext: result.plaintext,
    keyId: result.record.id,
    message: `Bootstrap key created for app '${opts.appId}' (id=${result.record.id})`,
  };
}

/**
 * Wrapper que garantiza que la app tenga una key. Si no la tiene, falla loud
 * en producción con instrucciones claras para el operador.
 */
export async function ensureApiKeyOrFail(
  manager: ApiKeyManager,
  appId: string,
): Promise<{ keyId: string; plaintext?: string }> {
  const result = await bootstrapApiKey(manager, { appId });
  if (result.created) {
    return { keyId: result.keyId, plaintext: result.plaintext };
  }
  if (result.keyId) {
    return { keyId: result.keyId };
  }
  throw new Error(
    `[Zenith FATAL] No API key available for app '${appId}'. ` +
      `In production, create one explicitly:\n` +
      `  zenith api-keys create --app ${appId} --prefix sk --env live --scopes "*" --name "Production admin"`,
  );
}
