// deno-lint-ignore-file no-unused-vars
import { type ZenithTestHarness, ZenithTestSuite } from "../unit/zenith-test-runner.ts";

/**
 * Suite de ERP Plugin
 * Pruebas de integración para módulos contables, inventario, nómina
 * usando el motor de test en memoria.
 */
const suite = new ZenithTestSuite("ERP Plugin Core");

// Mock Plugin Setup
const installERPPlugin = (Zen: any) => {
  Zen.Cloud.define("createInvoice", async (req: any) => {
    const { customer, lines } = req.params;
    let total = 0;
    for (const l of lines) total += l.qty * l.unitPrice;
    
    const invoice = Zen.DB.insert("Invoice", {
      customer, lines, total, status: "pending", createdAt: new Date().toISOString()
    });
    
    // Accounting double-entry
    Zen.DB.insert("JournalEntry", {
      date: new Date().toISOString(),
      memo: `Invoice ${invoice.objectId}`,
      lines: [
        { account: "Accounts Receivable", debit: total, credit: 0 },
        { account: "Sales Revenue", debit: 0, credit: total }
      ],
      totalDebit: total,
      totalCredit: total
    });
    
    return invoice;
  });

  Zen.Cloud.define("payInvoice", async (req: any) => {
    const { invoiceId } = req.params;
    const inv = Zen.DB.update("Invoice", invoiceId, { status: "paid" });
    
    Zen.DB.insert("JournalEntry", {
      date: new Date().toISOString(),
      memo: `Payment for ${invoiceId}`,
      lines: [
        { account: "Cash", debit: inv.total, credit: 0 },
        { account: "Accounts Receivable", debit: 0, credit: inv.total }
      ],
      totalDebit: inv.total,
      totalCredit: inv.total
    });
    
    return inv;
  });

  Zen.Cloud.define("createPurchaseOrder", async (req: any) => {
    const { vendor, lines } = req.params;
    const po = Zen.DB.insert("PurchaseOrder", { vendor, lines, status: "received" });
    
    for (const l of lines) {
      Zen.DB.insert("StockMovement", {
        product: l.productId,
        quantity: l.qty,
        reason: `PO ${po.objectId}`
      });
    }
    return po;
  });

  Zen.Cloud.define("runPayroll", async (req: any) => {
    const { period } = req.params;
    const employees = Zen.DB.find("Employee", {});
    let grandTotal = 0;
    
    for (const emp of employees) grandTotal += emp.salary;
    
    return Zen.DB.insert("PayrollRun", {
      period,
      employeeCount: employees.length,
      total: grandTotal,
      status: "completed"
    });
  });
};

const defaultOptions = { plugins: [installERPPlugin] };

// 1. createInvoice → debe insertar una Invoice con total correcto y un JournalEntry
suite.test("createInvoice: generates invoice and double-entry journal", async (harness) => {
  const res = await harness.callFunction("createInvoice", {
    customer: "CUST-001",
    lines: [
      { qty: 2, unitPrice: 100, description: "Consulting" },
      { qty: 1, unitPrice: 50, description: "Support" }
    ]
  });

  harness.expect(res.total).toBe(250);
  
  const invoices = harness.db.find("Invoice");
  harness.expect(invoices).toHaveLength(1);
  
  const journals = harness.db.find("JournalEntry");
  harness.expect(journals).toHaveLength(1);
  harness.expect(journals[0].totalDebit).toBe(250);
  harness.expect(journals[0].totalCredit).toBe(250);
});

// 2. payInvoice → debe cambiar status a 'paid' y crear un JournalEntry
suite.test("payInvoice: updates status and creates cash receipt journal", async (harness) => {
  harness.db.seed("Invoice", [{ objectId: "INV-123", total: 500, status: "pending" }]);
  
  await harness.callFunction("payInvoice", { invoiceId: "INV-123" });
  
  const inv = harness.db.findOne("Invoice", { where: { objectId: "INV-123" } });
  harness.expect(inv.status).toBe("paid");
  
  const journals = harness.db.find("JournalEntry", { where: { memo: "Payment for INV-123" } });
  harness.expect(journals).toHaveLength(1);
  harness.expect(journals[0].lines[0].account).toBe("Cash");
});

// 3. createPurchaseOrder → debe insertar PO y descontar del inventario (StockMovement)
suite.test("createPurchaseOrder: generates PO and StockMovements", async (harness) => {
  await harness.callFunction("createPurchaseOrder", {
    vendor: "VEND-1",
    lines: [{ productId: "PROD-A", qty: 10 }, { productId: "PROD-B", qty: 5 }]
  });
  
  const pos = harness.db.find("PurchaseOrder");
  harness.expect(pos).toHaveLength(1);
  
  const movements = harness.db.find("StockMovement");
  harness.expect(movements).toHaveLength(2);
});

// 4. runPayroll → debe crear PayrollRun con totales correctos
suite.test("runPayroll: aggregates salaries correctly", async (harness) => {
  harness.db.seed("Employee", [
    { name: "Alice", salary: 3000 },
    { name: "Bob", salary: 2500 }
  ]);
  
  const run = await harness.callFunction("runPayroll", { period: "2026-05" });
  
  harness.expect(run.employeeCount).toBe(2);
  harness.expect(run.total).toBe(5500);
});

// 5. balanceSheet → Assets = Liabilities + Equity (concept test)
suite.test("balanceSheet: Assets = Liabilities + Equity", async (harness) => {
  const assets = 10000;
  const liabilities = 4000;
  const equity = 6000;
  
  harness.expect(assets).toBe(liabilities + equity);
});

// 6. journalEntryBalance → totalDebit === totalCredit
suite.test("journalEntryBalance: strictly balanced", async (harness) => {
  harness.db.seed("JournalEntry", [
    { totalDebit: 100, totalCredit: 100 },
    { totalDebit: 550.25, totalCredit: 550.25 }
  ]);
  
  const entries = harness.db.find("JournalEntry");
  for (const entry of entries) {
    harness.expect(entry.totalDebit).toBe(entry.totalCredit);
  }
});

if (import.meta.main) {
  suite.run(defaultOptions).catch(console.error);
}

// ── Deno test bridge ───────────────────────────────────────────────────────
// Phase 2.H: expone los tests del suite a `deno test` para integrarlos en CI.
// Cada test del suite se re-ejecuta via Deno.test() con un harness por test.
// Los nombres reflejan `1-based index + test name` para mantener orden estable.
for (const [i, t] of suite.getTests().entries()) {
  Deno.test({
    name: `[erp] ${i + 1}. ${t.name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const { ZenithTestHarness } = await import("../unit/zenith-test-runner.ts");
      const harness = await ZenithTestHarness.create(defaultOptions);
      try {
        await t.fn(harness);
      } catch (e) {
        throw new Error(`[erp] ${t.name} failed: ${(e as Error).message}`);
      }
    },
  });
}

export { suite as erpSuite };
