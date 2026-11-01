/**
 * ERP Models Registry
 * Centraliza las definiciones de esquemas del ERP y su enrutamiento inteligente.
 */

export function registerERPModels(Zen: any) {
  // 1. Catálogo e Inventario (MongoDB)
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
    manager:   { type: "Pointer", targetClass: "_User" },
    isDefault: { type: "Boolean", defaultValue: false },
  });

  Zen.Cloud.defineSchema?.("Inventory", {
    product:   { type: "Pointer", targetClass: "Product", required: true },
    warehouse: { type: "Pointer", targetClass: "Warehouse", required: true },
    quantity:  { type: "Number", required: true }
  });

  // 2. Facturación y Órdenes (MongoDB)
  Zen.Cloud.defineSchema?.("Order", {
    type:        { type: "String", required: true }, // purchase | sale
    status:      { type: "String", defaultValue: "draft" },
    customer:    { type: "Pointer", targetClass: "_User" },
    supplier:    { type: "Pointer", targetClass: "_User" },
    items:       { type: "Array", required: true }, // [{product, qty, price}]
    total:       { type: "Number", defaultValue: 0 },
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

  Zen.Cloud.defineSchema?.("Payment", {
    amount:        { type: "Number", required: true },
    method:        { type: "String", required: true }, // bank_transfer|card|cash
    invoice:       { type: "Pointer", targetClass: "Invoice" },
    status:        { type: "String", defaultValue: "pending" }, // pending|completed|failed
    transactionId: { type: "String" }
  });

  Zen.Cloud.defineSchema?.("Employee", {
    name:       { type: "String", required: true },
    email:      { type: "String", required: true },
    role:       { type: "String", required: true },
    department: { type: "String", required: true },
    salary:     { type: "Number", required: true },
    currency:   { type: "String", defaultValue: "USD" },
    startDate:  { type: "Date",   required: true },
    status:     { type: "String", defaultValue: "active" }, // active|inactive
  });

  // 3. Streams de Auditoría (ScyllaDB Smart Routing)
  Zen.Cloud.defineSchema?.("ERP_Audit", {
    action:         { type: "String", required: true }, // INVOICE_PAID, STOCK_MOVED
    user:           { type: "Pointer", targetClass: "_User" },
    timestamp:      { type: "Date", required: true },
    previous_state: { type: "Object" },
    new_state:      { type: "Object" },
    referenceId:    { type: "String" }
  }, { "x-database": "scylla" } as any); // Hint para ScyllaDB Time-Series

}
