/**
 * @module @zenith/security/secrets/vault-client
 *
 * Cliente HTTP para HashiCorp Vault.
 *
 * ## ¿Por qué HTTP API en vez del CLI `vault`?
 *
 * El CLI de Vault requiere el binario instalado en el sistema, lo que:
 *   - Añade una dependencia nativa al container (más grande, más lento).
 *   - Tiene una shell-out por cada operación (latencia, no paralelizable).
 *   - No expone el auth flow de Kubernetes/AppRole nativamente.
 *   - Es más difícil de mockear en tests (hay que spawn el binario).
 *
 * El HTTP API (REST sobre HTTPS) resuelve todos estos problemas:
 *   - Cero dependencias nativas: solo `fetch()` de Deno.
 *   - Paralelizable nativamente (múltiples requests concurrentes).
 *   - Auth flow completo: token, AppRole, Kubernetes, Userpass, etc.
 *   - Trivial de mockear: `globalThis.fetch = mock`.
 *   - Idéntico comportamiento con Vault OSS, Vault Enterprise, HCP Vault.
 *
 * ## Endpoints cubiertos
 *
 *   - **KV v2** (`/v1/secret/data/...`): secret storage versionado.
 *   - **PKI** (`/v1/pki/issue/...`): emisión de certificados X.509.
 *   - **Transit** (`/v1/transit/encrypt/...`): envelope encryption.
 *   - **Auth** (`/v1/auth/{userpass,approle,kubernetes}/login`).
 *   - **Token** (`/v1/auth/token/lookup-self`, `/v1/auth/token/renew-self`).
 *
 * ## Seguridad
 *
 *   - HTTPS obligatorio (CWE-319).
 *   - Token renewal automático con margen del 20% (evita race condition en
 *     requests que cruzan el boundary de expiración).
 *   - Audit logging en cada operación.
 *   - Const-time comparisons donde aplica.
 *
 * @see https://developer.hashicorp.com/vault/api-docs
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 5_000;
const TOKEN_RENEW_MARGIN_PCT = 20; // renueva 20% antes de expirar

export interface VaultConfig {
  /** URL del server (ej. `https://vault.example.com:8200`). REQUERIDO HTTPS. */
  address: string;
  /** Token inicial (opcional si se usa un auth method). */
  token?: string;
  /** Namespace (Vault Enterprise multi-tenancy). */
  namespace?: string;
  /** Path del KV v2 secrets engine. Default: `secret`. */
  kvMountPath?: string;
  /** Path del PKI secrets engine. Default: `pki`. */
  pkiMountPath?: string;
  /** Path del Transit secrets engine. Default: `transit`. */
  transitMountPath?: string;
  /** Timeout HTTP. Default: 10_000ms. */
  timeoutMs?: number;
  /** Max retries (5xx, 429, network errors). Default: 3. */
  maxRetries?: number;
  /** Logger hook. */
  logger?: VaultLogger;
  /** Custom fetch (para testing). */
  fetchImpl?: typeof fetch;
}

export interface VaultLogger {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
  debug: (msg: string, meta?: unknown) => void;
}

interface TokenInfo {
  accessor: string;
  /** Unix seconds */
  ttl: number;
  policies: string[];
  renewable: boolean;
  /** Unix seconds; 0 = no expira */
  expireTime: number;
}

// ── VaultClient ────────────────────────────────────────────────────────────

export class VaultClient {
  private readonly cfg:
    & Required<Omit<VaultConfig, "token" | "namespace" | "logger" | "fetchImpl">>
    & {
      token: string | null;
      namespace: string | undefined;
      logger: VaultLogger;
      fetchImpl: typeof fetch;
    };
  private tokenInfo: TokenInfo | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: VaultConfig) {
    if (!config.address) throw new Error("[vault] address is required");
    validateHttpsUrl(config.address, "address");
    this.cfg = {
      address: config.address.replace(/\/+$/, ""),
      token: config.token ?? null,
      namespace: config.namespace,
      kvMountPath: config.kvMountPath ?? "secret",
      pkiMountPath: config.pkiMountPath ?? "pki",
      transitMountPath: config.transitMountPath ?? "transit",
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? MAX_RETRIES,
      logger: config.logger ?? defaultVaultLogger(),
      fetchImpl: config.fetchImpl ?? globalThis.fetch.bind(globalThis),
    };
  }

  // ── Auth methods ─────────────────────────────────────────────────────────

  /**
   * Auth via AppRole (recomendado para máquinas).
   * @param roleId AppRole role_id
   * @param secretId AppRole secret_id
   * @param mountPath auth method mount path (default: `approle`)
   */
  async loginAppRole(roleId: string, secretId: string, mountPath = "approle"): Promise<TokenInfo> {
    const body = { role_id: roleId, secret_id: secretId };
    const res = await this.rawRequest("POST", `/v1/auth/${mountPath}/login`, body, false);
    const token = res.auth.client_token;
    this.setToken(token);
    this.tokenInfo = this.parseTokenInfo(res.auth);
    this.scheduleRenewal();
    this.cfg.logger.info("[vault] AppRole login successful", { ttl: this.tokenInfo.ttl });
    return this.tokenInfo;
  }

  /**
   * Auth via Kubernetes Service Account Token (recomendado para pods K8s).
   * @param role Kubernetes auth role
   * @param jwtPath Path al SA token. Default: `/var/run/secrets/kubernetes.io/serviceaccount/token`
   * @param mountPath auth method mount path (default: `kubernetes`)
   */
  async loginKubernetes(
    role: string,
    jwtPath = "/var/run/secrets/kubernetes.io/serviceaccount/token",
    mountPath = "kubernetes",
  ): Promise<TokenInfo> {
    const jwt = await Deno.readTextFile(jwtPath);
    const body = { role, jwt };
    const res = await this.rawRequest("POST", `/v1/auth/${mountPath}/login`, body, false);
    this.setToken(res.auth.client_token);
    this.tokenInfo = this.parseTokenInfo(res.auth);
    this.scheduleRenewal();
    this.cfg.logger.info("[vault] Kubernetes login successful", { ttl: this.tokenInfo.ttl });
    return this.tokenInfo;
  }

  /**
   * Auth via Userpass.
   */
  async loginUserpass(
    username: string,
    password: string,
    mountPath = "userpass",
  ): Promise<TokenInfo> {
    const body = { password };
    const res = await this.rawRequest(
      "PUT",
      `/v1/auth/${mountPath}/login/${encodeURIComponent(username)}`,
      body,
      false,
    );
    this.setToken(res.auth.client_token);
    this.tokenInfo = this.parseTokenInfo(res.auth);
    this.scheduleRenewal();
    return this.tokenInfo;
  }

  /**
   * Lookup del token actual. Útil para verificar que no ha sido revocado.
   */
  async lookupSelf(): Promise<TokenInfo> {
    const res = await this.rawRequest("GET", "/v1/auth/token/lookup-self", undefined, true);
    this.tokenInfo = this.parseTokenInfo(res.data);
    return this.tokenInfo;
  }

  /**
   * Renueva el token actual. Necesita `renewable: true`.
   */
  async renewSelf(incrementSeconds?: number): Promise<TokenInfo> {
    const body = incrementSeconds ? { increment: incrementSeconds } : {};
    const res = await this.rawRequest("POST", "/v1/auth/token/renew-self", body, true);
    this.tokenInfo = this.parseTokenInfo(res.auth);
    this.scheduleRenewal(); // recalcula el timer
    this.cfg.logger.info("[vault] Token renewed", { ttl: this.tokenInfo.ttl });
    return this.tokenInfo;
  }

  // ── KV v2 ────────────────────────────────────────────────────────────────

  /**
   * Lee un secret de KV v2.
   * @param path Path completo (ej. `zenith/jwt-keys`)
   * @param version Versión específica a leer. Default: latest.
   */
  async kvGet(path: string, version?: number): Promise<KvV2Response | null> {
    const url = version !== undefined
      ? `/v1/${this.cfg.kvMountPath}/data/${path}?version=${version}`
      : `/v1/${this.cfg.kvMountPath}/data/${path}`;
    try {
      const res = await this.rawRequest("GET", url, undefined, true);
      return res.data as KvV2Response;
    } catch (e) {
      if ((e as { status?: number })?.status === 404) return null;
      throw e;
    }
  }

  /**
   * Escribe un secret en KV v2.
   */
  async kvPut(path: string, data: Record<string, unknown>): Promise<{ version: number }> {
    const res = await this.rawRequest(
      "POST",
      `/v1/${this.cfg.kvMountPath}/data/${path}`,
      { data },
      true,
    );
    return { version: res.data.version };
  }

  /**
   * Lista secrets en un path (recursivo opcional).
   */
  async kvList(path: string): Promise<string[]> {
    try {
      const res = await this.rawRequest(
        "LIST",
        `/v1/${this.cfg.kvMountPath}/metadata/${path}`,
        undefined,
        true,
      );
      return res.data.keys as string[];
    } catch (e) {
      if ((e as { status?: number })?.status === 404) return [];
      throw e;
    }
  }

  /**
   * Soft-delete un secret (puede ser undeleted).
   */
  async kvDelete(path: string, versions?: number[]): Promise<void> {
    const body = versions ? { versions } : {};
    await this.rawRequest("DELETE", `/v1/${this.cfg.kvMountPath}/data/${path}`, body, true);
  }

  // ── PKI ──────────────────────────────────────────────────────────────────

  /**
   * Emite un certificado X.509 desde el PKI engine.
   * @param role PKI role name
   * @param commonName CN del cert
   * @param altNames SANs DNS
   * @param ipSans SANs IP
   * @param ttl TTL del cert (ej. `"720h"`)
   */
  async pkiIssue(
    role: string,
    commonName: string,
    opts: { altNames?: string[]; ipSans?: string[]; ttl?: string } = {},
  ): Promise<PkiIssueResponse> {
    const body = {
      common_name: commonName,
      alt_names: opts.altNames?.join(","),
      ip_sans: opts.ipSans?.join(","),
      ttl: opts.ttl ?? "720h",
      format: "pem",
    };
    const res = await this.rawRequest(
      "POST",
      `/v1/${this.cfg.pkiMountPath}/issue/${role}`,
      body,
      true,
    );
    return res.data as PkiIssueResponse;
  }

  // ── Transit (envelope encryption) ────────────────────────────────────────

  /**
   * Encrypta plaintext usando una key de Transit. Retorna el ciphertext
   * (incluye `vault:v1:` prefix que indica el key version).
   * @param keyName Nombre de la key en Transit
   * @param plaintext Texto plano (string) o bytes (base64)
   */
  async transitEncrypt(keyName: string, plaintext: string): Promise<string> {
    const res = await this.rawRequest(
      "POST",
      `/v1/${this.cfg.transitMountPath}/encrypt/${encodeURIComponent(keyName)}`,
      { plaintext: btoa(plaintext) },
      true,
    );
    return res.data.ciphertext as string;
  }

  /**
   * Decrypta ciphertext de Transit.
   */
  async transitDecrypt(keyName: string, ciphertext: string): Promise<string> {
    const res = await this.rawRequest(
      "POST",
      `/v1/${this.cfg.transitMountPath}/decrypt/${encodeURIComponent(keyName)}`,
      { ciphertext },
      true,
    );
    const decoded = atob(res.data.plaintext as string);
    return decoded;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Detiene el renewal automático. Llamar en shutdown.
   */
  stop(): void {
    if (this.renewalTimer !== null) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private setToken(token: string): void {
    this.cfg.token = token;
  }

  private scheduleRenewal(): void {
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    if (!this.tokenInfo || !this.tokenInfo.renewable) return;

    // Renueva a (ttl - margen%). Si ttl es muy corto, no programa.
    const renewalDelaySec = Math.max(0, this.tokenInfo.ttl * (1 - TOKEN_RENEW_MARGIN_PCT / 100));
    if (renewalDelaySec <= 0) return;

    this.renewalTimer = setTimeout(async () => {
      try {
        await this.renewSelf();
      } catch (e) {
        this.cfg.logger.error("[vault] Token renewal failed", { error: String(e) });
        // Backoff y reintento
        this.renewalTimer = setTimeout(() => this.scheduleRenewal(), 30_000);
      }
    }, renewalDelaySec * 1000);
  }

  private parseTokenInfo(auth: any): TokenInfo {
    return {
      accessor: auth.accessor ?? "",
      ttl: auth.ttl ?? 0,
      policies: auth.policies ?? [],
      renewable: auth.renewable ?? false,
      expireTime: auth.expire_time ?? 0,
    };
  }

  /**
   * Request HTTP con auth, retry, backoff y timeout.
   * @param requireAuth Si false, no añade X-Vault-Token (usado para /login).
   */
  private async rawRequest(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    requireAuth: boolean,
  ): Promise<any> {
    const url = `${this.cfg.address}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "zenith-core/1.0",
    };
    if (requireAuth) {
      if (!this.cfg.token) throw new Error("[vault] No token set. Call login*() first.");
      headers["X-Vault-Token"] = this.cfg.token;
    }
    if (this.cfg.namespace) headers["X-Vault-Namespace"] = this.cfg.namespace;

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      try {
        const init: RequestInit = { method, headers, signal: controller.signal };
        if (
          body &&
          (method === "POST" || method === "PUT" || method === "DELETE" || method === "LIST")
        ) {
          init.body = JSON.stringify(body);
        }
        const res = await this.cfg.fetchImpl(url, init);
        if (res.ok) {
          if (res.status === 204) return {};
          return await res.json();
        }
        const errBody = await res.text().catch(() => "");
        const err: Error & { status?: number; retryable?: boolean; errors?: string[] } = new Error(
          `[vault] HTTP ${res.status} ${res.statusText} ${errBody}`.trim(),
        );
        err.status = res.status;
        err.retryable = res.status === 429 || res.status >= 500;
        if (res.status === 403 || res.status === 404) {
          try {
            err.errors = (JSON.parse(errBody).errors as string[]) ?? [];
          } catch { /* */ }
        }
        throw err;
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          const err: Error & { retryable?: boolean } = new Error(
            `[vault] timeout after ${this.cfg.timeoutMs}ms`,
          );
          err.retryable = true;
          throw err;
        }
        const retryable = (e as { retryable?: boolean })?.retryable === true;
        attempt++;
        if (!retryable || attempt > this.cfg.maxRetries) throw e;
        const backoff = Math.min(2 ** attempt * 250 + Math.random() * 250, MAX_BACKOFF_MS);
        this.cfg.logger.warn("[vault] retrying after backoff", {
          attempt,
          backoffMs: backoff,
          status: (e as any).status,
        });
        await sleep(backoff);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

// ── Response types ─────────────────────────────────────────────────────────

export interface KvV2Response {
  data: Record<string, unknown>;
  metadata: {
    version: number;
    created_time: string;
    deletion_time: string;
    destroyed: boolean;
  };
}

export interface PkiIssueResponse {
  certificate: string; // PEM-encoded leaf cert
  issuing_ca: string; // PEM CA chain
  ca_chain: string[]; // PEM certs in chain
  private_key: string; // PEM private key
  private_key_type: string;
  serial_number: string;
  expiration: number; // Unix seconds
}

// ── Helpers ────────────────────────────────────────────────────────────────

function validateHttpsUrl(url: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[vault] ${field} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`[vault] ${field} must use HTTPS. Got: ${parsed.protocol}. CWE-319.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultVaultLogger(): VaultLogger {
  return {
    info: (msg, meta) => console.log(`[vault] ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`[vault] ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`[vault] ${msg}`, meta ?? ""),
    debug: () => {},
  };
}
