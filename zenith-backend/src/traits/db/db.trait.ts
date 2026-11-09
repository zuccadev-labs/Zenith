/**
 * The `db` capability the feature traits are written against, on top of whichever adapter provides
 * `database-crud` (MongoDB, ScyllaDB, SurrealDB).
 *
 * @barrits-trait
 * @barrits-summary ZenithDb
 * @barrits-provides db
 * @barrits-consumes database-crud
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

type Where = Record<string, unknown>;
type Doc = Record<string, any>;

export interface Crud {
  find(collection: string, query: { where?: Where; limit?: number; skip?: number; order?: string }): Promise<Doc[]>;
  findOne(collection: string, query: { where?: Where }): Promise<Doc | null>;
  insert(collection: string, data: Doc): Promise<Doc>;
  update(collection: string, objectId: string, data: Doc): Promise<Doc>;
  updateIf?(collection: string, objectId: string, conditions: Where, data: Doc): Promise<Doc | null>;
  delete(collection: string, objectId: string): Promise<void>;
  listClasses?(): Promise<string[]>;
}

/** `{objectId}` alone addresses one object; anything else is a filter. */
const byId = (f: Where): string | null =>
  Object.keys(f).length === 1 && typeof f.objectId === "string" ? f.objectId : null;

/**
 * The trait-facing API. Filters are Parse/Mongo `where` objects.
 *
 * - `find(class, where?)`, `findOne(class, where)`, `read(class, id)` → objects or `null`
 * - `create(class, data)` → the object with `objectId`, `createdAt`, `updatedAt`
 * - `update(class, {objectId} | where, data)` → the updated object (the first one for a filter)
 * - `delete(class, {objectId} | where)`
 * - `upsert(class, where, data)`, `updateIf(class, id, conditions, data)`, `listClasses()`
 *
 * Updates and deletes by filter touch each match separately: they are not atomic as a group.
 */
export function createDb(crud: () => Crud) {
  const c = () => {
    const x = crud();
    if (!x) throw new Error("db: no database adapter (database-crud) is available");
    return x;
  };
  const ids = async (cls: string, f: Where) => {
    const one = byId(f);
    return one ? [one] : (await c().find(cls, { where: f })).map((d) => d.objectId as string);
  };
  const api = {
    find: (cls: string, where: Where = {}, opts: { limit?: number; skip?: number; order?: string } = {}) =>
      c().find(cls, { where, ...opts }),
    findOne: (cls: string, where: Where) => c().findOne(cls, { where }),
    read: (cls: string, objectId: string) =>
      typeof objectId === "string" && objectId ? c().findOne(cls, { where: { objectId } }) : Promise.resolve(null),
    create: async (cls: string, data: Doc) => {
      const now = new Date().toISOString();
      return await c().insert(cls, { createdAt: now, updatedAt: now, ...data });
    },
    insert: (cls: string, data: Doc) => c().insert(cls, data),
    update: async (cls: string, filter: Where | string, data: Doc) => {
      const targets = typeof filter === "string" ? [filter] : await ids(cls, filter);
      for (const id of targets) await c().update(cls, id, data);
      return targets.length ? await c().findOne(cls, { where: { objectId: targets[0] } }) : null;
    },
    updateIf: (cls: string, objectId: string, conditions: Where, data: Doc) => {
      const x = c();
      if (!x.updateIf) throw new Error("db.updateIf: this database adapter has no conditional updates");
      return x.updateIf(cls, objectId, conditions, data);
    },
    delete: async (cls: string, filter: Where | string) => {
      const targets = typeof filter === "string" ? [filter] : await ids(cls, filter);
      for (const id of targets) await c().delete(cls, id);
      return { deleted: targets.length };
    },
    upsert: async (cls: string, where: Where, data: Doc) => {
      const found = await c().findOne(cls, { where });
      if (found) {
        await c().update(cls, found.objectId, data);
        return { ...found, ...data };
      }
      return await api.create(cls, { ...where, ...data });
    },
    listClasses: async () => {
      const x = c();
      if (!x.listClasses) throw new Error("db.listClasses: this database adapter cannot list classes");
      return await x.listClasses();
    },
  };
  return api;
}

export const DbTrait = createTraitDescriptor({
  name: "ZenithDb",
  provides: ["db"],
  consumes: ["database-crud"],
  state: [],
  runtimes: ["deno"],
  summary: "The db capability of the feature traits, over the configured database-crud adapter.",
  create: (deps: Record<string, any>) => ({
    db: createDb(() => deps.traits["database-crud"] as Crud),
  }),
});
