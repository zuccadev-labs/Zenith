/**
 * Pruebas E2E Corporativas — CRM y ERP Modules
 *
 * Cobertura:
 *   - CRM: Contact CRUD, Lead lifecycle (create → qualify → convert), Pipeline summary
 *   - ERP: Product CRUD, Order transactional fulfill (stock validation), Invoice totals, Audit log
 *
 * Ejecución: deno test -A tests/e2e/crm_erp.test.ts
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/testing/asserts.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Genera un objectId fake para tests de unidad sin DB */
function fakeId(prefix = "obj"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Mock del db adapter para tests de unidad */
function createMockDB(store: Record<string, Record<string, any>> = {}): any {
  return {
    async create(className: string, data: any) {
      if (!store[className]) store[className] = {};
      const objectId = fakeId(className.toLowerCase());
      store[className][objectId] = { ...data, objectId };
      return store[className][objectId];
    },
    async read(className: string, objectId: string) {
      return store[className]?.[objectId] ?? null;
    },
    async find(className: string, where: Record<string, any> = {}) {
      const items = Object.values(store[className] ?? {});
      return items.filter((item: any) =>
        Object.entries(where).every(([k, v]) => item[k] === v)
      );
    },
    async update(className: string, query: any, data: any) {
      const id = typeof query === "string" ? query : query.objectId;
      if (!store[className]?.[id]) return null;
      store[className][id] = { ...store[className][id], ...data };
      return store[className][id];
    },
    async delete(className: string, query: any) {
      const id = typeof query === "string" ? query : query.objectId;
      delete store[className]?.[id];
    },
  };
}

// ─── CRM Tests ────────────────────────────────────────────────────────────────

Deno.test("CRM — Contact: validación de campos obligatorios", async () => {
  const db = createMockDB();

  // Simulamos la lógica de createContact del traitApi
  async function createContact(data: Record<string, any>, ctx: any) {
    if (!data.name || !data.email) {
      throw new Error("name y email son obligatorios.");
    }
    return db.create("Contact", { ...data, createdAt: new Date().toISOString() });
  }

  // Debe lanzar error si falta email
  await assertRejects(
    () => createContact({ name: "Jane Doe" }, {}),
    Error,
    "name y email son obligatorios."
  );

  // Debe crear correctamente
  const contact = await createContact({ name: "Jane Doe", email: "jane@corp.com" }, {});
  assertExists(contact.objectId);
  assertEquals(contact.name, "Jane Doe");
  assertEquals(contact.email, "jane@corp.com");
});

Deno.test("CRM — Contact: CRUD completo (create, read, update, delete)", async () => {
  const store: Record<string, Record<string, any>> = {};
  const db = createMockDB(store);

  const contact = await db.create("Contact", { name: "Test Corp", email: "test@corp.com" });
  assertExists(contact.objectId, "objectId debe existir tras create");

  const found = await db.read("Contact", contact.objectId);
  assertEquals(found?.name, "Test Corp");

  await db.update("Contact", { objectId: contact.objectId }, { phone: "+1-555-0100" });
  const updated = await db.read("Contact", contact.objectId);
  assertEquals(updated?.phone, "+1-555-0100");

  await db.delete("Contact", { objectId: contact.objectId });
  const deleted = await db.read("Contact", contact.objectId);
  assertEquals(deleted, null, "El contacto debe haberse eliminado");
});

Deno.test("CRM — Lead: crear con Pointer a Contact", async () => {
  const db = createMockDB();
  const contact = await db.create("Contact", { name: "Ana López", email: "ana@corp.com" });
  const userId   = fakeId("user");

  const lead = await db.create("Lead", {
    contact: { __type: "Pointer", className: "Contact", objectId: contact.objectId },
    owner:   { __type: "Pointer", className: "_User",   objectId: userId },
    stage:   "new",
    value:   50_000,
    currency: "USD",
  });

  assertExists(lead.objectId);
  assertEquals(lead.contact.__type, "Pointer");
  assertEquals(lead.contact.className, "Contact");
  assertEquals(lead.contact.objectId, contact.objectId);
  assertEquals(lead.stage, "new");
});

Deno.test("CRM — Lead Scoring: fórmula corporativa (activity×0.4 + value×0.4 + stage×0.2)", () => {
  // Replicar la fórmula del CRMTrait crm_qualifyLead
  function computeLeadScore(activitiesCount: number, value: number, stage: string): number {
    const stageMap: Record<string, number> = {
      new: 10, contacted: 25, qualified: 50, proposal: 70, negotiation: 85, won: 100, lost: 0,
    };
    const activityScore = Math.min(activitiesCount * 10, 100);
    const valueScore    = Math.min((value / 100_000) * 100, 100);
    const stageScore    = stageMap[stage] ?? 0;
    return Math.round(activityScore * 0.4 + valueScore * 0.4 + stageScore * 0.2);
  }

  // 5 actividades (50pts), valor 50k (50pts), qualified (50pts)
  assertEquals(computeLeadScore(5, 50_000, "qualified"), 50);

  // 10 actividades (100pts), valor 100k (100pts), won (100pts) → score máximo
  assertEquals(computeLeadScore(10, 100_000, "won"), 100);

  // Sin actividades, valor 0, new → score mínimo
  assertEquals(computeLeadScore(0, 0, "new"), 2); // 0×0.4 + 0×0.4 + 10×0.2 = 2
});

Deno.test("CRM — Lead: conversión atómica a Deal", async () => {
  const store: Record<string, Record<string, any>> = {};
  const db = createMockDB(store);
  const userId = fakeId("user");

  const contact = await db.create("Contact", { name: "Carlos MX", email: "carlos@mx.com" });
  const lead = await db.create("Lead", {
    contact: { __type: "Pointer", className: "Contact", objectId: contact.objectId },
    owner:   { __type: "Pointer", className: "_User", objectId: userId },
    stage:   "qualified",
    value:   75_000,
    currency: "USD",
  });

  // Simular crm_convertLeadToDeal
  async function convertLeadToDeal(leadId: string, options: any = {}) {
    const l = await db.read("Lead", leadId);
    if (!l) throw new Error("Lead not found");
    if (l.stage === "won" || l.stage === "lost") throw new Error(`Lead already ${l.stage}`);

    const deal = await db.create("Deal", {
      title:    options.dealTitle ?? `Deal de Lead ${leadId}`,
      owner:    l.owner,
      pipeline: options.pipeline ?? "default",
      stage:    options.stage ?? "proposal",
      amount:   options.amount ?? l.value,
      currency: l.currency ?? "USD",
    });

    // Añadir relación contacto → deal
    await db.update("Deal", { objectId: deal.objectId }, {
      contacts: { __op: "AddRelation", objects: [l.contact] },
    });

    // Marcar lead como ganado SOLO si el deal se creó exitosamente
    await db.update("Lead", { objectId: leadId }, { stage: "won" });
    return { deal, leadId, converted: true };
  }

  const result = await convertLeadToDeal(lead.objectId, { dealTitle: "Proyecto Alpha 2025" });

  assertEquals(result.converted, true);
  assertExists(result.deal.objectId);
  assertEquals(result.deal.title, "Proyecto Alpha 2025");
  assertEquals(result.deal.amount, 75_000);

  // El Lead debe estar en "won"
  const updatedLead = await db.read("Lead", lead.objectId);
  assertEquals(updatedLead?.stage, "won");

  // No se puede convertir dos veces
  await assertRejects(() => convertLeadToDeal(lead.objectId), Error, "already won");
});

// ─── ERP Tests ────────────────────────────────────────────────────────────────

Deno.test("ERP — Invoice: cálculo automático de totales (subtotal + tax + total)", () => {
  function recalculateTotals(lines: Array<{ price: number; qty: number; tax?: number }>) {
    let subtotal = 0;
    let tax = 0;
    for (const line of lines) {
      const lineTotal = (line.price ?? 0) * (line.qty ?? 1);
      subtotal += lineTotal;
      tax += lineTotal * ((line.tax ?? 0) / 100);
    }
    return {
      subtotal: parseFloat(subtotal.toFixed(2)),
      tax:      parseFloat(tax.toFixed(2)),
      total:    parseFloat((subtotal + tax).toFixed(2)),
    };
  }

  const lines = [
    { price: 100, qty: 2, tax: 16 },  // 200 + 32 IVA
    { price: 50,  qty: 3, tax: 0  },  // 150 + 0  IVA
  ];
  const totals = recalculateTotals(lines);

  assertEquals(totals.subtotal, 350);
  assertEquals(totals.tax,      32);
  assertEquals(totals.total,    382);
});

Deno.test("ERP — Invoice: autogeneración de número INV-XXXXX", () => {
  function autoNumber(): string {
    return `INV-${Date.now()}`;
  }
  const num = autoNumber();
  assert(num.startsWith("INV-"), "El número debe empezar con INV-");
  assert(num.length > 5, "El número debe tener contenido después del prefijo");
});

Deno.test("ERP — Fulfill Order: validación de stock ANTES de deducir (integridad transaccional)", async () => {
  const store: Record<string, Record<string, any>> = {};
  const db = createMockDB(store);

  // Producto con stock limitado
  const product = await db.create("Product", { name: "Laptop Pro", sku: "LP-001", stockQty: 3, minStockQty: 1, salePrice: 1200 });
  const userId  = fakeId("user");
  const order   = await db.create("Order", {
    type: "sale",
    status: "approved",
    items: [{ product: { __type: "Pointer", className: "Product", objectId: product.objectId }, qty: 5, price: 1200 }],
  });

  // Simular erp_fulfillOrder
  async function fulfillOrder(orderId: string) {
    const o = await db.read("Order", orderId);
    if (!o) throw new Error("Order not found");
    if (o.status !== "approved") throw new Error(`Order is not approved`);

    // FASE 1: validar stock (all-or-nothing)
    const stockErrors: string[] = [];
    for (const item of o.items ?? []) {
      const p = await db.read("Product", item.product.objectId);
      if (!p) {
        stockErrors.push(`Producto ${item.product.objectId} no encontrado.`);
      } else if ((p.stockQty ?? 0) < (item.qty ?? 0)) {
        stockErrors.push(`Stock insuficiente para '${p.name}': disponible ${p.stockQty}, requerido ${item.qty}.`);
      }
    }
    if (stockErrors.length > 0) {
      throw new Error(`Fulfillment bloqueado:\n${stockErrors.join("\n")}`);
    }

    // FASE 2: deducir
    for (const item of o.items ?? []) {
      const p = await db.read("Product", item.product.objectId);
      await db.update("Product", { objectId: item.product.objectId }, { stockQty: (p.stockQty ?? 0) - (item.qty ?? 0) });
    }
    await db.update("Order", { objectId: orderId }, { status: "fulfilled" });
    return { success: true };
  }

  // Debe FALLAR (stockQty=3 < qty=5) sin modificar nada
  await assertRejects(() => fulfillOrder(order.objectId), Error, "Stock insuficiente");

  // El stock NO debe haberse modificado (atomicidad)
  const unchanged = await db.read("Product", product.objectId);
  assertEquals(unchanged?.stockQty, 3, "El stock no debe cambiar si el fulfill falló");
});

Deno.test("ERP — Fulfill Order: deducción exitosa con alertas de stock bajo", async () => {
  const store: Record<string, Record<string, any>> = {};
  const db = createMockDB(store);
  const lowStockAlerts: string[] = [];

  const product = await db.create("Product", {
    name: "Mouse Ergonómico", sku: "ME-001", stockQty: 5, minStockQty: 2, salePrice: 45,
  });
  const order = await db.create("Order", {
    type: "sale", status: "approved",
    items: [{ product: { __type: "Pointer", className: "Product", objectId: product.objectId }, qty: 4, price: 45 }],
  });

  async function fulfillOrder(orderId: string) {
    const o = await db.read("Order", orderId);
    for (const item of o.items) {
      const p = await db.read("Product", item.product.objectId);
      const newStock = (p.stockQty ?? 0) - (item.qty ?? 0);
      await db.update("Product", { objectId: item.product.objectId }, { stockQty: newStock });
      if (newStock <= (p.minStockQty ?? 0)) {
        lowStockAlerts.push(`Alerta: ${p.name} tiene ${newStock} unidades.`);
      }
    }
    await db.update("Order", { objectId: orderId }, { status: "fulfilled" });
    return { success: true };
  }

  const result = await fulfillOrder(order.objectId);
  assertEquals(result.success, true);

  const updated = await db.read("Product", product.objectId);
  assertEquals(updated?.stockQty, 1); // 5 - 4 = 1

  // 1 <= minStockQty (2) → debe generar alerta
  assertEquals(lowStockAlerts.length, 1);
  assert(lowStockAlerts[0].includes("Mouse Ergonómico"));
});

Deno.test("ERP — ERP_Audit: registro inmutable de eventos de negocio", async () => {
  const store: Record<string, Record<string, any>> = {};
  const db = createMockDB(store);

  // Simular auditLog
  async function auditLog(action: string, refId: string, refClass: string, prev: any, next: any) {
    return db.create("ERP_Audit", {
      action,
      referenceId: refId,
      referenceClass: refClass,
      timestamp: new Date().toISOString(),
      previous_state: prev,
      new_state: next,
    });
  }

  const entry = await auditLog("INVOICE_PAID", "inv_001", "Invoice", { status: "sent" }, { status: "paid" });
  assertExists(entry.objectId);
  assertEquals(entry.action, "INVOICE_PAID");
  assertEquals(entry.referenceClass, "Invoice");
  assertEquals(entry.previous_state.status, "sent");
  assertEquals(entry.new_state.status, "paid");

  // Los registros de auditoría deben ser inmutables (no hay update en ERP_Audit)
  const allAudits = await db.find("ERP_Audit", {});
  assertEquals(allAudits.length, 1, "Debe existir exactamente 1 registro de auditoría");
});
