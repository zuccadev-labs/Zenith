/**
 * In-memory db with the calls of the common `db` layer that the outbox, the queue, webhooks and hooks
 * use: find/read/create/update/updateIf/upsert/delete, with top-level equality filters (a missing field
 * equals null, as in MongoDB). Shared by the unit tests.
 */
export function fakeDb() {
  const rows: Record<string, Record<string, any>[]> = {};
  let seq = 0;
  const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const match = (r: Record<string, any>, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => eq(r[k], v));
  const table = (c: string) => (rows[c] ??= []);
  const db = {
    rows,
    find: async (c: string, where: Record<string, unknown> = {}) => table(c).filter((r) => match(r, where)).map((r) => structuredClone(r)),
    read: async (c: string, id: string) => structuredClone(table(c).find((r) => r.objectId === id) ?? null),
    create: async (c: string, data: Record<string, any>) => {
      const row = { ...structuredClone(data), objectId: `o${++seq}`, createdAt: new Date(Date.now() + seq).toISOString() };
      table(c).push(row);
      return structuredClone(row);
    },
    update: async (c: string, where: { objectId: string }, data: Record<string, any>) => {
      const r = table(c).find((x) => x.objectId === where.objectId);
      if (r) Object.assign(r, structuredClone(data));
      return structuredClone(r);
    },
    updateIf: async (c: string, id: string, cond: Record<string, unknown>, data: Record<string, any>) => {
      const r = table(c).find((x) => x.objectId === id);
      if (!r || !match(r, cond)) return null;
      Object.assign(r, structuredClone(data));
      return structuredClone(r);
    },
    upsert: async (c: string, where: Record<string, unknown>, data: Record<string, any>) => {
      const r = table(c).find((x) => match(x, where));
      if (r) return Object.assign(r, structuredClone(data));
      return await db.create(c, { ...where, ...data });
    },
    delete: async (c: string, where: { objectId: string }) => {
      rows[c] = table(c).filter((r) => r.objectId !== where.objectId);
    },
  };
  return db;
}
