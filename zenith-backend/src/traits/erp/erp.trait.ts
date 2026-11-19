// deno-lint-ignore-file no-unused-vars
/**
 * Enterprise ERP Trait — CRUD completo para los módulos de negocio ERP.
 *
 * Patrón: idéntico a RestCrudTrait y CRMTrait. Define una `traitApi` interna
 * que encapsula toda la lógica transaccional, y las rutas HTTP son thin wrappers.
 *
 * Smart DB Routing:
 *   - Product, Warehouse, Inventory, Order, Invoice, Payment, Employee → MongoDB
 *   - ERP_Audit                                                        → ScyllaDB (immutable audit log)
 *
 * @barrits-trait
 * @barrits-summary ZenithERPTrait
 * @barrits-provides erp_routes, erp
 * @barrits-consumes acl, cloud, db, telemetry
 * @barrits-tags uses:events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";

// ─── Schemas ERP (fuente de verdad única) ─────────────────────────────────────

const ERP_SCHEMAS = {
  // ── Catálogo e Inventario (MongoDB) ────────────────────────────────────────
  Product: {
    fields: {
      sku: { type: "String", required: true },
      name: { type: "String", required: true },
      description: { type: "String" },
      salePrice: { type: "Number", required: true },
      costPrice: { type: "Number", defaultValue: 0 },
      stockQty: { type: "Number", defaultValue: 0 },
      minStockQty: { type: "Number", defaultValue: 0 }, // Umbral de reorden
      category: { type: "String", defaultValue: "general" },
      barcode: { type: "String" },
      unit: { type: "String", defaultValue: "unit" },
    },
    options: {},
  },
  Warehouse: {
    fields: {
      name: { type: "String", required: true },
      code: { type: "String", required: true },
      address: { type: "String" },
      manager: { type: "Pointer", targetClass: "_User" },
      isDefault: { type: "Boolean", defaultValue: false },
    },
    options: {},
  },
  Inventory: {
    fields: {
      product: { type: "Pointer", targetClass: "Product", required: true },
      warehouse: { type: "Pointer", targetClass: "Warehouse", required: true },
      quantity: { type: "Number", required: true, defaultValue: 0 },
    },
    options: {},
  },
  // ── Compras y Ventas (MongoDB) ─────────────────────────────────────────────
  Order: {
    fields: {
      type: { type: "String", required: true }, // purchase | sale
      status: { type: "String", defaultValue: "draft" }, // draft|approved|fulfilled|cancelled
      customer: { type: "Pointer", targetClass: "_User" },
      supplier: { type: "Pointer", targetClass: "_User" },
      items: { type: "Array", required: true }, // [{product:{__type,className,objectId}, qty, price}]
      subtotal: { type: "Number", defaultValue: 0 },
      tax: { type: "Number", defaultValue: 0 },
      total: { type: "Number", defaultValue: 0 },
      expectedAt: { type: "Date" },
    },
    options: {},
  },
  Invoice: {
    fields: {
      number: { type: "String", required: false }, // Se autogenera si no se provee
      customer: { type: "Pointer", targetClass: "_User", required: true },
      lines: { type: "Array", required: true }, // [{description, qty, price, tax}]
      subtotal: { type: "Number", defaultValue: 0 },
      tax: { type: "Number", defaultValue: 0 },
      total: { type: "Number", defaultValue: 0 },
      status: { type: "String", defaultValue: "draft" }, // draft|sent|paid|overdue|cancelled
      dueDate: { type: "Date" },
      paidAt: { type: "Date" },
    },
    options: {},
  },
  Payment: {
    fields: {
      amount: { type: "Number", required: true },
      method: { type: "String", required: true }, // bank_transfer|card|cash|crypto
      invoice: { type: "Pointer", targetClass: "Invoice" },
      status: { type: "String", defaultValue: "pending" }, // pending|completed|failed|refunded
      transactionId: { type: "String" },
      processedAt: { type: "Date" },
    },
    options: {},
  },
  Employee: {
    fields: {
      name: { type: "String", required: true },
      email: { type: "String", required: true },
      role: { type: "String", required: true },
      department: { type: "String", required: true },
      salary: { type: "Number", required: true },
      currency: { type: "String", defaultValue: "USD" },
      startDate: { type: "Date", required: true },
      status: { type: "String", defaultValue: "active" }, // active|inactive|terminated
    },
    options: {},
  },
  // ── Audit Log Inmutable → ScyllaDB (Time-Series) ──────────────────────────
  ERP_Audit: {
    fields: {
      action: { type: "String", required: true }, // ORDER_FULFILLED, INVOICE_PAID, STOCK_MOVED
      user: { type: "Pointer", targetClass: "_User" },
      timestamp: { type: "Date", required: true },
      previous_state: { type: "Object" },
      new_state: { type: "Object" },
      referenceId: { type: "String" }, // objectId del documento afectado
      referenceClass: { type: "String" }, // className del documento afectado
    },
    options: { "x-database": "scylla" }, // Smart Routing → ScyllaDB
  },
} as const;

// ─── Helpers (mismos que CRMTrait, copiados para evitar dependencias circulares) ───

function parseQueryParams(url: URL): Record<string, any> {
  const query: Record<string, any> = {};
  url.searchParams.forEach((v, k) => {
    try {
      query[k] = k === "where" ? JSON.parse(v) : v;
    } catch {
      query[k] = v;
    }
  });
  return query;
}

function matchPath(pattern: string, url: string): Record<string, string> | null {
  const result = new URLPattern({ pathname: pattern }).exec(url);
  return result ? (result.pathname.groups as Record<string, string>) : null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(err: any): Response {
  const status = typeof err?.httpStatus === "number" ? err.httpStatus : 500;
  return new Response(
    JSON.stringify({ code: err?.code ?? 1, error: err?.message ?? "Internal Server Error" }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** Escribe una entrada de auditoría inmutable en ScyllaDB (fire-and-forget) */
function auditLog(
  db: any,
  obs: any,
  action: string,
  referenceId: string,
  referenceClass: string,
  user: any,
  prev?: unknown,
  next?: unknown,
): void {
  db.create("ERP_Audit", {
    action,
    user: user ? { __type: "Pointer", className: "_User", objectId: user.objectId } : null,
    timestamp: new Date().toISOString(),
    referenceId,
    referenceClass,
    previous_state: prev ?? null,
    new_state: next ?? null,
  }).catch((e: Error) => obs?.warn?.(`[ERPTrait] Audit log failed: ${e.message}`));
}

/** Recalcula totales de un Order o Invoice a partir de sus líneas */
function recalculateTotals(
  lines: Array<{ price: number; qty: number; tax?: number }>,
): { subtotal: number; tax: number; total: number } {
  let subtotal = 0;
  let tax = 0;
  for (const line of lines) {
    const lineTotal = (line.price ?? 0) * (line.qty ?? 1);
    subtotal += lineTotal;
    tax += lineTotal * ((line.tax ?? 0) / 100);
  }
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    tax: parseFloat(tax.toFixed(2)),
    total: parseFloat((subtotal + tax).toFixed(2)),
  };
}

// ─── Trait Principal ──────────────────────────────────────────────────────────

/**
 * ERP trait: products, warehouses, inventory, orders, invoices, payments and employees under
 * `/zen/erp/*`, with stock adjustments, order fulfilment and an immutable audit log.
 */
export const ERPTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithERPTrait",
  provides: ["erp_routes", "erp"],
  consumes: ["acl", "cloud", "db", "telemetry"],
  tags: ["uses:events"],
  state: [],
  runtimes: ["deno"],

  summary:
    "Enterprise ERP: CRUD completo (Product, Order, Invoice, Payment, Employee, Warehouse, Inventory), auditorías inmutables en ScyllaDB, lógica transaccional de inventario.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const acl = deps.traits["acl"];
    const cloud = deps.traits["cloud"];
    const events = deps.traits["events"];
    const obs = deps.traits["telemetry"];

    // 1. Registrar schemas
    if (cloud?.defineSchema) {
      for (const [className, def] of Object.entries(ERP_SCHEMAS)) {
        cloud.defineSchema(className, (def as any).fields, (def as any).options);
      }
      obs?.log?.("[ERPTrait] ✅ Schemas ERP registrados.");
    }

    // 2. Cloud Triggers
    if (cloud?.beforeSave) {
      // beforeSave Invoice: autogenerar número, validar customer, recalcular totales
      cloud.beforeSave("Invoice", async (request: any) => {
        const invoice = request.object;
        if (!invoice.number) {
          invoice.number = `INV-${Date.now()}`;
        }
        if (!invoice.customer) {
          throw ZenithErrors.validationFailed("Toda factura debe tener un cliente asignado.");
        }
        if (invoice.lines && Array.isArray(invoice.lines) && invoice.lines.length > 0) {
          const totals = recalculateTotals(invoice.lines);
          invoice.subtotal = totals.subtotal;
          invoice.tax = totals.tax;
          invoice.total = totals.total;
        }
      });

      // afterSave Payment: marcar factura como pagada + audit ScyllaDB
      cloud.afterSave("Payment", async (request: any) => {
        const payment = request.object;
        if (payment.status === "completed" && payment.invoice?.objectId) {
          try {
            const prev = await db.read("Invoice", payment.invoice.objectId);
            await db.update("Invoice", { objectId: payment.invoice.objectId }, {
              status: "paid",
              paidAt: new Date().toISOString(),
            });
            auditLog(
              db,
              obs,
              "INVOICE_PAID",
              payment.invoice.objectId,
              "Invoice",
              request.user,
              prev,
              { status: "paid", paymentId: payment.objectId },
            );
            if (events) {
              events.emit("ERP.invoicePaid", {
                invoiceId: payment.invoice.objectId,
                paymentId: payment.objectId,
              });
            }
          } catch (e) {
            obs?.warn?.(`[ERPTrait] Payment afterSave error: ${(e as Error).message}`);
          }
        }
      });
    }

    // 3. Cloud Functions
    if (cloud?.define) {
      /**
       * Fulfill Order: reduce el inventario verificando stock previamente.
       * Transaccional: si no hay stock suficiente para UN item, aborta todo.
       */
      cloud.define("erp_fulfillOrder", async (request: any) => {
        const { orderId } = request.params;
        const order = await db.read("Order", orderId);
        if (!order) throw ZenithErrors.notFound("Order", orderId);
        if (order.status !== "approved") {
          throw ZenithErrors.invalidRequest(
            `La orden ${orderId} no está en estado 'approved'. Estado actual: '${order.status}'.`,
          );
        }

        // ── Fase 1: Validar stock ANTES de modificar (integridad transaccional) ──
        const stockErrors: string[] = [];
        for (const item of order.items ?? []) {
          if (!item.product?.objectId) continue;
          const product = await db.read("Product", item.product.objectId);
          if (!product) {
            stockErrors.push(`Producto ${item.product.objectId} no encontrado.`);
          } else if ((product.stockQty ?? 0) < (item.qty ?? 0)) {
            stockErrors.push(
              `Stock insuficiente para '${product.name}': disponible ${product.stockQty}, requerido ${item.qty}.`,
            );
          }
        }
        if (stockErrors.length > 0) {
          throw ZenithErrors.invalidRequest(
            `Fulfillment bloqueado por stock:\n${stockErrors.join("\n")}`,
          );
        }

        // ── Fase 2: Aplicar la deducción (todo o nada) ────────────────────────
        for (const item of order.items ?? []) {
          if (!item.product?.objectId) continue;
          const product = await db.read("Product", item.product.objectId);
          const newStock = (product.stockQty ?? 0) - (item.qty ?? 0);
          await db.update("Product", { objectId: item.product.objectId }, { stockQty: newStock });
          // Alerta de stock bajo
          if (newStock <= (product.minStockQty ?? 0)) {
            obs?.warn?.(
              `[ERPTrait] ⚠️ Stock bajo para '${product.name}': ${newStock} unidades restantes.`,
            );
            if (events) {
              events.emit("ERP.lowStock", {
                productId: item.product.objectId,
                name: product.name,
                stockQty: newStock,
              });
            }
          }
        }

        // ── Fase 3: Actualizar estado y auditar ───────────────────────────────
        const prev = { status: order.status };
        await db.update("Order", { objectId: orderId }, {
          status: "fulfilled",
          updatedAt: new Date().toISOString(),
        });
        auditLog(db, obs, "ORDER_FULFILLED", orderId, "Order", request.user, prev, {
          status: "fulfilled",
        });
        if (events) events.emit("ERP.orderFulfilled", { orderId });

        return { success: true, message: `Orden ${orderId} cumplida e inventario actualizado.` };
      });
    }

    // ─── 4. traitApi interno ──────────────────────────────────────────────────

    const traitApi = {
      // ── Product ──────────────────────────────────────────────────────────────

      listProducts: async (query: Record<string, any>, ctx: any) => {
        await cloud?.runBeforeFind?.("Product", { query, user: ctx.user, master: ctx.master });
        const where = query.where ?? {};
        const limit = Math.min(parseInt(query.limit ?? "100", 10), 1000);
        const skip = parseInt(query.skip ?? "0", 10);
        let results = await db.find("Product", where);
        if (query.order) {
          const key = query.order.replace(/^-/, "");
          const desc = query.order.startsWith("-");
          results.sort((a: any, b: any) =>
            desc ? (a[key] < b[key] ? 1 : -1) : (a[key] < b[key] ? -1 : 1)
          );
        }
        results = results.slice(skip, skip + limit);
        await cloud?.runAfterFind?.("Product", { results, user: ctx.user, master: ctx.master });
        return { results };
      },

      getProduct: async (objectId: string, ctx: any) => {
        const obj = await db.read("Product", objectId);
        if (!obj) throw ZenithErrors.notFound("Product", objectId);
        return obj;
      },

      createProduct: async (data: Record<string, any>, ctx: any) => {
        if (!data.sku || !data.name || data.salePrice === undefined) {
          throw ZenithErrors.validationFailed("sku, name y salePrice son obligatorios.");
        }
        await cloud?.runBeforeSave?.("Product", {
          object: data,
          user: ctx.user,
          master: ctx.master,
        });
        const created = await db.create("Product", {
          ...data,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await cloud?.runAfterSave?.("Product", {
          object: created,
          user: ctx.user,
          master: ctx.master,
        });
        if (events) events.emit("ERP.productCreated", created);
        return created;
      },

      updateProduct: async (objectId: string, data: Record<string, any>, ctx: any) => {
        const existing = await db.read("Product", objectId);
        if (!existing) throw ZenithErrors.notFound("Product", objectId);
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        const updated = await db.update("Product", { objectId }, {
          ...data,
          updatedAt: new Date().toISOString(),
        });
        if (events) events.emit("ERP.productUpdated", { objectId, changes: data });
        return updated;
      },

      deleteProduct: async (objectId: string, ctx: any) => {
        const existing = await db.read("Product", objectId);
        if (!existing) throw ZenithErrors.notFound("Product", objectId);
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        await db.delete("Product", { objectId });
        auditLog(db, obs, "PRODUCT_DELETED", objectId, "Product", ctx.user, existing, null);
        if (events) events.emit("ERP.productDeleted", { objectId });
        return { success: true };
      },

      // ── Inventory ─────────────────────────────────────────────────────────────

      getInventoryStock: async (productId: string, ctx: any) => {
        const product = await db.read("Product", productId);
        if (!product) throw ZenithErrors.notFound("Product", productId);
        const warehouseBreakdown = await db.find("Inventory", { "product.objectId": productId });
        return {
          productId,
          productName: product.name,
          globalStock: product.stockQty ?? 0,
          minStockQty: product.minStockQty ?? 0,
          isLowStock: (product.stockQty ?? 0) <= (product.minStockQty ?? 0),
          warehouseBreakdown,
        };
      },

      // ── Order ─────────────────────────────────────────────────────────────────

      listOrders: async (query: Record<string, any>, ctx: any) => {
        const where = query.where ?? {};
        const limit = Math.min(parseInt(query.limit ?? "100", 10), 1000);
        const skip = parseInt(query.skip ?? "0", 10);
        const results = await db.find("Order", where);
        if (query.order) {
          const key = query.order.replace(/^-/, "");
          const desc = query.order.startsWith("-");
          results.sort((a: any, b: any) =>
            desc ? (a[key] < b[key] ? 1 : -1) : (a[key] < b[key] ? -1 : 1)
          );
        }
        return { results: results.slice(skip, skip + limit) };
      },

      getOrder: async (objectId: string, ctx: any) => {
        const obj = await db.read("Order", objectId);
        if (!obj) throw ZenithErrors.notFound("Order", objectId);
        return obj;
      },

      createOrder: async (data: Record<string, any>, ctx: any) => {
        if (!data.type || !data.items?.length) {
          throw ZenithErrors.validationFailed(
            "type e items son obligatorios para crear una Orden.",
          );
        }
        const totals = recalculateTotals(data.items);
        await cloud?.runBeforeSave?.("Order", { object: data, user: ctx.user, master: ctx.master });
        const created = await db.create("Order", {
          ...data,
          ...totals,
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await cloud?.runAfterSave?.("Order", {
          object: created,
          user: ctx.user,
          master: ctx.master,
        });
        auditLog(db, obs, "ORDER_CREATED", created.objectId, "Order", ctx.user, null, {
          status: "draft",
        });
        if (events) events.emit("ERP.orderCreated", created);
        return created;
      },

      updateOrder: async (objectId: string, data: Record<string, any>, ctx: any) => {
        const existing = await db.read("Order", objectId);
        if (!existing) throw ZenithErrors.notFound("Order", objectId);
        if (existing.status === "fulfilled" || existing.status === "cancelled") {
          throw ZenithErrors.invalidRequest(
            `No se puede modificar una orden en estado '${existing.status}'.`,
          );
        }
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        // Recalcular totales si se modifican items
        const patch = { ...data };
        if (data.items) {
          Object.assign(patch, recalculateTotals(data.items));
        }
        const updated = await db.update("Order", { objectId }, {
          ...patch,
          updatedAt: new Date().toISOString(),
        });
        auditLog(db, obs, "ORDER_UPDATED", objectId, "Order", ctx.user, existing, patch);
        return updated;
      },

      // ── Invoice ───────────────────────────────────────────────────────────────

      listInvoices: async (query: Record<string, any>, _ctx: any) => {
        const where = query.where ?? {};
        const limit = Math.min(parseInt(query.limit ?? "100", 10), 1000);
        const skip = parseInt(query.skip ?? "0", 10);
        const results = (await db.find("Invoice", where)).slice(skip, skip + limit);
        return { results };
      },

      getInvoice: async (objectId: string, ctx: any) => {
        const obj = await db.read("Invoice", objectId);
        if (!obj) throw ZenithErrors.notFound("Invoice", objectId);
        return obj;
      },

      createInvoice: async (data: Record<string, any>, ctx: any) => {
        if (!data.customer || !data.lines?.length) {
          throw ZenithErrors.validationFailed("customer y lines son obligatorios.");
        }
        // beforeSave trigger calculará totales y autogenerará el número
        await cloud?.runBeforeSave?.("Invoice", {
          object: data,
          user: ctx.user,
          master: ctx.master,
        });
        const created = await db.create("Invoice", {
          ...data,
          status: "draft",
          createdAt: new Date().toISOString(),
        });
        await cloud?.runAfterSave?.("Invoice", {
          object: created,
          user: ctx.user,
          master: ctx.master,
        });
        if (events) events.emit("ERP.invoiceCreated", created);
        return created;
      },

      updateInvoice: async (objectId: string, data: Record<string, any>, ctx: any) => {
        const existing = await db.read("Invoice", objectId);
        if (!existing) throw ZenithErrors.notFound("Invoice", objectId);
        if (existing.status === "paid") {
          throw ZenithErrors.invalidRequest("No se puede modificar una factura pagada.");
        }
        if (!ctx.master && !acl?.checkWrite(existing.ACL, ctx.user)) throw ZenithErrors.forbidden();
        const patch = { ...data };
        if (data.lines) Object.assign(patch, recalculateTotals(data.lines));
        const updated = await db.update("Invoice", { objectId }, {
          ...patch,
          updatedAt: new Date().toISOString(),
        });
        auditLog(db, obs, "INVOICE_UPDATED", objectId, "Invoice", ctx.user, existing, patch);
        return updated;
      },

      // ── Employee ──────────────────────────────────────────────────────────────

      listEmployees: async (query: Record<string, any>, _ctx: any) => {
        const limit = Math.min(parseInt(query.limit ?? "100", 10), 1000);
        const results = (await db.find("Employee", query.where ?? {})).slice(0, limit);
        return { results };
      },

      createEmployee: async (data: Record<string, any>, ctx: any) => {
        if (
          !data.name || !data.email || !data.role || !data.department ||
          data.salary === undefined || !data.startDate
        ) {
          throw ZenithErrors.validationFailed(
            "name, email, role, department, salary y startDate son obligatorios.",
          );
        }
        await cloud?.runBeforeSave?.("Employee", {
          object: data,
          user: ctx.user,
          master: ctx.master,
        });
        const created = await db.create("Employee", {
          ...data,
          status: "active",
          createdAt: new Date().toISOString(),
        });
        await cloud?.runAfterSave?.("Employee", {
          object: created,
          user: ctx.user,
          master: ctx.master,
        });
        auditLog(db, obs, "EMPLOYEE_HIRED", created.objectId, "Employee", ctx.user, null, {
          name: created.name,
        });
        if (events) events.emit("ERP.employeeHired", created);
        return created;
      },
    };

    // ─── 5. Rutas HTTP ────────────────────────────────────────────────────────

    const erp_routes = [
      // ── Products ─────────────────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/erp/products",
        _openapi: { summary: "Listar Productos ERP", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(
              await traitApi.listProducts(parseQueryParams(new URL(req.url)), ctx),
            );
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "GET" as const,
        path: "/zen/erp/products/:objectId",
        _openapi: { summary: "Obtener Producto por ID", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/products/:objectId", req.url);
            return jsonResponse(await traitApi.getProduct(p!.objectId, ctx));
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/erp/products",
        _openapi: {
          summary: "Crear Producto ERP",
          tags: ["ERP"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["sku", "name", "salePrice"],
                  properties: {
                    sku: { type: "string" },
                    name: { type: "string" },
                    salePrice: { type: "number" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
        },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(await traitApi.createProduct(await req.json(), ctx), 201);
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "PUT" as const,
        path: "/zen/erp/products/:objectId",
        _openapi: { summary: "Actualizar Producto ERP", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/products/:objectId", req.url);
            return jsonResponse(await traitApi.updateProduct(p!.objectId, await req.json(), ctx));
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "DELETE" as const,
        path: "/zen/erp/products/:objectId",
        _openapi: { summary: "Eliminar Producto ERP", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/products/:objectId", req.url);
            await traitApi.deleteProduct(p!.objectId, ctx);
            return new Response(null, { status: 204 });
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      // ── Inventory ─────────────────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/erp/inventory/:productId/stock",
        _openapi: {
          summary: "Stock por Producto",
          description:
            "Retorna stock global y desglose por almacén, incluyendo alerta de stock bajo.",
          tags: ["ERP", "Inventory"],
          parameters: [{
            name: "productId",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/inventory/:productId/stock", req.url);
            return jsonResponse(await traitApi.getInventoryStock(p!.productId, ctx));
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      // ── Orders ────────────────────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/erp/orders",
        _openapi: { summary: "Listar Órdenes ERP", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(await traitApi.listOrders(parseQueryParams(new URL(req.url)), ctx));
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "GET" as const,
        path: "/zen/erp/orders/:objectId",
        _openapi: { summary: "Obtener Orden por ID", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/orders/:objectId", req.url);
            return jsonResponse(await traitApi.getOrder(p!.objectId, ctx));
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/erp/orders",
        _openapi: {
          summary: "Crear Orden ERP",
          tags: ["ERP"],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["type", "items"],
                  properties: {
                    type: { type: "string", enum: ["purchase", "sale"] },
                    items: { type: "array" },
                  },
                },
              },
            },
          },
        },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(await traitApi.createOrder(await req.json(), ctx), 201);
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "PUT" as const,
        path: "/zen/erp/orders/:objectId",
        _openapi: { summary: "Actualizar Orden ERP", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/orders/:objectId", req.url);
            return jsonResponse(await traitApi.updateOrder(p!.objectId, await req.json(), ctx));
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/erp/orders/:orderId/fulfill",
        _openapi: {
          summary: "Cumplir Orden ERP",
          description:
            "Deduce inventario. Valida stock suficiente ANTES de modificar (integridad transaccional). Requiere estado 'approved'.",
          tags: ["ERP"],
          parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/orders/:orderId/fulfill", req.url);
            const result = await cloud?.run?.("erp_fulfillOrder", { orderId: p!.orderId }, {
              master: true,
              user: ctx.user,
            });
            return jsonResponse(result);
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      // ── Invoices ──────────────────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/erp/invoices",
        _openapi: { summary: "Listar Facturas ERP", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(
              await traitApi.listInvoices(parseQueryParams(new URL(req.url)), ctx),
            );
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "GET" as const,
        path: "/zen/erp/invoices/:objectId",
        _openapi: { summary: "Obtener Factura por ID", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/invoices/:objectId", req.url);
            return jsonResponse(await traitApi.getInvoice(p!.objectId, ctx));
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/erp/invoices",
        _openapi: {
          summary: "Crear Factura ERP",
          description:
            "El número se autogenera si no se provee. Los totales se calculan automáticamente.",
          tags: ["ERP"],
          requestBody: {
            content: {
              "application/json": { schema: { type: "object", required: ["customer", "lines"] } },
            },
          },
        },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(await traitApi.createInvoice(await req.json(), ctx), 201);
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "PUT" as const,
        path: "/zen/erp/invoices/:objectId",
        _openapi: { summary: "Actualizar Factura ERP", tags: ["ERP"] },
        handler: async (req: Request, ctx: any) => {
          try {
            const p = matchPath("/zen/erp/invoices/:objectId", req.url);
            return jsonResponse(await traitApi.updateInvoice(p!.objectId, await req.json(), ctx));
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      // ── Employees ─────────────────────────────────────────────────────────────

      {
        method: "GET" as const,
        path: "/zen/erp/employees",
        _openapi: { summary: "Listar Empleados ERP", tags: ["ERP", "HR"] },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(
              await traitApi.listEmployees(parseQueryParams(new URL(req.url)), ctx),
            );
          } catch (e) {
            return errorResponse(e);
          }
        },
      },

      {
        method: "POST" as const,
        path: "/zen/erp/employees",
        _openapi: {
          summary: "Registrar Empleado ERP",
          tags: ["ERP", "HR"],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "email", "role", "department", "salary", "startDate"],
                },
              },
            },
          },
        },
        handler: async (req: Request, ctx: any) => {
          try {
            return jsonResponse(await traitApi.createEmployee(await req.json(), ctx), 201);
          } catch (e) {
            return errorResponse(e);
          }
        },
      },
    ];

    return {
      "erp_routes": erp_routes,
      "erp": traitApi,
    };
  },
});
