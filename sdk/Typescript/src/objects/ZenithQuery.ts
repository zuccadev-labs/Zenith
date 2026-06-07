import { RESTController } from "../rest/RESTController.js";
import { ZenithObject } from "./ZenithObject.js";

/**
 * @class ZenithQuery
 * Full parity with Parse.Query. Fluent, chainable API for querying objects.
 *
 * @example
 * const query = new ZenithQuery<GameScore>("GameScore");
 * query.equalTo("playerName", "Alice")
 *      .greaterThan("score", 1000)
 *      .include("level")
 *      .limit(10);
 * const results = await query.find();
 */
export class ZenithQuery<T extends ZenithObject = ZenithObject> {
  public className: string;
  private _where: Record<string, any> = {};
  private _limit?: number;
  private _skip?: number;
  private _order?: string[];
  private _include?: string[];
  private _keys?: string[];
  private _count?: boolean;

  constructor(className: string) {
    this.className = className;
  }

  // ─── Equality Constraints ──────────────────────────────────────────────────

  public equalTo(key: string, value: any): this {
    // Support passing a ZenithObject as a pointer value
    if (value && typeof value === "object" && value.objectId && value.className) {
      this._where[key] = { __type: "Pointer", className: value.className, objectId: value.objectId };
    } else {
      this._where[key] = value;
    }
    return this;
  }

  public notEqualTo(key: string, value: any): this {
    this._where[key] = { $ne: value };
    return this;
  }

  // ─── Comparison Constraints ───────────────────────────────────────────────

  public greaterThan(key: string, value: any): this {
    this._where[key] = { ...this._where[key], $gt: value };
    return this;
  }

  public greaterThanOrEqualTo(key: string, value: any): this {
    this._where[key] = { ...this._where[key], $gte: value };
    return this;
  }

  public lessThan(key: string, value: any): this {
    this._where[key] = { ...this._where[key], $lt: value };
    return this;
  }

  public lessThanOrEqualTo(key: string, value: any): this {
    this._where[key] = { ...this._where[key], $lte: value };
    return this;
  }

  // ─── Array/Set Constraints ────────────────────────────────────────────────

  public containedIn(key: string, values: any[]): this {
    this._where[key] = { $in: values };
    return this;
  }

  public notContainedIn(key: string, values: any[]): this {
    this._where[key] = { $nin: values };
    return this;
  }

  public containsAll(key: string, values: any[]): this {
    this._where[key] = { $all: values };
    return this;
  }

  // ─── Existence Constraints ────────────────────────────────────────────────

  public exists(key: string): this {
    this._where[key] = { $exists: true };
    return this;
  }

  public doesNotExist(key: string): this {
    this._where[key] = { $exists: false };
    return this;
  }

  // ─── String Constraints ───────────────────────────────────────────────────

  public startsWith(key: string, prefix: string): this {
    this._where[key] = { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" };
    return this;
  }

  public contains(key: string, substring: string): this {
    this._where[key] = { $regex: substring.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    return this;
  }

  public matches(key: string, regex: RegExp): this {
    this._where[key] = { $regex: regex.source, $options: regex.flags };
    return this;
  }

  // ─── Sub-Query Constraints ────────────────────────────────────────────────

  public matchesQuery(key: string, query: ZenithQuery): this {
    this._where[key] = {
      $inQuery: {
        className: query.className,
        where: (query as any)._where,
      },
    };
    return this;
  }

  public doesNotMatchQuery(key: string, query: ZenithQuery): this {
    this._where[key] = {
      $notInQuery: {
        className: query.className,
        where: (query as any)._where,
      },
    };
    return this;
  }

  // ─── Compound Constraints ─────────────────────────────────────────────────

  public static or<T extends ZenithObject>(...queries: ZenithQuery<T>[]): ZenithQuery<T> {
    if (queries.length === 0) throw new Error("ZenithQuery.or requires at least one query.");
    const className = queries[0].className;
    const combined = new ZenithQuery<T>(className);
    (combined as any)._where = { $or: queries.map(q => (q as any)._where) };
    return combined;
  }

  public static and<T extends ZenithObject>(...queries: ZenithQuery<T>[]): ZenithQuery<T> {
    if (queries.length === 0) throw new Error("ZenithQuery.and requires at least one query.");
    const className = queries[0].className;
    const combined = new ZenithQuery<T>(className);
    (combined as any)._where = { $and: queries.map(q => (q as any)._where) };
    return combined;
  }

  // ─── Ordering ────────────────────────────────────────────────────────────

  public ascending(...keys: string[]): this {
    this._order = [...(this._order || []), ...keys];
    return this;
  }

  public descending(...keys: string[]): this {
    this._order = [...(this._order || []), ...keys.map(k => `-${k}`)];
    return this;
  }

  // ─── Pagination ───────────────────────────────────────────────────────────

  public limit(n: number): this {
    this._limit = n;
    return this;
  }

  public skip(n: number): this {
    this._skip = n;
    return this;
  }

  // ─── Field Selection ──────────────────────────────────────────────────────

  public include(keys: string | string[]): this {
    this._include = Array.isArray(keys) ? keys : keys.split(",").map(s => s.trim());
    return this;
  }

  public select(keys: string | string[]): this {
    this._keys = Array.isArray(keys) ? keys : keys.split(",").map(s => s.trim());
    return this;
  }

  // ─── Query Execution ──────────────────────────────────────────────────────

  private _buildParams(): Record<string, any> {
    const params: any = {};
    if (Object.keys(this._where).length > 0) params.where = this._where;
    if (this._limit !== undefined) params.limit = this._limit;
    if (this._skip !== undefined) params.skip = this._skip;
    if (this._order?.length) params.order = this._order.join(",");
    if (this._include?.length) params.include = this._include.join(",");
    if (this._keys?.length) params.keys = this._keys.join(",");
    if (this._count) params.count = 1;
    return params;
  }

  private _toObject(item: any): T {
    return new ZenithObject(this.className, item) as T;
  }

  /**
   * Finds all matching objects.
   */
  public async find(options?: { useMasterKey?: boolean; sessionToken?: string }): Promise<T[]> {
    const res = await RESTController.request("GET", `/classes/${this.className}`, this._buildParams(), options);
    if (res.results && Array.isArray(res.results)) {
      return res.results.map((item: any) => this._toObject(item));
    }
    return [];
  }

  /**
   * Returns the first matching object, or undefined.
   */
  public async first(options?: { useMasterKey?: boolean; sessionToken?: string }): Promise<T | undefined> {
    this.limit(1);
    const results = await this.find(options);
    return results[0];
  }

  /**
   * Retrieves a single object by its objectId.
   */
  public async get(objectId: string, options?: { useMasterKey?: boolean; sessionToken?: string }): Promise<T> {
    const params: any = {};
    if (this._include?.length) params.include = this._include.join(",");
    const res = await RESTController.request("GET", `/classes/${this.className}/${objectId}`, params, options);
    return this._toObject(res);
  }

  /**
   * Returns the count of matching objects.
   */
  public async count(options?: { useMasterKey?: boolean; sessionToken?: string }): Promise<number> {
    this._count = true;
    const params = { ...this._buildParams(), count: 1, limit: 0 };
    const res = await RESTController.request("GET", `/classes/${this.className}`, params, options);
    return res.count ?? 0;
  }

  /**
   * Iterates over each result, calling callback.
   */
  public async each(callback: (obj: T) => Promise<void> | void, options?: { useMasterKey?: boolean; sessionToken?: string }): Promise<void> {
    this.limit(100);
    let skip = 0;
    while (true) {
      this.skip(skip);
      const results = await this.find(options);
      if (results.length === 0) break;
      for (const obj of results) {
        await callback(obj);
      }
      if (results.length < 100) break;
      skip += 100;
    }
  }

  // Expose internals for LiveQuery and subqueries
  public get _whereClause() { return this._where; }
}
