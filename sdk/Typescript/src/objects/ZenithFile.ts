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
 * Manages API keys for machine-to-machine (M2M) integrations and business models.
 *
 * @example
 * // Create a new scoped API key
 * const key = await ZenithAPIKey.create("Mobile App v2", ["read:*", "functions"]);
 * console.log(key.value); // ⚠️ Only shown once — store securely
 *
 * // List all keys for the current user
 * const keys = await ZenithAPIKey.list();
 *
 * // Revoke a key
 * await key.revoke();
 */
export class ZenithAPIKey {
  public readonly keyId: string;
  public readonly name: string;
  public readonly scopes: string[];
  /** Present only immediately after creation. Never stored server-side as plaintext. */
  public readonly value?: string;
  public readonly createdAt: Date;
  public readonly lastUsedAt?: Date;

  constructor(data: any) {
    this.keyId = data.keyId ?? data.objectId;
    this.name = data.name;
    this.scopes = Array.isArray(data.scopes) ? data.scopes : ["*"];
    this.value = data.value;
    this.createdAt = new Date(data.createdAt);
    if (data.lastUsedAt) this.lastUsedAt = new Date(data.lastUsedAt);
  }

  /**
   * Creates a new API key.
   * The `value` field is returned only once — save it immediately.
   *
   * @param name  Human-readable label for the key.
   * @param scopes  Permission scopes (e.g. ["read:*"], ["write:GameScore"], ["*"]).
   */
  public static async create(
    name: string,
    scopes: string[] = ["*"],
    options?: { useMasterKey?: boolean }
  ): Promise<ZenithAPIKey> {
    const res = await RESTController.request("POST", "/zen/apikeys", { name, scopes }, options);
    // The server returns the plaintext once, as `key`.
    return new ZenithAPIKey({ ...res, value: res.key });
  }

  /**
   * Lists all API keys owned by the current user.
   * With `useMasterKey: true`, returns all keys across all users.
   */
  public static async list(options?: { useMasterKey?: boolean }): Promise<ZenithAPIKey[]> {
    const res = await RESTController.request("GET", "/zen/apikeys", undefined, options);
    return (res.results ?? []).map((k: any) => new ZenithAPIKey(k));
  }

  /**
   * Permanently revokes this API key.
   */
  public async revoke(options?: { useMasterKey?: boolean }): Promise<void> {
    await RESTController.request("DELETE", `/zen/apikeys/${encodeURIComponent(this.keyId)}`, undefined, options);
  }

  public toJSON() {
    return {
      keyId: this.keyId,
      name: this.name,
      scopes: this.scopes,
      createdAt: this.createdAt.toISOString(),
      lastUsedAt: this.lastUsedAt?.toISOString(),
    };
  }
}
