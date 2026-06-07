/**
 * @plugin @zenith/erp-core (Open Source)
 *
 * ERP Core Plugin para Zenith Universal Business Backend.
 * Instala: GL, AR, AP, Inventario, Nómina.
 *
 * Uso:
 *   import { installERPPlugin } from "./plugins/erp.plugin.ts";
 *   installERPPlugin(Zen);
 */
import { ZenithErrors } from "../core/errors.ts";

export function installERPPlugin(Zen: any) {
  console.log("[ERP Plugin] 🏛️ Installing ERP Core plugin...");

  // ─── 1. Schemas ────────────────────────────────────────────────────────

  Zen.Cloud.defineSchema?.("Account", {
    code:              { type: "String",  required: true },
    name:              { type: "String",  required: true },
    type:              { type: "String",  required: true }, // asset|liability|equity|revenue|expense
    balance:           { type: "Number",  defaultValue: 0 },
    currency:          { type: "String",  defaultValue: "USD" },
    parentAccountCode: { type: "String" },
  });

  Zen.Cloud.defineSchema?.("JournalEntry", {
    date:        { type: "Date",   required: true },
    description: { type: "String", required: true },
    lines:       { type: "Array",  required: true }, // [{accountCode, debit, credit}]
    totalDebit:  { type: "Number", defaultValue: 0 },
    totalCredit: { type: "Number", defaultValue: 0 },
    status:      { type: "String", defaultValue: "draft" }, // draft|posted
    postedBy:    { type: "Pointer", targetClass: "_User" },
  });

  Zen.Cloud.defineSchema?.("Invoice", {
    number:     { type: "String",  required: true },
    customer:   { type: "Pointer", targetClass: "_User", required: true },
    lines:      { type: "Array",   required: true },
    subtotal:   { type: "Number",  defaultValue: 0 },
    tax:        { type: "Number",  defaultValue: 0 },
    total:      { type: "Number",  defaultValue: 0 },
    status:     { type: "String",  defaultValue: "draft" }, // draft|sent|paid|overdue
    dueDate:    { type: "Date" },
    paidAt:     { type: "Date" },
  });

  Zen.Cloud.defineSchema?.("PurchaseOrder", {
    number:      { type: "String", required: true },
    vendor:      { type: "String", required: true },
    lines:       { type: "Array",  required: true },
    total:       { type: "Number", defaultValue: 0 },
    status:      { type: "String", defaultValue: "draft" }, // draft|approved|received
    expectedAt:  { type: "Date" },
  });

  Zen.Cloud.defineSchema?.("Product", {
    sku:         { type: "String", required: true },
    name:        { type: "String", required: true },
    description: { type: "String" },
    salePrice:   { type: "Number", required: true },
    costPrice:   { type: "Number", defaultValue: 0 },
    stockQty:    { type: "Number", defaultValue: 0 },
    minStockQty: { type: "Number", defaultValue: 0 },
    category:    { type: "String", defaultValue: "general" },
    barcode:     { type: "String" },
    unit:        { type: "String", defaultValue: "unit" },
  });

  Zen.Cloud.defineSchema?.("Warehouse", {
    name:      { type: "String",  required: true },
    code:      { type: "String",  required: true },
    address:   { type: "String" },
    isDefault: { type: "Boolean", defaultValue: false },
  });

  Zen.Cloud.defineSchema?.("StockMovement", {
    product:       { type: "Pointer", targetClass: "Product",   required: true },
    fromWarehouse: { type: "Pointer", targetClass: "Warehouse" },
    toWarehouse:   { type: "Pointer", targetClass: "Warehouse" },
    quantity:      { type: "Number",  required: true },
    reason:        { type: "String",  defaultValue: "adjustment" }, // purchase|sale|transfer|adjustment|return
    reference:     { type: "String" },
  });

  Zen.Cloud.defineSchema?.("Employee", {
    name:       { type: "String", required: true },
    email:      { type: "String", required: true },
    role:       { type: "String", required: true },
    department: { type: "String", required: true },
    salary:     { type: "Number", required: true },
    currency:   { type: "String", defaultValue: "USD" },
    taxId:      { type: "String" },
    startDate:  { type: "Date",   required: true },
    status:     { type: "String", defaultValue: "active" }, // active|inactive
  });

  Zen.Cloud.defineSchema?.("PayrollRun", {
    period:      { type: "String", required: true }, // ej. "2026-06"
    employeeIds: { type: "Array" },
    lines:       { type: "Array" }, // [{employeeId, grossSalary, deductions, netSalary}]
    totalGross:  { type: "Number", defaultValue: 0 },
    totalNet:    { type: "Number", defaultValue: 0 },
    status:      { type: "String", defaultValue: "draft" }, // draft|approved|paid
  });

  // ─── 2. Cloud Functions ────────────────────────────────────────────────

  /**
   * Crea una factura con número secuencial y doble entrada contable automática.
   */
  Zen.Cloud.define("erp_createInvoice", async (request: any) => {
    const { customer, lines, dueDate } = request.params;
    if (!customer || !lines?.length) throw ZenithErrors.invalidRequest("customer and lines are required.");

    // Número secuencial
    const lastInvoice = await Zen.DB.find("Invoice", { order: "-createdAt", limit: 1 });
    const seq = lastInvoice.length > 0
      ? parseInt((lastInvoice[0].number ?? "INV-000").split("-")[1] ?? "0") + 1
      : 1;
    const number = `INV-${String(seq).padStart(5, "0")}`;

    // Calcular totales
    const subtotal = lines.reduce((sum: number, l: any) => sum + (l.qty * l.unitPrice), 0);
    const tax = parseFloat((subtotal * 0.16).toFixed(2));
    const total = parseFloat((subtotal + tax).toFixed(2));

    const invoice = await Zen.DB.insert("Invoice", {
      number, customer, lines, subtotal, tax, total,
      status: "draft",
      dueDate: dueDate ?? new Date(Date.now() + 30 * 86400000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Doble entrada contable automática: DR Accounts Receivable / CR Revenue
    await Zen.DB.insert("JournalEntry", {
      date: new Date().toISOString(),
      description: `Invoice ${number} — ${customer}`,
      lines: [
        { accountCode: "1100", description: "Accounts Receivable", debit: total, credit: 0 },
        { accountCode: "4000", description: "Sales Revenue",      debit: 0, credit: subtotal },
        { accountCode: "2300", description: "Sales Tax Payable",  debit: 0, credit: tax },
      ],
      totalDebit: total,
      totalCredit: total,
      status: "posted",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return { invoice };
  });

  /**
   * Cierra un JournalEntry en status 'posted'. Valida que débitos = créditos.
   */
  Zen.Cloud.define("erp_postJournalEntry", async (request: any) => {
    const { journalEntryId } = request.params;
    const entry = await Zen.DB.findOne("JournalEntry", { where: { objectId: journalEntryId } });
    if (!entry) throw ZenithErrors.notFound(`JournalEntry ${journalEntryId} not found.`);
    if (entry.status === "posted") throw ZenithErrors.invalidRequest("Entry already posted.");

    const totalDebit  = entry.lines.reduce((s: number, l: any) => s + (l.debit ?? 0), 0);
    const totalCredit = entry.lines.reduce((s: number, l: any) => s + (l.credit ?? 0), 0);

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw ZenithErrors.invalidRequest(`Journal entry is unbalanced: DR=${totalDebit} CR=${totalCredit}`);
    }

    await Zen.DB.update("JournalEntry", journalEntryId, { status: "posted", totalDebit, totalCredit });
    return { posted: true, totalDebit, totalCredit };
  });

  /**
   * Recibe una Purchase Order — crea StockMovement y actualiza stock.
   */
  Zen.Cloud.define("erp_receiveStockPO", async (request: any) => {
    const { purchaseOrderId, warehouseId } = request.params;
    const po = await Zen.DB.findOne("PurchaseOrder", { where: { objectId: purchaseOrderId } });
    if (!po) throw ZenithErrors.notFound(`PurchaseOrder ${purchaseOrderId} not found.`);
    if (po.status === "received") throw ZenithErrors.invalidRequest("PO already received.");

    const movements = [];
    for (const line of (po.lines ?? [])) {
      const product = await Zen.DB.findOne("Product", { where: { sku: line.sku } });
      if (!product) { console.warn(`[ERP] Product SKU ${line.sku} not found, skipping.`); continue; }

      const movement = await Zen.DB.insert("StockMovement", {
        product: { __type: "Pointer", className: "Product", objectId: product.objectId },
        toWarehouse: warehouseId ? { __type: "Pointer", className: "Warehouse", objectId: warehouseId } : undefined,
        quantity: line.qty,
        reason: "purchase",
        reference: po.number,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      movements.push(movement);

      await Zen.DB.update("Product", product.objectId, {
        stockQty: { __op: "Increment", amount: line.qty },
        updatedAt: new Date().toISOString(),
      });
    }

    await Zen.DB.update("PurchaseOrder", purchaseOrderId, { status: "received", updatedAt: new Date().toISOString() });
    return { received: true, movements: movements.length };
  });

  /**
   * Ejecuta la nómina para un período y lista de empleados.
   */
  Zen.Cloud.define("erp_runPayroll", async (request: any) => {
    const { period, employeeIds } = request.params;
    if (!period || !employeeIds?.length) throw ZenithErrors.invalidRequest("period and employeeIds are required.");

    const existing = await Zen.DB.findOne("PayrollRun", { where: { period } });
    if (existing) throw ZenithErrors.invalidRequest(`Payroll for period ${period} already exists.`);

    const lines = [];
    let totalGross = 0, totalNet = 0;

    for (const empId of employeeIds) {
      const emp = await Zen.DB.findOne("Employee", { where: { objectId: empId } });
      if (!emp || emp.status !== "active") continue;

      const grossSalary = emp.salary;
      // Deductions: 10% social security + 5% income tax (simplificado)
      const deductions = parseFloat((grossSalary * 0.15).toFixed(2));
      const netSalary  = parseFloat((grossSalary - deductions).toFixed(2));

      lines.push({ employeeId: empId, name: emp.name, grossSalary, deductions, netSalary });
      totalGross += grossSalary;
      totalNet   += netSalary;
    }

    const run = await Zen.DB.insert("PayrollRun", {
      period, employeeIds, lines,
      totalGross: parseFloat(totalGross.toFixed(2)),
      totalNet:   parseFloat(totalNet.toFixed(2)),
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return { run, linesCount: lines.length };
  });

  /**
   * Devuelve productos con stock por debajo del mínimo.
   */
  Zen.Cloud.define("erp_lowStockAlert", async (_request: any) => {
    const products = await Zen.DB.find("Product", { where: {} });
    const lowStock = products.filter((p: any) => (p.stockQty ?? 0) < (p.minStockQty ?? 0));
    return { lowStock, count: lowStock.length };
  });

  /**
   * Balance de comprobación: suma débitos y créditos por cuenta.
   */
  Zen.Cloud.define("erp_trialBalance", async (_request: any) => {
    const entries = await Zen.DB.find("JournalEntry", { where: { status: "posted" } });
    const accounts: Record<string, { debit: number; credit: number }> = {};

    for (const entry of entries) {
      for (const line of (entry.lines ?? [])) {
        if (!accounts[line.accountCode]) accounts[line.accountCode] = { debit: 0, credit: 0 };
        accounts[line.accountCode].debit  += line.debit  ?? 0;
        accounts[line.accountCode].credit += line.credit ?? 0;
      }
    }

    const rows = Object.entries(accounts).map(([code, { debit, credit }]) => ({
      code, debit: parseFloat(debit.toFixed(2)), credit: parseFloat(credit.toFixed(2)),
      balance: parseFloat((debit - credit).toFixed(2)),
    })).sort((a, b) => a.code.localeCompare(b.code));

    const totalDebit  = rows.reduce((s, r) => s + r.debit, 0);
    const totalCredit = rows.reduce((s, r) => s + r.credit, 0);

    return { rows, totalDebit: parseFloat(totalDebit.toFixed(2)), totalCredit: parseFloat(totalCredit.toFixed(2)), balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
  });

  // ─── 3. Triggers ──────────────────────────────────────────────────────

  /** Calcular totales de Invoice antes de guardar */
  Zen.Cloud.beforeSave("Invoice", async (request: any) => {
    const obj = request.object;
    if (obj.lines?.length) {
      const subtotal = obj.lines.reduce((s: number, l: any) => s + (l.qty * l.unitPrice), 0);
      obj.subtotal = parseFloat(subtotal.toFixed(2));
      obj.tax      = parseFloat((subtotal * 0.16).toFixed(2));
      obj.total    = parseFloat((subtotal + obj.tax).toFixed(2));
    }
  });

  /** Marcar paidAt cuando Invoice cambia a paid */
  Zen.Cloud.afterSave("Invoice", async (request: any) => {
    const obj = request.object;
    const original = request.original;
    if (obj.status === "paid" && original?.status !== "paid" && !obj.paidAt) {
      await Zen.DB.update("Invoice", obj.objectId, { paidAt: new Date().toISOString() });
    }
  });

  /** Actualizar stockQty después de StockMovement */
  Zen.Cloud.afterSave("StockMovement", async (request: any) => {
    const mov = request.object;
    if (!mov.product?.objectId) return;
    const diff = mov.reason === "sale" ? -Math.abs(mov.quantity) : Math.abs(mov.quantity);
    await Zen.DB.update("Product", mov.product.objectId, {
      stockQty: { __op: "Increment", amount: diff },
      updatedAt: new Date().toISOString(),
    });
  });

  console.log("[ERP Plugin] ✅ ERP Core installed: 9 schemas, 6 functions, 3 triggers.");
}
