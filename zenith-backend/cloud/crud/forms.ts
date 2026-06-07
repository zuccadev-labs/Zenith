import { Zen } from "../../src/mod.ts";

// ─── Reusable Cloud CRUD Generator (Enterprise Pattern) ────────────────────

/**
 * Generates secure, owner-based CRUD Cloud Functions for a specific class.
 * This prevents repetitive boilerplate while ensuring enterprise-level security.
 */
function defineSecureCRUD(className: string, resourceName: string) {
  // CREATE
  Zen.Cloud.define(`create${resourceName}`, async (request) => {
    const user = request.user;
    if (!user) throw new Error(`You must be logged in to create a ${resourceName}.`);

    const db = Zen.DB.getAdapter();
    const ownerId = user.objectId || user._id;

    // Inyección de Seguridad ACL Estricta (Parse-Server Standard)
    const result = await db.insert(className, {
      ...request.params,
      owner: { __type: "Pointer", className: "_User", objectId: ownerId },
      _rperm: [ownerId], // Solo el dueño puede leer
      _wperm: [ownerId], // Solo el dueño puede modificar
      createdAt: new Date(),
      updatedAt: new Date()
    });
    return result;
  });

  // READ (List with ownership filter)
  Zen.Cloud.define(`get${resourceName}s`, async (request) => {
    const user = request.user;
    if (!user) throw new Error("Unauthorized.");

    const db = Zen.DB.getAdapter();
    // Enforce ownership securely at the Cloud level
    const results = await db.find(className, { 
      where: { "owner.objectId": user.objectId || user._id } 
    });
    return results;
  });

  // UPDATE
  Zen.Cloud.define(`update${resourceName}`, async (request) => {
    const user = request.user;
    const { objectId, ...updates } = request.params as any;
    if (!user || !objectId) throw new Error("Unauthorized or missing objectId.");

    const db = Zen.DB.getAdapter();
    const existing = await db.findOne(className, { where: { _id: objectId } });
    
    if (!existing || existing.owner?.objectId !== (user.objectId || user._id)) {
      throw new Error("Record not found or access denied.");
    }

    const result = await db.update(className, { _id: objectId }, { ...updates, updatedAt: new Date() });
    return result;
  });

  // DELETE
  Zen.Cloud.define(`delete${resourceName}`, async (request) => {
    const user = request.user;
    const { objectId } = request.params as any;
    if (!user || !objectId) throw new Error("Unauthorized or missing objectId.");

    const db = Zen.DB.getAdapter();
    const existing = await db.findOne(className, { where: { _id: objectId } });
    
    if (!existing || existing.owner?.objectId !== (user.objectId || user._id)) {
      throw new Error("Record not found or access denied.");
    }

    await db.delete(className, { _id: objectId });
    return { success: true };
  });
}

// Instantiate the reusable CRUD for FormEntry
defineSecureCRUD("FormEntry", "Form");
