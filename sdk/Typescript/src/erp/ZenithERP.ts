/**
 * @module @zuccadev-labs/zenith/erp
 *
 * Enterprise ERP SDK — 100% acoplado al ZenithERPTrait del backend.
 * Provee tipado fuerte para Product, Order, Invoice, Payment, Employee e Inventory.
 * Reutiliza el RESTController del SDK para auth, retry y error handling.
 */

import { RESTController } from "../rest/RESTController.js";

// ─── Tipos del dominio ERP ────────────────────────────────────────────────────

export type ERPPointer = { __type: "Pointer"; className: string; objectId: string };

export interface ERPProduct {
  objectId?: string;
  sku: string;
  name: string;
  description?: string;
  salePrice: number;
  costPrice?: number;
  stockQty?: number;
  minStockQty?: number;
  category?: string;
  barcode?: string;
  unit?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ERPInventoryStock {
  productId: string;
  productName: string;
  globalStock: number;
  minStockQty: number;
  isLowStock: boolean;
  warehouseBreakdown: Array<{ objectId: string; warehouse: ERPPointer; quantity: number }>;
}

export interface ERPOrderLine {
  product: ERPPointer;
  qty: number;
  price: number;
  tax?: number; // Porcentaje: 0-100
}

export interface ERPOrder {
  objectId?: string;
  type: "purchase" | "sale";
  status?: "draft" | "approved" | "fulfilled" | "cancelled";
  customer?: ERPPointer;
  supplier?: ERPPointer;
  items: ERPOrderLine[];
  subtotal?: number;
  tax?: number;
  total?: number;
  expectedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ERPInvoiceLine {
  description: string;
  qty: number;
  price: number;
  tax?: number; // Porcentaje
}

export interface ERPInvoice {
  objectId?: string;
  number?: string; // Autogenerado si no se provee
  customer: ERPPointer;
  lines: ERPInvoiceLine[];
  subtotal?: number;
  tax?: number;
  total?: number;
  status?: "draft" | "sent" | "paid" | "overdue" | "cancelled";
  dueDate?: string;
  paidAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ERPEmployee {
  objectId?: string;
  name: string;
  email: string;
  role: string;
  department: string;
  salary: number;
  currency?: string;
  startDate: string;
  status?: "active" | "inactive" | "terminated";
  createdAt?: string;
  updatedAt?: string;
}

export interface ERPListOptions {
  limit?: number;
  skip?: number;
  order?: string;
  where?: Record<string, unknown>;
}

export interface ERPListResult<T> {
  results: T[];
}

export interface FulfillOrderResult {
  success: boolean;
  message: string;
}

// ─── ZenithERP ────────────────────────────────────────────────────────────────

/**
 * SDK para el módulo ERP corporativo de Zenith.
 * Todos los métodos utilizan el RESTController centralizado (auth, headers, retry).
 *
 * @example
 * ```ts
 * import { ZenithERP } from "@zuccadev-labs/zenith/erp";
 *
 * const product = await ZenithERP.Products.create({ sku: "SKU-001", name: "Laptop Pro", salePrice: 1200 });
 * const order   = await ZenithERP.Orders.create({ type: "sale", items: [{ product: { __type: "Pointer", className: "Product", objectId: product.objectId! }, qty: 2, price: 1200 }] });
 * await ZenithERP.Orders.approve(order.objectId!);
 * const result  = await ZenithERP.Orders.fulfill(order.objectId!);
 * ```
 */
export class ZenithERP {

  // ── Products ──────────────────────────────────────────────────────────────

  static readonly Products = {

    /** Lista productos con soporte de paginación y filtros. */
    async list(options: ERPListOptions = {}): Promise<ERPListResult<ERPProduct>> {
      const params: Record<string, any> = {};
      if (options.limit !== undefined) params.limit = options.limit;
      if (options.skip  !== undefined) params.skip  = options.skip;
      if (options.order !== undefined) params.order = options.order;
      if (options.where !== undefined) params.where = options.where;
      return RESTController.request("GET", "/zen/erp/products", params);
    },

    /** Obtiene un producto por su objectId. */
    async get(objectId: string): Promise<ERPProduct> {
      return RESTController.request("GET", `/zen/erp/products/${objectId}`);
    },

    /**
     * Crea un nuevo producto. Requiere: sku, name, salePrice.
     * Los campos opcionales incluyen costPrice, stockQty, minStockQty.
     */
    async create(data: Omit<ERPProduct, "objectId" | "createdAt" | "updatedAt">): Promise<ERPProduct> {
      return RESTController.request("POST", "/zen/erp/products", data);
    },

    /** Actualiza un producto de forma parcial. */
    async update(objectId: string, data: Partial<ERPProduct>): Promise<ERPProduct> {
      return RESTController.request("PUT", `/zen/erp/products/${objectId}`, data);
    },

    /** Elimina un producto. Genera una entrada en ERP_Audit. */
    async delete(objectId: string): Promise<void> {
      await RESTController.request("DELETE", `/zen/erp/products/${objectId}`);
    },
  };

  // ── Inventory ─────────────────────────────────────────────────────────────

  static readonly Inventory = {

    /**
     * Retorna el stock global de un producto y su desglose por almacén.
     * Incluye `isLowStock: true` si el stock actual está por debajo de `minStockQty`.
     */
    async getStock(productId: string): Promise<ERPInventoryStock> {
      return RESTController.request("GET", `/zen/erp/inventory/${productId}/stock`);
    },
  };

  // ── Orders ────────────────────────────────────────────────────────────────

  static readonly Orders = {

    /** Lista órdenes con paginación y filtros. */
    async list(options: ERPListOptions = {}): Promise<ERPListResult<ERPOrder>> {
      const params: Record<string, any> = {};
      if (options.limit !== undefined) params.limit = options.limit;
      if (options.skip  !== undefined) params.skip  = options.skip;
      if (options.order !== undefined) params.order = options.order;
      if (options.where !== undefined) params.where = options.where;
      return RESTController.request("GET", "/zen/erp/orders", params);
    },

    /** Obtiene una orden por su objectId. */
    async get(objectId: string): Promise<ERPOrder> {
      return RESTController.request("GET", `/zen/erp/orders/${objectId}`);
    },

    /**
     * Crea una orden. Los totales se calculan automáticamente en el backend.
     * Requiere: type ("purchase" | "sale"), items (array con product pointer, qty, price).
     */
    async create(data: Omit<ERPOrder, "objectId" | "subtotal" | "tax" | "total" | "status" | "createdAt" | "updatedAt">): Promise<ERPOrder> {
      return RESTController.request("POST", "/zen/erp/orders", data);
    },

    /** Actualiza una orden (solo si no está fulfilled o cancelled). */
    async update(objectId: string, data: Partial<ERPOrder>): Promise<ERPOrder> {
      return RESTController.request("PUT", `/zen/erp/orders/${objectId}`, data);
    },

    /**
     * Aprueba una orden (la pasa de "draft" a "approved").
     * Solo las órdenes aprobadas pueden ser fulfilled.
     */
    async approve(objectId: string): Promise<ERPOrder> {
      return RESTController.request("PUT", `/zen/erp/orders/${objectId}`, { status: "approved" });
    },

    /**
     * Cumple una orden y deduce el inventario.
     * El backend valida stock suficiente de TODOS los items ANTES de deducir
     * (integridad transaccional). Si falta stock en algún item, retorna error.
     */
    async fulfill(orderId: string): Promise<FulfillOrderResult> {
      return RESTController.request("POST", `/zen/erp/orders/${orderId}/fulfill`, {});
    },
  };

  // ── Invoices ──────────────────────────────────────────────────────────────

  static readonly Invoices = {

    /** Lista facturas con paginación y filtros. */
    async list(options: ERPListOptions = {}): Promise<ERPListResult<ERPInvoice>> {
      const params: Record<string, any> = {};
      if (options.limit !== undefined) params.limit = options.limit;
      if (options.skip  !== undefined) params.skip  = options.skip;
      if (options.order !== undefined) params.order = options.order;
      if (options.where !== undefined) params.where = options.where;
      return RESTController.request("GET", "/zen/erp/invoices", params);
    },

    /** Obtiene una factura por su objectId. */
    async get(objectId: string): Promise<ERPInvoice> {
      return RESTController.request("GET", `/zen/erp/invoices/${objectId}`);
    },

    /**
     * Crea una factura. El número se autogenera si no se provee.
     * Los totales (subtotal, tax, total) se calculan automáticamente en el backend.
     * Requiere: customer (Pointer a _User), lines.
     */
    async create(data: Omit<ERPInvoice, "objectId" | "number" | "subtotal" | "tax" | "total" | "status" | "paidAt" | "createdAt" | "updatedAt"> & { number?: string }): Promise<ERPInvoice> {
      return RESTController.request("POST", "/zen/erp/invoices", data);
    },

    /**
     * Actualiza una factura. No se puede modificar si está en estado "paid".
     * Si se modifican las lines, los totales se recalculan automáticamente.
     */
    async update(objectId: string, data: Partial<ERPInvoice>): Promise<ERPInvoice> {
      return RESTController.request("PUT", `/zen/erp/invoices/${objectId}`, data);
    },
  };

  // ── Employees ─────────────────────────────────────────────────────────────

  static readonly Employees = {

    /** Lista empleados. */
    async list(options: ERPListOptions = {}): Promise<ERPListResult<ERPEmployee>> {
      const params: Record<string, any> = {};
      if (options.limit !== undefined) params.limit = options.limit;
      if (options.where !== undefined) params.where = options.where;
      return RESTController.request("GET", "/zen/erp/employees", params);
    },

    /**
     * Registra un nuevo empleado.
     * Genera automáticamente una entrada de auditoría `EMPLOYEE_HIRED` en ScyllaDB.
     */
    async create(data: Omit<ERPEmployee, "objectId" | "status" | "createdAt" | "updatedAt">): Promise<ERPEmployee> {
      return RESTController.request("POST", "/zen/erp/employees", data);
    },
  };
}
