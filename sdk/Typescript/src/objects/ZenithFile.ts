import { RESTController } from "../rest/RESTController.js";
import { Zenith } from "../core/Zenith.js";

/**
 * @class ZenithFile
 * Handles file upload to the Zenith storage backend (RustFS/S3).
 * Compatible with Parse.File API.
 *
 * @example
 * const file = new ZenithFile("avatar.jpg", blob);
 * await file.save();
 * user.set("avatar", file.toJSON());
 * await user.save();
 */
export class ZenithFile {
  private _name: string;
  private _data: Blob | File | null;
  private _url: string | null = null;
  private _saved = false;

  constructor(name: string, data: Blob | File) {
    // Sanitize: only allow safe filename characters
    this._name = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    this._data = data;
  }

  public get name(): string { return this._name; }
  public get url(): string | null { return this._url; }
  public get saved(): boolean { return this._saved; }

  /**
   * Uploads the file to the Zenith backend.
   * Returns `this` for chaining.
   */
  public async save(options?: { sessionToken?: string }): Promise<this> {
    if (this._saved) return this;
    if (!this._data) throw new Error("ZenithFile: No data to upload.");

    const config = Zenith.getConfig();
    const sessionToken = options?.sessionToken ?? Zenith.sessionToken;

    // Parse protocol: the raw bytes to POST /files/:name (the server has no /storage/upload).
    const headers: Record<string, string> = {
      "Zen-Application-Id": config.appId,
      "X-Parse-Application-Id": config.appId,
      "Content-Type": this._data.type || "application/octet-stream",
    };
    if (sessionToken) {
      headers["Authorization"] = `Bearer ${sessionToken}`;
      headers["Zen-Session-Token"] = sessionToken;
    }

    const res = await fetch(`${config.serverURL}/files/${encodeURIComponent(this._name)}`, {
      method: "POST",
      headers,
      body: this._data,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText, code: res.status }));
      const e: any = new Error(`File upload failed: ${err.error ?? res.statusText}`);
      e.code = err.code ?? res.status;
      throw e;
    }

    const data = await res.json();
    this._url = data.url;
    this._name = data.name || this._name;
    this._saved = true;
    return this;
  }

  /**
   * Serializes to Parse Pointer-compatible File format.
   */
  public toJSON(): Record<string, string> {
    return {
      __type: "File",
      name: this._name,
      url: this._url || "",
    };
  }
}

/**
 * @class ZenithAPIKey
 * API keys of the app (`/zen/api-keys`), for machine-to-machine integrations.
 *
 * Server-side only. The server manages keys with the master key alone, which it accepts only from
 * localhost (ADR-015): never ship the master key to a browser or a mobile app. The same API is
 * available as `zen api-keys list|create|revoke|rotate`.
 *
 * @example
 * // Node script on the server, with Zenith.initialize(appId, { masterKey, ... })
 * const key = await ZenithAPIKey.create({ name: "crm sync", scopes: ["data:read"], expiresIn: "90d" });
 * console.log(key.value); // shown once: store it in a secret manager
 *
 * // Scope "*" needs an IP allowlist and an expiry of at most 90 days.
 * await ZenithAPIKey.create({ name: "ops", scopes: ["*"], allowedIps: ["10.0.0.0/24"], expiresIn: "30d" });
 *
 * const keys = await ZenithAPIKey.list();
 * await keys[0].revoke("leaked in a log");
 */
export class ZenithAPIKey {
  /** Public id (the 8 characters after `sk_live_`). */
  public readonly keyId: string;
  public readonly name: string;
  public readonly prefix: "sk" | "pk" | "rk";
  public readonly env: "live" | "test";
  public readonly scopes: string[];
  public readonly allowedIps?: string[];
  /** Present only in the result of `create` and `rotate`. Never stored server-side as plaintext. */
  public readonly value?: string;
  public readonly createdAt: Date;
  public readonly lastUsedAt?: Date;
  public readonly expiresAt?: Date;
  public readonly revokedAt?: Date;

  constructor(record: any, value?: string) {
    this.keyId = record.id;
    this.name = record.name;
    this.prefix = record.prefix;
    this.env = record.env;
    this.scopes = Array.isArray(record.scopes) ? record.scopes : [];
    if (Array.isArray(record.allowedIps)) this.allowedIps = record.allowedIps;
    this.value = value;
    this.createdAt = new Date(record.createdAt);
    if (record.lastUsedAt) this.lastUsedAt = new Date(record.lastUsedAt);
    if (record.expiresAt) this.expiresAt = new Date(record.expiresAt);
    if (record.revokedAt) this.revokedAt = new Date(record.revokedAt);
  }

  private static master() {
    if (!Zenith.getConfig().masterKey) {
      throw new Error("ZenithAPIKey needs the master key (server-side only): Zenith.initialize(appId, { masterKey }).");
    }
    return { useMasterKey: true };
  }

  /** Creates a key. The plaintext comes back once, in `value`. */
  public static async create(options: {
    name: string;
    scopes?: string[];
    prefix?: "sk" | "pk" | "rk";
    env?: "live" | "test";
    /** ISO 8601 date or duration such as "90d". */
    expiresIn?: string;
    /** IPv4/IPv6 addresses or CIDR ranges the key may be used from. */
    allowedIps?: string[];
    requestsPerMinute?: number;
  }): Promise<ZenithAPIKey> {
    const res = await RESTController.request("POST", "/zen/api-keys", options, ZenithAPIKey.master());
    return new ZenithAPIKey(res.record, res.key);
  }

  /** The app's keys (metadata only, never secrets). */
  public static async list(): Promise<ZenithAPIKey[]> {
    const res = await RESTController.request("GET", "/zen/api-keys", undefined, ZenithAPIKey.master());
    return (res.results ?? []).map((r: any) => new ZenithAPIKey(r));
  }

  /** Revokes this key at once. */
  public async revoke(reason?: string): Promise<void> {
    await RESTController.request("POST", `/zen/api-keys/${encodeURIComponent(this.keyId)}/revoke`, reason ? { reason } : {}, ZenithAPIKey.master());
  }

  /**
   * Issues a replacement with the same scopes, IP allowlist and lifetime. This key keeps working
   * for `graceHours` (default 24) so clients can switch.
   */
  public async rotate(graceHours?: number): Promise<ZenithAPIKey> {
    const body = graceHours === undefined ? {} : { graceHours };
    const res = await RESTController.request("POST", `/zen/api-keys/${encodeURIComponent(this.keyId)}/rotate`, body, ZenithAPIKey.master());
    return new ZenithAPIKey(res.record, res.key);
  }

  public toJSON() {
    return {
      keyId: this.keyId,
      name: this.name,
      prefix: this.prefix,
      env: this.env,
      scopes: this.scopes,
      allowedIps: this.allowedIps,
      createdAt: this.createdAt.toISOString(),
      lastUsedAt: this.lastUsedAt?.toISOString(),
      expiresAt: this.expiresAt?.toISOString(),
      revokedAt: this.revokedAt?.toISOString(),
    };
  }
}
