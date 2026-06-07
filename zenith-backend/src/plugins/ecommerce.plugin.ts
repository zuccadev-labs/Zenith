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

  // ─── 2. Cloud Functions ────────────────────────────────────────────────

  /**
   * Agrega un producto al carrito. Crea el carrito si no existe.
   */
  Zen.Cloud.define("store_addToCart", async (request: any) => {
    const { productId, qty = 1, sessionId, userId } = request.params;

    if (!productId) throw ZenithErrors.invalidRequest("productId is required.");
    if (qty <= 0)   throw ZenithErrors.invalidRequest("qty must be > 0.");

    const product = await Zen.DB.findOne("Product", { where: { objectId: productId } });
    if (!product) throw ZenithErrors.notFound(`Product ${productId} not found.`);
    if (product.stockQty < qty) throw ZenithErrors.invalidRequest(`Insufficient stock. Available: ${product.stockQty}`);

    // Buscar carrito activo
    const cartWhere: any = { status: "active" };
    if (userId) cartWhere["user.objectId"] = userId;
    else if (sessionId) cartWhere.sessionId = sessionId;
    else throw ZenithErrors.invalidRequest("userId or sessionId is required.");

    let cart = await Zen.DB.findOne("Cart", { where: cartWhere });

    if (!cart) {
      cart = await Zen.DB.insert("Cart", {
        user:      userId ? { __type: "Pointer", className: "_User", objectId: userId } : undefined,
        sessionId: !userId ? sessionId : undefined,
        items: [], total: 0, discount: 0, currency: "USD", status: "active",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    // Verificar si el item ya está en el carrito
    const items: any[] = cart.items ?? [];
    const existingIndex = items.findIndex((i: any) => i.productId === productId);

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

    const items = (cart.items ?? []).filter((i: any) => i.productId !== productId);
    const total = parseFloat(items.reduce((s: number, i: any) => s + i.subtotal, 0).toFixed(2));
    const finalTotal = parseFloat(Math.max(0, total - (cart.discount ?? 0)).toFixed(2));

    await Zen.DB.update("Cart", cartId, { items, total: finalTotal, updatedAt: new Date().toISOString() });
    return { cartId, items, total: finalTotal };
  });

  /**
   * Procesa el checkout: valida stock, crea Order, actualiza Cart a completed.
   */
  Zen.Cloud.define("store_checkout", async (request: any) => {
    const { cartId, shippingAddress, paymentMethod, paymentRef } = request.params;
    if (!cartId || !shippingAddress || !paymentMethod) {
      throw ZenithErrors.invalidRequest("cartId, shippingAddress, and paymentMethod are required.");
    }

    const cart = await Zen.DB.findOne("Cart", { where: { objectId: cartId } });
    if (!cart) throw ZenithErrors.notFound(`Cart ${cartId} not found.`);
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

    const subtotal = parseFloat(cart.items.reduce((s: number, i: any) => s + i.subtotal, 0).toFixed(2));
    const tax      = parseFloat((subtotal * 0.08).toFixed(2)); // 8% IVA
    const shipping = subtotal >= 100 ? 0 : 9.99;              // Envío gratis > $100
    const discount = cart.discount ?? 0;
    const total    = parseFloat(Math.max(0, subtotal + tax + shipping - discount).toFixed(2));

    const order = await Zen.DB.insert("Order", {
      cart:            { __type: "Pointer", className: "Cart",  objectId: cartId },
      user:            cart.user,
      status:          "pending",
      paymentMethod, paymentRef,
      shippingAddress, billingAddress: shippingAddress,
      subtotal, tax, shipping, discount, total,
      currency: cart.currency ?? "USD",
      items:    cart.items, // Snapshot
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await Zen.DB.update("Cart", cartId, { status: "completed", updatedAt: new Date().toISOString() });

    return { order, total };
  });

  /**
   * Aplica un código de descuento al carrito.
   */
  Zen.Cloud.define("store_applyDiscount", async (request: any) => {
    const { cartId, code } = request.params;
    if (!cartId || !code) throw ZenithErrors.invalidRequest("cartId and code are required.");

    const discount = await Zen.DB.findOne("Discount", { where: { code: code.toUpperCase(), isActive: true } });
    if (!discount) throw ZenithErrors.notFound(`Discount code '${code}' not found or inactive.`);

    const now = new Date();
    if (discount.validUntil && new Date(discount.validUntil) < now) {
      throw ZenithErrors.invalidRequest(`Discount code '${code}' has expired.`);
    }
    if (discount.maxUses && discount.usedCount >= discount.maxUses) {
      throw ZenithErrors.invalidRequest(`Discount code '${code}' has reached its usage limit.`);
    }

    const cart = await Zen.DB.findOne("Cart", { where: { objectId: cartId } });
    if (!cart) throw ZenithErrors.notFound(`Cart ${cartId} not found.`);

    const subtotal = cart.items?.reduce((s: number, i: any) => s + i.subtotal, 0) ?? 0;

    if (discount.minOrderAmount && subtotal < discount.minOrderAmount) {
      throw ZenithErrors.invalidRequest(`Minimum order amount is $${discount.minOrderAmount}.`);
    }

    let discountAmount = 0;
    if (discount.type === "percentage") {
      discountAmount = parseFloat((subtotal * (discount.value / 100)).toFixed(2));
    } else if (discount.type === "fixed") {
      discountAmount = Math.min(discount.value, subtotal);
    } else if (discount.type === "free_shipping") {
      discountAmount = 9.99; // Precio de envío estándar
    }

    const newTotal = parseFloat(Math.max(0, subtotal - discountAmount).toFixed(2));
    await Zen.DB.update("Cart", cartId, {
      discount: discountAmount,
      discountCode: code,
      total: newTotal,
      updatedAt: new Date().toISOString(),
    });

    await Zen.DB.update("Discount", discount.objectId, {
      usedCount: { __op: "Increment", amount: 1 }
    });

    return { applied: true, discountAmount, newTotal };
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
    const { userId, limit = 10, skip = 0 } = request.params;
    if (!userId) throw ZenithErrors.invalidRequest("userId is required.");

    const orders = await Zen.DB.find("Order", {
      where: { "user.objectId": userId },
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

  console.log("[Ecommerce Plugin] ✅ E-Commerce Core installed: 6 schemas, 7 functions, 2 triggers.");
}
