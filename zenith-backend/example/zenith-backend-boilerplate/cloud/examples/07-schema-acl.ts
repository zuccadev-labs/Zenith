import { Zen } from "@zuccadev-labs/zenith";

/**
 * 07 — Schema & ACL Management
 *
 * Gestión de esquemas de clases y control de acceso por ACLs.
 * Creación dinámica de clases, validación de campos, y políticas
 * de seguridad a nivel de objeto con herencia de roles.
 *
 * API usada:
 *   Zen.Cloud.define()
 *   Zen.DB.*
 *   Zen.Cloud.beforeSave()      — enforce ACL write
 *   Zen.Cloud.beforeFind()      — enforce ACL read
 *   Zen.Cloud.afterFind()       — filtrar resultados post-query
 *   Zen.Logger
 */

// ─── Crear clase dinámicamente ────────────────────────────────────
Zen.Cloud.define("schema:create-class", async (req) => {
  const { className, fields = {}, classLevelPermissions } = req.params;
  if (!className) throw new Error("className es requerido");

  if (!req.master) {
    throw new Error("Solo master key puede crear esquemas");
  }

  const existing = await Zen.DB.find("_SCHEMA", {
    where: { className },
  });

  if (existing.length > 0) {
    throw new Error(`La clase '${className}' ya existe`);
  }

  const schema = await Zen.DB.insert("_SCHEMA", {
    className,
    fields: {
      objectId: { type: "String" },
      createdAt: { type: "Date" },
      updatedAt: { type: "Date" },
      ACL: { type: "ACL" },
      ...(fields as Record<string, unknown>),
    },
    classLevelPermissions: classLevelPermissions || {
      find: { "*": true },
      get: { "*": true },
      create: { "*": true },
      update: { "*": true },
      delete: { "*": true },
      protectedFields: {},
    },
  });

  Zen.Logger.info("Clase creada", { className, schemaId: schema.objectId });
  return schema;
});

// ─── Listar esquemas ──────────────────────────────────────────────
Zen.Cloud.define("schema:list", async (req) => {
  const schemas = await Zen.DB.find("_SCHEMA", {});
  return schemas.map((s: Record<string, unknown>) => ({
    className: s.className,
    fields: Object.keys(s.fields as Record<string, unknown> || {}),
    createdAt: s.createdAt,
  }));
});

// ─── Enforce ACL en escritura (beforeSave) ────────────────────────
Zen.Cloud.beforeSave("SecureDocument", async (req) => {
  const { object, original, user, master } = req;

  if (master) return;

  if (!original && !user) {
    throw new Error("Debes iniciar sesión para crear documentos");
  }

  if (original) {
    const originalACL = original.get?.("ACL") as Record<string, unknown> | undefined;
    if (originalACL) {
      const wperm = originalACL._wperm || [];
      const userId = user?.objectId;
      if (wperm.length > 0 && !wperm.includes("*") && !wperm.includes(userId)) {
        throw new Error("No tienes permisos de escritura sobre este documento");
      }
    }
  }

  // Asignar ACL por defecto si no se especifica
  if (!object.get?.("ACL") && user) {
    object.set?.("ACL", {
      _rperm: ["*", user.objectId],
      _wperm: [user.objectId],
    });
  }
});

// ─── Enforce ACL en lectura (beforeFind) ──────────────────────────
Zen.Cloud.beforeFind("SecureDocument", async (req) => {
  if (req.master) return;

  const userId = req.user?.objectId;
  const query = req.query;

  query.$or = [
    { "ACL": { $exists: false } },
    { "ACL._rperm": { $in: ["*"] } },
    ...(userId ? [{ "ACL._rperm": userId }] : []),
    ...(userId ? [{ "ACL._wperm": userId }] : []),
    { "ACL._rperm": { $regex: `^role:` } },
  ];
});

// ─── Clasificar resultados post-query (afterFind) ─────────────────
Zen.Cloud.afterFind("SecureDocument", async (req) => {
  const { objects, log } = req;

  // Marcar objetos accesibles para el frontend
  return objects.map((obj: Record<string, unknown>) => ({
    ...obj,
    _aclSummary: obj.ACL ? "restricted" : "public",
    ACL: undefined, // Ocultar ACL al cliente
  }));
});

// ─── Asignar rol a usuario ────────────────────────────────────────
Zen.Cloud.define("acl:assign-role", async (req) => {
  const { userId, role } = req.params;
  if (!userId || !role) throw new Error("userId y role requeridos");

  if (!req.master) {
    throw new Error("Solo master key puede asignar roles");
  }

  const roles = await Zen.DB.find("_Role", {
    where: { name: role },
  });

  if (roles.length === 0) {
    await Zen.DB.insert("_Role", {
      name: role,
      users: [{ objectId: userId }],
    });
  } else {
    const existingUsers = roles[0].users || [];
    const alreadyAssigned = existingUsers.some(
      (u: { objectId: string }) => u.objectId === userId,
    );

    if (!alreadyAssigned) {
      await Zen.DB.update("_Role", roles[0].objectId, {
        users: [...existingUsers, { objectId: userId }],
      });
    }
  }

  Zen.Logger.info("Rol asignado", { userId, role });
  return { assigned: true, userId, role };
});

// ─── Verificar permisos de un usuario ─────────────────────────────
Zen.Cloud.define("acl:check-permission", async (req) => {
  const { userId, objectId } = req.params;
  if (!userId || !objectId) throw new Error("userId y objectId requeridos");

  const docs = await Zen.DB.findOne("SecureDocument", {
    where: { objectId },
  });

  if (!docs) throw new Error("Documento no encontrado");

  const acl = docs.ACL as Record<string, unknown> || {};
  const rperm = (acl._rperm || []) as string[];
  const wperm = (acl._wperm || []) as string[];

  return {
    canRead: rperm.includes("*") || rperm.includes(userId as string),
    canWrite: wperm.includes("*") || wperm.includes(userId as string),
    objectId,
  };
});
