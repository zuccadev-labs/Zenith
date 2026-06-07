import { RESTController } from "../rest/RESTController.js";
import { ZenithError, ZenithErrorCode } from "../core/ZenithError.js";

/**
 * Represents a Parse Pointer (relation to another object).
 * Compatible with the Parse Server pointer protocol: { __type: "Pointer", className, objectId }
 */
export interface ZenithPointer {
  __type: "Pointer";
  className: string;
  objectId: string;
}

/**
 * Represents a field operation for atomic mutations.
 */
interface FieldOperation {
  __op: string;
  [key: string]: any;
}

/**
 * @class ZenithObject
 * Core data model for Zenith. Full parity with Parse.Object.
 * 
 * @example
 * const score = new ZenithObject("GameScore");
 * score.set("score", 1337);
 * score.set("player", Zenith.Object.createPointer("_User", userId));
 * await score.save();
 */
export class ZenithObject {
  public className: string;
  public objectId?: string;
  public createdAt?: Date;
  public updatedAt?: Date;
  private _attributes: Record<string, any> = {};
  private _pendingOps: Record<string, FieldOperation> = {};
  private _dirty: Set<string> = new Set();

  constructor(className: string, attributes?: Record<string, any>) {
    this.className = className;
    if (attributes) {
      this._hydrate(attributes);
    }
  }

  // ─── Static Factories ──────────────────────────────────────────────────────

  /**
   * Creates a reference to an existing object without fetching it.
   * Equivalent to Parse.Object.createWithoutData().
   */
  public static createWithoutData(className: string, objectId: string): ZenithObject {
    const obj = new ZenithObject(className);
    obj.objectId = objectId;
    return obj;
  }

  /**
   * Creates a Pointer JSON object compatible with Parse Server protocol.
   * Use this to set relation fields on objects.
   * 
   * @example
   * post.set("author", ZenithObject.pointer("_User", user.objectId!));
   */
  public static pointer(className: string, objectId: string): ZenithPointer {
    return { __type: "Pointer", className, objectId };
  }

  /**
   * Deserializes a JSON object (from REST response or toJSON) into a ZenithObject.
   */
  public static fromJSON(json: Record<string, any>): ZenithObject {
    const { className, objectId, createdAt, updatedAt, ...rest } = json;
    const obj = new ZenithObject(className || "_Object");
    if (objectId)  obj.objectId  = objectId;
    if (createdAt) obj.createdAt = ZenithObject.parseApiDate(createdAt);
    if (updatedAt) obj.updatedAt = ZenithObject.parseApiDate(updatedAt);
    obj._attributes = rest;
    return obj;
  }

  // ─── Getters / Setters ────────────────────────────────────────────────────

  /**
   * Parse SDK parity: `.id` is the canonical identifier for a ZenithObject.
   * Returns `objectId` — the string assigned by the backend on save().
   * Without this getter, `user.id` is `undefined` and `isMe` checks break.
   */
  public get id(): string | undefined {
    return this.objectId;
  }

  public get(key: string): any {
    if (key === "objectId") return this.objectId;
    if (key === "createdAt") return this.createdAt;
    if (key === "updatedAt") return this.updatedAt;
    return this._attributes[key];
  }

  public set(keyOrObj: string | Record<string, any>, value?: any): this {
    if (typeof keyOrObj === "string") {
      this._attributes[keyOrObj] = value;
      this._dirty.add(keyOrObj);
    } else {
      for (const k in keyOrObj) {
        if (k === "objectId") this.objectId = keyOrObj[k];
        else if (k === "createdAt") this.createdAt = ZenithObject.parseApiDate(keyOrObj[k]);
        else if (k === "updatedAt") this.updatedAt = ZenithObject.parseApiDate(keyOrObj[k]);
        else {
          this._attributes[k] = keyOrObj[k];
          this._dirty.add(k);
        }
      }
    }
    return this;
  }

  public unset(key: string): this {
    delete this._attributes[key];
    this._pendingOps[key] = { __op: "Delete" };
    this._dirty.add(key);
    return this;
  }

  public has(key: string): boolean {
    return this._attributes[key] !== undefined && this._attributes[key] !== null;
  }

  // ─── Atomic Operations ────────────────────────────────────────────────────

  /**
   * Atomically increments a numeric field.
   * @example score.increment("score", 100);
   */
  public increment(key: string, amount = 1): this {
    const existing = this._pendingOps[key];
    if (existing?.__op === "Increment") {
      this._pendingOps[key] = { __op: "Increment", amount: existing.amount + amount };
    } else {
      this._pendingOps[key] = { __op: "Increment", amount };
    }
    this._dirty.add(key);
    return this;
  }

  public decrement(key: string, amount = 1): this {
    return this.increment(key, -amount);
  }

  /**
   * Atomically adds elements to an array field, only if not already present.
   */
  public addUnique(key: string, objects: any[]): this {
    this._pendingOps[key] = { __op: "AddUnique", objects };
    this._dirty.add(key);
    return this;
  }

  /**
   * Atomically removes elements from an array field.
   */
  public remove(key: string, objects: any[]): this {
    this._pendingOps[key] = { __op: "Remove", objects };
    this._dirty.add(key);
    return this;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Normalises every date format Parse Server may emit:
   *   • ISO string          "2024-01-01T12:00:00.000Z"          (REST find/save)
   *   • Parse date object   { __type: "Date", iso: "2024..." }  (LiveQuery events)
   *   • JS Date             already a Date                       (local optimistic)
   * Returns undefined when the input is absent.
   */
  private static parseApiDate(val: unknown): Date | undefined {
    if (!val) return undefined;
    if (val instanceof Date) return isNaN(val.getTime()) ? undefined : val;
    if (typeof val === "string") { const d = new Date(val); return isNaN(d.getTime()) ? undefined : d; }
    if (typeof val === "object") {
      const iso = (val as any).iso;
      if (iso) { const d = new Date(iso); return isNaN(d.getTime()) ? undefined : d; }
    }
    return undefined;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  public async save(options?: { useMasterKey?: boolean; sessionToken?: string }): Promise<this> {
    // Merge pending ops into the payload
    const payload: Record<string, any> = {};
    
    // Only dirty fields for updates (bandwidth optimization)
    for (const key of this._dirty) {
      if (this._pendingOps[key]) {
        payload[key] = this._pendingOps[key];
      } else {
        payload[key] = this._attributes[key];
      }
    }

    if (this.objectId) {
      const res = await RESTController.request("PUT", `/classes/${this.className}/${this.objectId}`, payload, options);
      if (res.updatedAt) this.updatedAt = new Date(res.updatedAt);
    } else {
      // For new objects, send all attributes
      const res = await RESTController.request("POST", `/classes/${this.className}`, { ...this._attributes, ...payload }, options);
      this._hydrate(res);
    }

    this._dirty.clear();
    this._pendingOps = {};
    return this;
  }

  public async fetch(options?: { useMasterKey?: boolean; sessionToken?: string }): Promise<this> {
    if (!this.objectId) throw new ZenithError(ZenithErrorCode.MISSING_OBJECT_ID, "Cannot fetch an object without an objectId.");
    const res = await RESTController.request("GET", `/classes/${this.className}/${this.objectId}`, undefined, options);
    this._hydrate(res);
    return this;
  }

  public async destroy(options?: { useMasterKey?: boolean; sessionToken?: string }): Promise<void> {
    if (!this.objectId) throw new ZenithError(ZenithErrorCode.MISSING_OBJECT_ID, "Cannot destroy an object without an objectId.");
    await RESTController.request("DELETE", `/classes/${this.className}/${this.objectId}`, undefined, options);
    this.objectId = undefined;
  }

  // ─── Serialization ────────────────────────────────────────────────────────

  public toJSON(): Record<string, any> {
    return {
      className: this.className,
      objectId: this.objectId,
      createdAt: this.createdAt?.toISOString(),
      updatedAt: this.updatedAt?.toISOString(),
      ...this._attributes,
    };
  }

  public toPointer(): ZenithPointer {
    if (!this.objectId) throw new ZenithError(ZenithErrorCode.MISSING_OBJECT_ID, "Cannot create pointer from unsaved object.");
    return ZenithObject.pointer(this.className, this.objectId);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private _hydrate(data: Record<string, any>): void {
    for (const k in data) {
      if (k === "objectId") this.objectId = data[k];
      else if (k === "createdAt") this.createdAt = ZenithObject.parseApiDate(data[k]);
      else if (k === "updatedAt") this.updatedAt = ZenithObject.parseApiDate(data[k]);
      else this._attributes[k] = data[k];
    }
  }
}
