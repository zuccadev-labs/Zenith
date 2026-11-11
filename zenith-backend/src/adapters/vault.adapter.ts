import { ZenLogger, ZenPlugins } from "../core/cloud.ts";
import { VaultClient, type VaultConfig } from "../security/secrets/vault-client.ts";

/**
 * HashiCorp Vault Adapter (HTTP API).
 *
 * Expone la capacidad de leer/escribir secrets en Vault a través del
 * HTTP API (no del CLI), con auto-configuración desde env vars.
 *
 * ## Activación
 *
 * El adapter se activa automáticamente si `VAULT_ADDR` está configurado:
 *
 * ```bash
 * export VAULT_ADDR=https://vault.example.com:8200
 * export VAULT_TOKEN=hvs.xxxxx    # o usar AppRole/Kubernetes auth
 * ```
 *
 * Si Vault no está disponible, el adapter queda inactivo y los callers
 * deben tener un fallback (ej. leer JWT keys de MongoDB).
 *
 * ## Uso en Cloud Code
 *
 * ```ts
 * // Auth con AppRole (recomendado para máquinas)
 * await Zen.Plugins.Vault.loginAppRole(roleId, secretId);
 *
 * // Leer un secret
 * const jwtKeys = await Zen.Plugins.Vault.kvGet("zenith/jwt-keys");
 *
 * // Escribir
 * await Zen.Plugins.Vault.kvPut("zenith/api-keys/sk_live_xxx", {
 *   hash: "...",
 *   scopes: ["*"],
 * });
 *
 * // Emitir cert mTLS
 * const cert = await Zen.Plugins.Vault.pkiIssue("internal", "zenith.example.com");
 * ```
 */

const VAULT_ADDR = Deno.env.get("VAULT_ADDR");
const VAULT_TOKEN = Deno.env.get("VAULT_TOKEN");
const VAULT_NAMESPACE = Deno.env.get("VAULT_NAMESPACE");

let _client: VaultClient | null = null;

if (VAULT_ADDR) {
  const cfg: VaultConfig = {
    address: VAULT_ADDR,
    token: VAULT_TOKEN,
    namespace: VAULT_NAMESPACE,
    logger: {
      info: (msg, meta) => ZenLogger.info(msg, meta),
      warn: (msg, meta) => ZenLogger.warn(msg, meta),
      error: (msg, meta) => ZenLogger.error(msg, meta),
      debug: () => {},
    },
  };
  _client = new VaultClient(cfg);
  ZenLogger.info(`[Plugin:Vault] Activated against ${VAULT_ADDR} (HTTP API)`);
} else {
  ZenLogger.debug?.(
    `[Plugin:Vault] Inactive (VAULT_ADDR not set). Use legacy CLI methods if needed.`,
  );
}

/**
 * Plugin API. Solo los métodos están expuestos al usuario final.
 * La instancia `VaultClient` es interna (lazy).
 */
function getClient(): VaultClient {
  if (!_client) {
    throw new Error("[Plugin:Vault] Not active. Set VAULT_ADDR environment variable.");
  }
  return _client;
}

ZenPlugins.Vault = {
  /**
   * Verifica si Vault está activo (VAULT_ADDR configurado).
   */
  isActive: (): boolean => _client !== null,

  /**
   * Acceso al cliente HTTP para usos avanzados. Lanza si no está activo.
   */
  client: (): VaultClient => getClient(),

  // ── Auth (proxy al VaultClient) ─────────────────────────────────────────

  loginAppRole: async (roleId: string, secretId: string, mountPath?: string) => {
    return await getClient().loginAppRole(roleId, secretId, mountPath);
  },

  loginKubernetes: async (role: string, jwtPath?: string, mountPath?: string) => {
    return await getClient().loginKubernetes(role, jwtPath, mountPath);
  },

  loginUserpass: async (username: string, password: string, mountPath?: string) => {
    return await getClient().loginUserpass(username, password, mountPath);
  },

  // ── KV v2 (proxy) ───────────────────────────────────────────────────────

  kvGet: async (path: string, version?: number) => {
    return await getClient().kvGet(path, version);
  },

  kvPut: async (path: string, data: Record<string, unknown>) => {
    return await getClient().kvPut(path, data);
  },

  kvList: async (path: string) => {
    return await getClient().kvList(path);
  },

  kvDelete: async (path: string, versions?: number[]) => {
    return await getClient().kvDelete(path, versions);
  },

  // ── PKI (proxy) ─────────────────────────────────────────────────────────

  pkiIssue: async (
    role: string,
    commonName: string,
    opts?: { altNames?: string[]; ipSans?: string[]; ttl?: string },
  ) => {
    return await getClient().pkiIssue(role, commonName, opts);
  },

  // ── Transit (proxy) ─────────────────────────────────────────────────────

  transitEncrypt: async (keyName: string, plaintext: string) => {
    return await getClient().transitEncrypt(keyName, plaintext);
  },

  transitDecrypt: async (keyName: string, ciphertext: string) => {
    return await getClient().transitDecrypt(keyName, ciphertext);
  },

  /**
   * Legacy: authenticate via CLI (kept for backward compat).
   * NOT recommended — use `loginAppRole` instead.
   */
  authenticate: async (username: string, password: string): Promise<string> => {
    ZenLogger.warn(
      "[Plugin:Vault] Legacy CLI authenticate() called. Prefer loginUserpass() over HTTP API.",
    );
    // Lazy import to avoid loading ZenShell in Vault-only deployments.
    const { ZenShell } = await import("../core/cloud.ts");
    const result = await ZenShell.exec("vault", [
      "login",
      "-method=userpass",
      `username=${username}`,
      `password=${password}`,
    ]);
    return result.stdout;
  },

  /**
   * Legacy: read via CLI (kept for backward compat).
   */
  readSecret: async (path: string): Promise<Record<string, any>> => {
    ZenLogger.warn("[Plugin:Vault] Legacy CLI readSecret() called. Prefer kvGet() over HTTP API.");
    const { ZenShell } = await import("../core/cloud.ts");
    const result = await ZenShell.exec("vault", ["kv", "get", "-format=json", path]);
    return JSON.parse(result.stdout);
  },
};
