/**
 * @plugin @zenith/ecommerce-core (Open Source)
 *
 * E-Commerce Core Plugin para Zenith Universal Business Backend.
 * Instala: Catalog, Cart, Orders, Discounts, Reviews.
 * Compatible con Headless Commerce (API-first).
 *
 * Uso:
 *   import { installEcommercePlugin } from "./plugins/ecommerce.plugin.ts";
 *   installEcommercePlugin(Zen);
 */
import { ZenithErrors } from "../core/errors.ts";
import { COUNTRY_RULE_SCHEMA, computeTotals, findCountryRule, validateCountryRule } from "./ecommerce-country.ts";

/** Largo mínimo del sessionId de invitado: funciona como secreto del carrito. */
const MIN_GUEST_SESSION_LENGTH = 16;

/** Identidad de quien llama. Sin master, el userId sale de la sesión y nunca de los params. */
function resolveActor(request: any): { userId?: string; sessionId?: string; master: boolean } {
  const master = !!request.master;
  const sessionId = typeof request.params.sessionId === "string" ? request.params.sessionId : undefined;
  return {
    userId: (master ? request.params.userId : undefined) ?? request.user?.objectId,
    sessionId,
    master,
  };
}

/** Rechaza por defecto: si el carrito no tiene un dueño identificable, solo pasa master. */
function assertCartAccess(cart: any, actor: { userId?: string; sessionId?: string; master: boolean }): void {
  if (actor.master) return;
  if (cart.ownerId) {
    if (cart.ownerId === actor.userId) return;
  } else if (!cart.user && cart.sessionId && cart.sessionId === actor.sessionId) {
    return;
  }
  throw ZenithErrors.forbidden("You do not have access to this cart.");
}

function cartSubtotal(items: any[]): number {
  return parseFloat(items.reduce((s: number, i: any) => s + i.subtotal, 0).toFixed(2));
}

async function releaseStock(Zen: any, items: any[]): Promise<void> {
  for (const item of items) {
    await Zen.DB.update("Product", item.productId, { stockQty: { __op: "Increment", amount: item.qty } });
  }
}

/**
 * Reserva stock con una actualización condicional: se resta solo si alcanza. No hay sobreventa,
 * y un checkout no se rechaza por otro que al final falló.
 */
async function reserveStock(Zen: any, items: any[]): Promise<void> {
  const reserved: any[] = [];
  try {
    for (const item of items) {
      const updated = await Zen.DB.updateIf(
        "Product", item.productId,
        { stockQty: { $gte: item.qty } },
        { stockQty: { __op: "Increment", amount: -item.qty } },
      );
      if (!updated) throw ZenithErrors.invalidRequest(`Insufficient stock for '${item.productName ?? item.productId}'.`);
      reserved.push(item);
    }
  } catch (err) {
    await releaseStock(Zen, reserved);
    throw err;
  }
}

export function installEcommercePlugin(Zen: any) {
  console.log("[Ecommerce Plugin] 🛍️ Installing E-Commerce Core plugin...");

  // ─── 1. Schemas ────────────────────────────────────────────────────────

  Zen.Cloud.defineSchema?.("Catalog", {
    name:          { type: "String",  required: true },
    slug:          { type: "String",  required: true },
    description:   { type: "String" },
    isActive:      { type: "Boolean", defaultValue: true },
    parentCatalog: { type: "Pointer", targetClass: "Catalog" },
  });

  Zen.Cloud.defineSchema?.("ProductListing", {
    product:       { type: "Pointer", targetClass: "Product",  required: true },
    catalog:       { type: "Pointer", targetClass: "Catalog",  required: true },
    isActive:      { type: "Boolean", defaultValue: true },
    position:      { type: "Number",  defaultValue: 0 },
    featuredImage: { type: "String" },
    images:        { type: "Array",   defaultValue: [] },
    tags:          { type: "Array",   defaultValue: [] },
  });

  Zen.Cloud.defineSchema?.("Cart", {
    user:      { type: "Pointer", targetClass: "_User" },
    ownerId:   { type: "String" }, // objectId del dueño, comparable en cualquier adapter
    sessionId: { type: "String" }, // Para guests sin cuenta
    items:     { type: "Array",  defaultValue: [] }, // [{product, qty, unitPrice, subtotal}]
    total:     { type: "Number", defaultValue: 0 },
    discount:  { type: "Number", defaultValue: 0 },
    currency:  { type: "String", defaultValue: "USD" },
    status:    { type: "String", defaultValue: "active" }, // active|checkout|abandoned|completed
    discountCode: { type: "String" },
  });

  Zen.Cloud.defineSchema?.("Order", {
    cart:            { type: "Pointer", targetClass: "Cart" },
    user:            { type: "Pointer", targetClass: "_User" },
    ownerId:         { type: "String" },
    status:          { type: "String",  defaultValue: "pending" }, // pending|paid|processing|shipped|delivered|refunded|cancelled
    paymentMethod:   { type: "String",  required: true },
    paymentRef:      { type: "String" },
    shippingAddress: { type: "Object",  required: true },
    billingAddress:  { type: "Object" },
    subtotal:        { type: "Number",  defaultValue: 0 },
    shipping:        { type: "Number",  defaultValue: 0 },
    tax:             { type: "Number",  defaultValue: 0 },
    discount:        { type: "Number",  defaultValue: 0 },
    total:           { type: "Number",  defaultValue: 0 },
    currency:        { type: "String",  defaultValue: "USD" },
    paidAt:          { type: "Date" },
    shippedAt:       { type: "Date" },
    deliveredAt:     { type: "Date" },
    trackingNumber:  { type: "String" },
    items:           { type: "Array",   defaultValue: [] }, // Snapshot de los items al momento del pago
  });

  Zen.Cloud.defineSchema?.("Discount", {
    code:           { type: "String",  required: true },
    type:           { type: "String",  required: true }, // percentage|fixed|free_shipping
    value:          { type: "Number",  required: true },
    minOrderAmount: { type: "Number",  defaultValue: 0 },
    maxUses:        { type: "Number" }, // undefined = unlimited
    usedCount:      { type: "Number",  defaultValue: 0 },
    validFrom:      { type: "Date",    required: true },
    validUntil:     { type: "Date" },
    isActive:       { type: "Boolean", defaultValue: true },
  });

  Zen.Cloud.defineSchema?.("Review", {
    product:    { type: "Pointer", targetClass: "Product",  required: true },
    user:       { type: "Pointer", targetClass: "_User",    required: true },
    rating:     { type: "Number",  required: true }, // 1-5
    title:      { type: "String" },
    body:       { type: "String" },
    isVerified: { type: "Boolean", defaultValue: false },
    isApproved: { type: "Boolean", defaultValue: false },
  });

  Zen.Cloud.defineSchema?.("StoreCountryRule", COUNTRY_RULE_SCHEMA);

  // ─── 2. Cloud Functions ────────────────────────────────────────────────

  /**
   * Agrega un producto al carrito. Crea el carrito si no existe.
   */
  Zen.Cloud.define("store_addToCart", async (request: any) => {
    const { productId, qty = 1 } = request.params;
    const { userId, sessionId } = resolveActor(request);

    if (!productId) throw ZenithErrors.invalidRequest("productId is required.");
    if (!Number.isInteger(qty) || qty <= 0) throw ZenithErrors.invalidRequest("qty must be a positive integer.");

    const product = await Zen.DB.findOne("Product", { where: { objectId: productId } });
    if (!product) throw ZenithErrors.notFound(`Product ${productId} not found.`);

    // Buscar carrito activo
    const cartWhere: any = { status: "active" };
    if (userId) cartWhere.ownerId = userId;
    else if (sessionId && sessionId.length >= MIN_GUEST_SESSION_LENGTH) cartWhere.sessionId = sessionId;
    else throw ZenithErrors.unauthorized(`A session or a sessionId of at least ${MIN_GUEST_SESSION_LENGTH} characters is required.`);

    let cart = await Zen.DB.findOne("Cart", { where: cartWhere });

    if (!cart) {
      cart = await Zen.DB.insert("Cart", {
        user:      userId ? { __type: "Pointer", className: "_User", objectId: userId } : undefined,
        ownerId:   userId,
        sessionId: !userId ? sessionId : undefined,
        items: [], total: 0, discount: 0, currency: product.currency ?? "USD", status: "active",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    if ((product.currency ?? "USD") !== (cart.currency ?? "USD")) {
      throw ZenithErrors.invalidRequest(`Product currency does not match cart currency '${cart.currency}'.`);
    }

    // Verificar si el item ya está en el carrito
    const items: any[] = cart.items ?? [];
    const existingIndex = items.findIndex((i: any) => i.productId === productId);

    const requested = qty + (existingIndex >= 0 ? items[existingIndex].qty : 0);
    if (product.stockQty < requested) {
      throw ZenithErrors.invalidRequest(`Insufficient stock. Available: ${product.stockQty}`);
    }

    if (existingIndex >= 0) {
      items[existingIndex].qty += qty;
      items[existingIndex].subtotal = parseFloat((items[existingIndex].qty * items[existingIndex].unitPrice).toFixed(2));
    } else {
      items.push({
        productId, productName: product.name, sku: product.sku,
        qty, unitPrice: product.salePrice,
        subtotal: parseFloat((qty * product.salePrice).toFixed(2)),
      });
    }

    const total = parseFloat(items.reduce((s: number, i: any) => s + i.subtotal, 0).toFixed(2));
    const finalTotal = parseFloat(Math.max(0, total - (cart.discount ?? 0)).toFixed(2));

    await Zen.DB.update("Cart", cart.objectId, { items, total: finalTotal, updatedAt: new Date().toISOString() });
    return { cartId: cart.objectId, items, total: finalTotal };
  });

  /**
   * Elimina un producto del carrito.
   */
  Zen.Cloud.define("store_removeFromCart", async (request: any) => {
    const { cartId, productId } = request.params;
    if (!cartId || !productId) throw ZenithErrors.invalidRequest("cartId and productId are required.");

    const cart = await Zen.DB.findOne("Cart", { where: { objectId: cartId } });
    if (!cart) throw ZenithErrors.notFound(`Cart ${cartId} not found.`);
    assertCartAccess(cart, resolveActor(request));
    if (cart.status !== "active") throw ZenithErrors.invalidRequest(`Cart status is '${cart.status}'. Cannot modify.`);

    const items = (cart.items ?? []).filter((i: any) => i.productId !== productId);
    const total = parseFloat(items.reduce((s: number, i: any) => s + i.subtotal, 0).toFixed(2));
    const finalTotal = parseFloat(Math.max(0, total - (cart.discount ?? 0)).toFixed(2));

    await Zen.DB.update("Cart", cartId, { items, total: finalTotal, updatedAt: new Date().toISOString() });
    return { cartId, items, total: finalTotal };
  });

  /**
   * Procesa el checkout: valida dueño, reserva stock, crea Order y actualiza Cart a completed.
   * Si algo falla, devuelve el stock y deja el carrito activo.
   */
  Zen.Cloud.define("store_checkout", async (request: any) => {
    const { cartId, shippingAddress, paymentMethod, paymentRef } = request.params;
    if (!cartId || !shippingAddress || !paymentMethod) {
      throw ZenithErrors.invalidRequest("cartId, shippingAddress, and paymentMethod are required.");
    }

    const cart = await Zen.DB.findOne("Cart", { where: { objectId: cartId } });
    if (!cart) throw ZenithErrors.notFound(`Cart ${cartId} not found.`);
    assertCartAccess(cart, resolveActor(request));
    if (cart.status !== "active") throw ZenithErrors.invalidRequest(`Cart status is '${cart.status}'. Cannot checkout.`);
    if (!cart.items?.length) throw ZenithErrors.invalidRequest("Cart is empty.");

    // Validar stock de todos los items
    for (const item of cart.items) {
      const product = await Zen.DB.findOne("Product", { where: { objectId: item.productId } });
      if (!product) throw ZenithErrors.notFound(`Product ${item.productId} not found.`);
      if (product.stockQty < item.qty) {
        throw ZenithErrors.invalidRequest(`Insufficient stock for '${product.name}'. Available: ${product.stockQty}, Requested: ${item.qty}`);
      }
    }

    const rule = await findCountryRule(Zen, shippingAddress);
    const currency = cart.currency ?? "USD";
    if (rule.currency !== currency) {
      throw ZenithErrors.invalidRequest(`Cart is in ${currency}, but '${rule.code}' sells in ${rule.currency}.`);
    }
    const { subtotal, tax, shipping, discount, total } = computeTotals({
      subtotal: cartSubtotal(cart.items),
      discount: cart.discount ?? 0,
      freeShipping: !!cart.freeShipping,
      rule,
    });

    // Solo una llamada gana el carrito, aunque lleguen dos a la vez
    const claimed = await Zen.DB.updateIf("Cart", cartId, { status: "active" }, { status: "checkout" });
    if (!claimed) throw ZenithErrors.invalidRequest("Cart is already being checked out.");

    let stockReserved = false;
    try {
      await reserveStock(Zen, cart.items);
      stockReserved = true;

      const order = await Zen.DB.insert("Order", {
        cart:            { __type: "Pointer", className: "Cart",  objectId: cartId },
        user:            cart.user,
        ownerId:         cart.ownerId,
        status:          "pending",
        paymentMethod, paymentRef,
        shippingAddress, billingAddress: shippingAddress,
        subtotal, tax, shipping, discount, total,
        countryCode: rule.code,
        taxName: rule.taxName,
        taxRate: rule.taxRate,
        taxIncluded: !!rule.taxIncluded,
        currency,
        items:    cart.items, // Snapshot
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await Zen.DB.update("Cart", cartId, { status: "completed", updatedAt: new Date().toISOString() });

      return { order, total };
    } catch (err) {
      if (stockReserved) await releaseStock(Zen, cart.items);
      await Zen.DB.update("Cart", cartId, { status: "active", updatedAt: new Date().toISOString() });
      throw err;
    }
  });

  /**
   * Aplica un código de descuento al carrito.
   */
  Zen.Cloud.define("store_applyDiscount", async (request: any) => {
    const { cartId, code } = request.params;
    if (!cartId || !code) throw ZenithErrors.invalidRequest("cartId and code are required.");

    const cart = await Zen.DB.findOne("Cart", { where: { objectId: cartId } });
    if (!cart) throw ZenithErrors.notFound(`Cart ${cartId} not found.`);
    assertCartAccess(cart, resolveActor(request));
    if (cart.status !== "active") throw ZenithErrors.invalidRequest(`Cart status is '${cart.status}'. Cannot modify.`);

    const discount = await Zen.DB.findOne("Discount", { where: { code: code.toUpperCase(), isActive: true } });
    if (!discount) throw ZenithErrors.notFound(`Discount code '${code}' not found or inactive.`);

    const now = new Date();
    if (discount.validUntil && new Date(discount.validUntil) < now) {
      throw ZenithErrors.invalidRequest(`Discount code '${code}' has expired.`);
    }
    if (discount.maxUses && discount.usedCount >= discount.maxUses) {
      throw ZenithErrors.invalidRequest(`Discount code '${code}' has reached its usage limit.`);
    }

    const subtotal = cart.items?.reduce((s: number, i: any) => s + i.subtotal, 0) ?? 0;

    if (discount.minOrderAmount && subtotal < discount.minOrderAmount) {
      throw ZenithErrors.invalidRequest(`Minimum order amount is $${discount.minOrderAmount}.`);
    }

    let discountAmount = 0;
    if (discount.type === "percentage") {
      discountAmount = parseFloat((subtotal * (discount.value / 100)).toFixed(2));
    } else if (discount.type === "fixed") {
      discountAmount = Math.min(discount.value, subtotal);
    }

    const newTotal = parseFloat(Math.max(0, subtotal - discountAmount).toFixed(2));
    await Zen.DB.update("Cart", cartId, {
      discount: discountAmount,
      freeShipping: discount.type === "free_shipping",
      discountCode: code,
      total: newTotal,
      updatedAt: new Date().toISOString(),
    });

    // Reaplicar el mismo código en el mismo carrito no consume otro uso
    if (cart.discountCode !== code) {
      await Zen.DB.update("Discount", discount.objectId, {
        usedCount: { __op: "Increment", amount: 1 }
      });
    }

    return { applied: true, discountAmount, newTotal };
  });

  /**
   * Crea o actualiza la regla de impuestos y envío de un país. Solo con Master Key.
   */
  Zen.Cloud.define("store_setCountryRule", async (request: any) => {
    if (!request.master) throw ZenithErrors.forbidden("Master key is required.");
    const rule = validateCountryRule(request.params);

    const existing = await Zen.DB.findOne("StoreCountryRule", { where: { code: rule.code } });
    if (existing) return await Zen.DB.update("StoreCountryRule", existing.objectId, rule);
    return await Zen.DB.insert("StoreCountryRule", rule);
  });

  /**
   * Calcula impuestos, envío y total de un carrito para un destino, sin crear la orden.
   */
  Zen.Cloud.define("store_quote", async (request: any) => {
    const { cartId, shippingAddress } = request.params;
    if (!cartId || !shippingAddress) throw ZenithErrors.invalidRequest("cartId and shippingAddress are required.");

    const cart = await Zen.DB.findOne("Cart", { where: { objectId: cartId } });
    if (!cart) throw ZenithErrors.notFound(`Cart ${cartId} not found.`);
    assertCartAccess(cart, resolveActor(request));

    const rule = await findCountryRule(Zen, shippingAddress);
    return {
      ...computeTotals({ subtotal: cartSubtotal(cart.items ?? []), discount: cart.discount ?? 0, freeShipping: !!cart.freeShipping, rule }),
      currency: rule.currency,
      countryCode: rule.code,
      taxName: rule.taxName,
    };
  });

  /**
   * Búsqueda de productos en catálogo con filtros.
   */
  Zen.Cloud.define("store_searchProducts", async (request: any) => {
    const { query, category, minPrice, maxPrice, inStock, _catalogSlug, limit = 20, skip = 0 } = request.params;

    const where: any = {};
    if (category) where.category = category;
    if (minPrice !== undefined) where.salePrice = { ...(where.salePrice ?? {}), $gte: minPrice };
    if (maxPrice !== undefined) where.salePrice = { ...(where.salePrice ?? {}), $lte: maxPrice };
    if (inStock === true) where.stockQty = { $gt: 0 };

    let products = await Zen.DB.find("Product", { where, limit: limit * 2, skip }); // Fetch extra for text filter

    // Filtro de texto simple (case-insensitive)
    if (query) {
      const q = query.toLowerCase();
      products = products.filter((p: any) =>
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
      );
    }

    return { products: products.slice(0, limit), count: products.length };
  });

  /**
   * Historial de órdenes de un usuario.
   */
  Zen.Cloud.define("store_getOrdersByUser", async (request: any) => {
    const { userId: requestedUserId, limit = 10, skip = 0 } = request.params;
    const { userId, master } = resolveActor(request);
    if (!userId) throw ZenithErrors.unauthorized("A session is required.");
    if (!master && requestedUserId && requestedUserId !== userId) {
      throw ZenithErrors.forbidden("You can only read your own orders.");
    }

    const orders = await Zen.DB.find("Order", {
      where: { ownerId: userId },
      order: "-createdAt",
      limit, skip,
    });

    return { orders, count: orders.length };
  });

  /**
   * Promedio de ratings de un producto.
   */
  Zen.Cloud.define("store_productRating", async (request: any) => {
    const { productId } = request.params;
    if (!productId) throw ZenithErrors.invalidRequest("productId is required.");

    const reviews = await Zen.DB.find("Review", {
      where: { "product.objectId": productId, isApproved: true },
    });

    if (reviews.length === 0) return { average: 0, count: 0, distribution: {} };

    const sum = reviews.reduce((s: number, r: any) => s + (r.rating ?? 0), 0);
    const average = parseFloat((sum / reviews.length).toFixed(1));

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of reviews) {
      const rating = Math.round(r.rating);
      if (distribution[rating] !== undefined) distribution[rating]++;
    }

    return { average, count: reviews.length, distribution };
  });

  // ─── 3. Triggers ──────────────────────────────────────────────────────

  /** Al pagar una Order, crear StockMovements para cada item */
  Zen.Cloud.afterSave("Order", async (request: any) => {
    const obj      = request.object;
    const original = request.original;

    if (obj.status === "paid" && original?.status !== "paid") {
      await Zen.DB.update("Order", obj.objectId, { paidAt: new Date().toISOString() });

      for (const item of (obj.items ?? [])) {
        const product = await Zen.DB.findOne("Product", { where: { objectId: item.productId } });
        if (!product) continue;

        await Zen.DB.insert("StockMovement", {
          product:   { __type: "Pointer", className: "Product", objectId: item.productId },
          quantity:  item.qty,
          reason:    "sale",
          reference: obj.objectId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    // Cancelar antes del envío libera lo reservado en el checkout
    const cancellable = !["cancelled", "shipped", "delivered"].includes(original?.status);
    if (obj.status === "cancelled" && original && cancellable) {
      await releaseStock(Zen, obj.items ?? []);
      for (const item of (obj.items ?? [])) {
        await Zen.DB.insert("StockMovement", {
          product:   { __type: "Pointer", className: "Product", objectId: item.productId },
          quantity:  item.qty,
          reason:    "order_cancelled",
          reference: obj.objectId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    if (obj.status === "shipped" && original?.status !== "shipped") {
      await Zen.DB.update("Order", obj.objectId, { shippedAt: new Date().toISOString() });
    }
    if (obj.status === "delivered" && original?.status !== "delivered") {
      await Zen.DB.update("Order", obj.objectId, { deliveredAt: new Date().toISOString() });
    }
  });

  /** Validar rating entre 1 y 5 antes de guardar */
  Zen.Cloud.beforeSave("Review", async (request: any) => {
    const obj = request.object;
    if (obj.rating < 1 || obj.rating > 5) {
      throw ZenithErrors.invalidRequest("Rating must be between 1 and 5.");
    }
    // Verificar que el usuario realmente compró el producto
    if (obj.user?.objectId && obj.product?.objectId) {
      const orders = await Zen.DB.find("Order", {
        where: {
          "user.objectId": obj.user.objectId,
          status: "delivered",
        },
        limit: 50,
      });
      const purchased = orders.some((o: any) =>
        (o.items ?? []).some((i: any) => i.productId === obj.product.objectId)
      );
      if (purchased) obj.isVerified = true;
    }
  });

  console.log("[Ecommerce Plugin] ✅ E-Commerce Core installed: 7 schemas, 9 functions, 2 triggers.");
}
