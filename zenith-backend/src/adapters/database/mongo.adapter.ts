/**
 * MongoDB adapter for Zenith — Document database integration.
 *
 * @barrits-trait
 * @barrits-summary ZenithDatabaseMongo
 * @barrits-provides database-crud, injectMongoPlugin
 * @barrits-consumes
 * @barrits-state mongo_plugin
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { DatabaseAdapter, ZenithQuery, ZenithObject } from "../../core/types.ts";
import { type Db, ObjectId } from "mongodb";

/**
 * Creates a pure MongoDB adapter implementing the standard DatabaseAdapter interface.
 * Handles Parse-compatible queries, Geo queries, subqueries, atomic operators (Increment, AddUnique, Remove, Delete),
 * and pointer serialization — completely decoupled from Barrits or the Zenith pipeline.
 *
 * @param db - Connected MongoDB Db instance
 * @returns DatabaseAdapter — standard CRUD interface consumed by the Zenith pipeline
 */
export function createMongoAdapter(db: Db): DatabaseAdapter {
  /**
   * Transforma Punteros agnósticos en referencias nativas de Mongo.
   */
  const serializePointers = (data: any) => {
    if (data && data.__type === "Pointer") {
      if (data.databaseId && data.databaseId !== "mongo") {
        return { _refId: data.objectId, _refDb: data.databaseId, _refClass: data.className };
      }
      return { _id: data.objectId }; // Asumiendo ObjectId nativo
    }
    return data;
  };

  /**
   * Transforma el documento nativo de Mongo al estándar Zenith/Parse
   * convirtiendo _id a objectId.
   */
  const deserializeMongoDocument = (doc: any) => {
    if (!doc) return null;
    if (doc._id) {
      doc.objectId = doc._id.toString();
      delete doc._id;
    }
    return doc;
  };

  const buildUpdatePayload = (data: Partial<ZenithObject>) => {
    const serialized = serializePointers(data);
    
    const $set: Record<string, any> = {};
    const $inc: Record<string, any> = {};
    const $addToSet: Record<string, any> = {};
    const $pullAll: Record<string, any> = {};
    const $unset: Record<string, any> = {};

    for (const key of Object.keys(serialized)) {
      if (key === "objectId" || key === "_id" || key === "createdAt" || key === "updatedAt" || key === "className") continue;
      
      const val = serialized[key];
      if (val && typeof val === "object" && val.__op) {
         switch (val.__op) {
           case "Increment":
             $inc[key] = val.amount;
             break;
           case "AddUnique":
             $addToSet[key] = { $each: val.objects };
             break;
           case "Remove":
             $pullAll[key] = val.objects;
             break;
           case "Delete":
             $unset[key] = "";
             break;
           default:
             // Fallback if op not supported
             $set[key] = val;
         }
      } else {
         $set[key] = val;
      }
    }

    const updatePayload: Record<string, any> = {};
    if (Object.keys($set).length > 0) updatePayload.$set = $set;
    if (Object.keys($inc).length > 0) updatePayload.$inc = $inc;
    if (Object.keys($addToSet).length > 0) updatePayload.$addToSet = $addToSet;
    if (Object.keys($pullAll).length > 0) updatePayload.$pullAll = $pullAll;
    if (Object.keys($unset).length > 0) updatePayload.$unset = $unset;

    // Ensure updatedAt is set
    if (!updatePayload.$set) updatePayload.$set = {};
    updatePayload.$set.updatedAt = new Date();
    return updatePayload;
  };

  return {
    connect: async () => { /* Manejado por el inyector padre */ },
    disconnect: async () => { /* Manejado por el inyector padre */ },
    
    find: async (collection: string, query: ZenithQuery): Promise<ZenithObject[]> => {
      const mongoWhere: Record<string, any> = {};
      
      const transformId = (idStr: string) => {
         try { return new ObjectId(idStr); } catch { return idStr; }
      };
      
      // Parse query operators
      if (query.where) {
        for (const [key, value] of Object.entries(query.where)) {
          if (value && typeof value === "object") {
            const v = value as any;
            if (v.$nearSphere) {
              mongoWhere[key] = {
                $nearSphere: {
                  $geometry: {
                    type: "Point",
                    coordinates: [v.$nearSphere.longitude, v.$nearSphere.latitude]
                  },
                  $maxDistance: v.$maxDistanceInMiles ? v.$maxDistanceInMiles * 1609.34 : (v.$maxDistanceInKilometers ? v.$maxDistanceInKilometers * 1000 : v.$maxDistanceInRadians * 6378100)
                }
              };
            } else if (v.$within && v.$within.$box) {
              mongoWhere[key] = {
                $geoWithin: {
                  $box: [
                    [v.$within.$box[0].longitude, v.$within.$box[0].latitude],
                    [v.$within.$box[1].longitude, v.$within.$box[1].latitude]
                  ]
                }
              };
            } else if (v.$inQuery) {
               // Subqueries: Using aggregation pipeline is much faster, but 
               // implementing a full subquery via aggregation here requires $lookup.
               // For basic $inQuery in Mongo, we can run the subquery and use $in.
               // A robust implementation would construct an aggregation pipeline,
               // but Parse's original approach runs the inner query first.
               const innerDocs = await db.collection(v.$inQuery.className).find(v.$inQuery.where || {}).project({ _id: 1 }).toArray();
               const ids = innerDocs.map(d => d._id.toString());
               mongoWhere[key] = { $in: ids };
            } else {
               mongoWhere[key] = value;
            }
          } else if (key === "objectId") {
            mongoWhere["_id"] = transformId(value as string);
          } else {
            mongoWhere[key] = value;
          }
        }
      }

      let cursor = db.collection(collection).find(mongoWhere);
      
      if (query.limit) cursor = cursor.limit(query.limit);
      if (query.skip) cursor = cursor.skip(query.skip);
      if (query.order) {
        const sortObj: Record<string, 1 | -1> = {};
        const fields = query.order.split(",");
        for (const f of fields) {
          if (f.startsWith("-")) sortObj[f.substring(1)] = -1;
          else sortObj[f] = 1;
        }
        cursor = cursor.sort(sortObj);
      }
      
      const docs = await cursor.toArray();
      return docs.map(deserializeMongoDocument) as unknown as ZenithObject[];
    },

    findOne: async (collection: string, query: ZenithQuery): Promise<ZenithObject | null> => {
      const where = query.where ? { ...query.where } : {};
      if (where.objectId) {
        where._id = where.objectId;
        delete where.objectId;
        try { where._id = new ObjectId(where._id as string); } catch (_e) { /* invalid objectId, leave as string */ }
      }
      const doc = await db.collection(collection).findOne(where);
      return deserializeMongoDocument(doc) as unknown as ZenithObject | null;
    },

    insert: async (collection: string, data: ZenithObject): Promise<ZenithObject> => {
      // A caller-chosen objectId (Parse `allowCustomObjectId`) becomes the primary key, so a
      // duplicate fails on the unique _id instead of creating a twin.
      const { objectId, ...rest } = data as ZenithObject & { objectId?: string };
      const _id = objectId && /^[0-9a-f]{24}$/i.test(objectId) ? new ObjectId(objectId) : objectId;
      const serialized = serializePointers(_id ? { _id, ...rest } : rest);
      const result = await db.collection(collection).insertOne(serialized);
      return { ...data, objectId: result.insertedId.toString() };
    },

    update: async (collection: string, objectId: string, data: Partial<ZenithObject>): Promise<ZenithObject> => {
      const updatePayload = buildUpdatePayload(data);

      let queryId: any = objectId;
      try { queryId = new ObjectId(objectId); } catch (_e) { /* not an ObjectId */ }

      await db.collection(collection).updateOne({ _id: queryId }, updatePayload);
      
      // We don't have the updated document here unless we fetch it. 
      // Parse actually returns the updated fields (like computed Increment values).
      // For simplicity in this iteration, we just return the objectId and data.
      return { objectId, ...data } as ZenithObject;
    },

    updateIf: async (collection: string, objectId: string, conditions: Record<string, unknown>, data: Partial<ZenithObject>): Promise<ZenithObject | null> => {
      let queryId: any = objectId;
      try { queryId = new ObjectId(objectId); } catch (_e) { /* not an ObjectId */ }

      const result = await db.collection(collection).updateOne({ ...conditions, _id: queryId }, buildUpdatePayload(data));
      return result.matchedCount === 0 ? null : { objectId, ...data } as ZenithObject;
    },

    delete: async (collection: string, objectId: string): Promise<void> => {
      let queryId: any = objectId;
      try { queryId = new ObjectId(objectId); } catch (_e) { /* not an ObjectId */ }
      await db.collection(collection).deleteOne({ _id: queryId });
    }
  };
}

/**
 * TRAIT BARRITS: Inyector del plugin en el ecosistema Zenith
 */
export const DatabaseMongoTrait = createTraitDescriptor({
  name: "ZenithDatabaseMongo",
  provides: ["database-crud", "injectMongoPlugin"],
  consumes: [],
  state: ["mongo_plugin"],
  runtimes: ["deno"],
  create: (_deps: Record<string, unknown>) => {
    let adapter: DatabaseAdapter | null = null;
    return {
      /**
       * El pipeline inyecta el adaptador puro previamente configurado
       */
      injectMongoPlugin: (plugin: DatabaseAdapter) => {
        adapter = plugin;
        console.log("[MongoTrait] MongoDB Plugin Injected");
      },
      // Exponemos la interfaz estándar bajo la llave "database-crud"
      "database-crud": {
        find: (col: string, q: ZenithQuery) => adapter!.find(col, q),
        findOne: (col: string, q: ZenithQuery) => adapter!.findOne(col, q),
        insert: (col: string, data: ZenithObject) => adapter!.insert(col, data),
        update: (col: string, id: string, data: Partial<ZenithObject>) => adapter!.update(col, id, data),
        delete: (col: string, id: string) => adapter!.delete(col, id),
        // Compare-and-set: the update applies only if `conditions` still hold (leases, optimistic locks).
        updateIf: (col: string, id: string, conditions: Record<string, unknown>, data: Partial<ZenithObject>) => adapter!.updateIf!(col, id, conditions, data),
      }
    };
  }
});
