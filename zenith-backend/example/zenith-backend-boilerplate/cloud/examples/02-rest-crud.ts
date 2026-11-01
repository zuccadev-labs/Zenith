import { Zen } from "@zuccadev-labs/zenith";

/**
 * 02 — REST CRUD
 *
 * Operaciones CRUD completas sobre clases de Parse usando Zen.DB.
 * Demostración de create, read, update, delete con validaciones,
 * paginación, búsqueda y soft-delete.
 *
 * API usada:
 *   Zen.Cloud.define()
 *   Zen.DB.find() / findOne() / insert() / update() / delete()
 *   Zen.Cloud.beforeSave() / afterSave()
 *   Zen.Cloud.beforeDelete() / afterDelete()
 *   Zen.Cloud.beforeFind()
 */

const TODO_CLASS = "TodoItem";

// ─── Create ────────────────────────────────────────────────────────
Zen.Cloud.define("crud:create", async (req) => {
  const { className, data } = req.params;
  if (!className || !data) throw new Error("className y data son requeridos");

  const doc = {
    ...(data as Record<string, unknown>),
    _createdBy: req.user?.objectId || "anonymous",
    _createdAt: new Date().toISOString(),
    _deleted: false,
  };

  const result = await Zen.DB.insert(className as string, doc);
  return result;
});

// ─── Read (por ID) ────────────────────────────────────────────────
Zen.Cloud.define("crud:get", async (req) => {
  const { className, objectId } = req.params;
  if (!className || !objectId) throw new Error("className y objectId requeridos");

  const result = await Zen.DB.findOne(className as string, {
    where: { objectId, _deleted: { $ne: true } },
  });

  if (!result) throw new Error("Objeto no encontrado");
  return result;
});

// ─── Read (listar con filtros y paginación) ────────────────────────
Zen.Cloud.define("crud:list", async (req) => {
  const { className, where, order, limit = 50, skip = 0, include } = req.params;

  if (!className) throw new Error("className es requerido");

  const query: Record<string, unknown> = {
    where: { ...(where as Record<string, unknown> || {}), _deleted: { $ne: true } },
    limit: Math.min(limit as number, 100),
    skip: skip as number,
  };

  if (order) query.order = order;
  if (include) query.include = include;

  const results = await Zen.DB.find(className as string, query);

  // Count total (para paginación)
  const countResult = await Zen.DB.find(className as string, {
    where: query.where,
    limit: 0,
    count: true,
  });

  return {
    results,
    count: Array.isArray(countResult) ? countResult.length : 0,
    limit: query.limit,
    skip: query.skip,
  };
});

// ─── Update ────────────────────────────────────────────────────────
Zen.Cloud.define("crud:update", async (req) => {
  const { className, objectId, data } = req.params;
  if (!className || !objectId || !data) {
    throw new Error("className, objectId y data son requeridos");
  }

  const updateData = {
    ...(data as Record<string, unknown>),
    _updatedAt: new Date().toISOString(),
    _updatedBy: req.user?.objectId || "anonymous",
  };

  const result = await Zen.DB.update(className as string, objectId as string, updateData);
  return result;
});

// ─── Delete (soft-delete por defecto) ─────────────────────────────
Zen.Cloud.define("crud:delete", async (req) => {
  const { className, objectId, hardDelete = false } = req.params;
  if (!className || !objectId) throw new Error("className y objectId requeridos");

  if (hardDelete) {
    await Zen.DB.delete(className as string, objectId as string);
    return { deleted: true, hard: true };
  }

  await Zen.DB.update(className as string, objectId as string, {
    _deleted: true,
    _deletedAt: new Date().toISOString(),
    _deletedBy: req.user?.objectId || "anonymous",
  });
  return { deleted: true, hard: false };
});

// ─── Validaciones con Triggers ────────────────────────────────────

Zen.Cloud.beforeSave(TODO_CLASS, async (req) => {
  const { object, original, log } = req;

  if (!original && !object.get?.("title")) {
    throw new Error("El campo 'title' es requerido para crear un TodoItem");
  }

  if (object.get?.("priority")) {
    const valid = ["low", "medium", "high", "urgent"];
    if (!valid.includes(object.get("priority"))) {
      throw new Error(`Priority debe ser uno de: ${valid.join(", ")}`);
    }
  }

  if (object.get?.("dueDate") && new Date(object.get("dueDate")) < new Date()) {
    log.info("⚠️ Fecha de vencimiento en el pasado", { dueDate: object.get("dueDate") });
  }
});

Zen.Cloud.afterSave(TODO_CLASS, async (req) => {
  req.log.info("TodoItem guardado", {
    objectId: req.object.objectId,
    title: req.object.get?.("title"),
  });
});

Zen.Cloud.beforeFind(TODO_CLASS, async (req) => {
  if (!req.master && !req.user) {
    req.query._createdBy = { $in: [null, req.query._createdBy].filter(Boolean) };
  }
});

// ─── Batch operations ─────────────────────────────────────────────
Zen.Cloud.define("crud:batch", async (req) => {
  const { className, operations } = req.params;
  if (!className || !Array.isArray(operations)) {
    throw new Error("className y operations[] son requeridos");
  }

  const results: unknown[] = [];

  for (const op of operations as Array<{ method: string; objectId?: string; data?: Record<string, unknown> }>) {
    switch (op.method) {
      case "create":
        results.push(await Zen.DB.insert(className as string, { ...op.data, _createdBy: req.user?.objectId }));
        break;
      case "update":
        if (op.objectId) {
          results.push(await Zen.DB.update(className as string, op.objectId, op.data || {}));
        }
        break;
      case "delete":
        if (op.objectId) {
          await Zen.DB.update(className as string, op.objectId, { _deleted: true });
          results.push({ deleted: op.objectId });
        }
        break;
      default:
        results.push({ error: `Método desconocido: ${op.method}` });
    }
  }

  return { results };
});
