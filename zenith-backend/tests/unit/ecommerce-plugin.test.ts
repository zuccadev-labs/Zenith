/**
 * Tests para plugins/ecommerce.plugin.ts — stock, autenticación y dueño del carrito.
 *
 * Cubre:
 *   - Identidad: el userId sale de la sesión, no de los params
 *   - Dueño: usuarios e invitados solo acceden a su carrito
 *   - Stock: reserva en checkout, reversión ante fallos, sin sobreventa
 *   - Cancelación: devuelve el stock una sola vez
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ZenithError } from "../../src/core/errors.ts";
import { computeTotals } from "../../src/plugins/ecommerce-country.ts";
import { installEcommercePlugin } from "../../src/plugins/ecommerce.plugin.ts";

const GUEST = "guest-session-0123456789";
const OTHER_GUEST = "guest-session-9876543210";
const CHECKOUT = { shippingAddress: { city: "Prueba", country: "XX" }, paymentMethod: "card" };
const RULE = { objectId: "r1", code: "XX", currency: "USD", decimals: 2, taxRate: 10, shippingFlat: 5, freeShippingFrom: 100, isActive: true };

function matches(doc: any, where: any = {}): boolean {
  return Object.entries<any>(where).every(([key, value]) =>
    value && typeof value === "object" && "$gte" in value ? doc[key] >= value.$gte : doc[key] === value
  );
}

function setup(stock = 5) {
  const tables: Record<string, any[]> = {};
  const functions = new Map<string, (request: any) => Promise<any>>();
  const triggers = new Map<string, (request: any) => Promise<any>>();
  let nextId = 1;
  let failInsertOn: string | undefined;

  const table = (name: string) => (tables[name] ??= []);
  const apply = (doc: any, patch: any) => {
    for (const [key, value] of Object.entries<any>(patch)) {
      doc[key] = value?.__op === "Increment" ? (doc[key] ?? 0) + value.amount : structuredClone(value);
    }
    return structuredClone(doc);
  };
  const DB = {
    // Cede el turno como un adapter real, para que los checkouts concurrentes se intercalen
    findOne: async (name: string, query: any) => {
      await Promise.resolve();
      const doc = table(name).find((d) => matches(d, query.where));
      return doc ? structuredClone(doc) : null;
    },
    find: async (name: string, query: any) => {
      await Promise.resolve();
      return table(name).filter((d) => matches(d, query.where)).map((d) => structuredClone(d));
    },
    insert: async (name: string, doc: any) => {
      await Promise.resolve();
      if (failInsertOn === name) throw new Error("insert failed");
      const created = { ...structuredClone(doc), objectId: `${name}-${nextId++}` };
      table(name).push(created);
      return structuredClone(created);
    },
    update: async (name: string, id: string, patch: any) => {
      await Promise.resolve();
      const doc = table(name).find((d) => d.objectId === id);
      if (!doc) throw new Error(`${name} ${id} not found`);
      return apply(doc, patch);
    },
    // Sin await entre comprobar y escribir: atómico, como en el motor real
    updateIf: async (name: string, id: string, conditions: any, patch: any) => {
      await Promise.resolve();
      const doc = table(name).find((d) => d.objectId === id);
      return doc && matches(doc, conditions) ? apply(doc, patch) : null;
    },
  };

  const Zen = {
    DB,
    Cloud: {
      define: (name: string, handler: any) => functions.set(name, handler),
      afterSave: (name: string, handler: any) => triggers.set(`afterSave:${name}`, handler),
      beforeSave: (name: string, handler: any) => triggers.set(`beforeSave:${name}`, handler),
    },
  };

  const log = console.log;
  console.log = () => {};
  installEcommercePlugin(Zen);
  console.log = log;

  table("Product").push({ objectId: "p1", name: "Teclado", sku: "T1", salePrice: 10, stockQty: stock });
  table("StoreCountryRule").push({ ...RULE });

  const call = (name: string, params: any, auth: { user?: string; master?: boolean } = {}) =>
    functions.get(name)!({
      params,
      user: auth.user ? { objectId: auth.user } : undefined,
      master: !!auth.master,
    });

  return {
    call,
    tables,
    triggers,
    stock: () => table("Product")[0].stockQty,
    cart: (id: string) => table("Cart").find((c) => c.objectId === id),
    failInsert: (name?: string) => { failInsertOn = name; },
  };
}

async function assertStatus(promise: Promise<unknown>, status: number) {
  const err = await assertRejects(() => promise, ZenithError);
  assertEquals((err as ZenithError).httpStatus, status);
}

// ─── Identidad ───────────────────────────────────

Deno.test("addToCart - sin sesión ni sessionId se rechaza", async () => {
  const t = setup();
  await assertStatus(t.call("store_addToCart", { productId: "p1" }), 401);
});

Deno.test("addToCart - un userId en params no suplanta a otro usuario", async () => {
  const t = setup();
  await assertStatus(t.call("store_addToCart", { productId: "p1", userId: "victima" }), 401);
  const { cartId } = await t.call("store_addToCart", { productId: "p1", userId: "victima" }, { user: "atacante" });
  assertEquals(t.cart(cartId).ownerId, "atacante");
});

Deno.test("addToCart - master puede actuar en nombre de un usuario", async () => {
  const t = setup();
  const { cartId } = await t.call("store_addToCart", { productId: "p1", userId: "u1" }, { master: true });
  assertEquals(t.cart(cartId).ownerId, "u1");
});

Deno.test("addToCart - rechaza un sessionId corto de invitado", async () => {
  const t = setup();
  await assertStatus(t.call("store_addToCart", { productId: "p1", sessionId: "abc" }), 401);
});

Deno.test("addToCart - rechaza cantidades no enteras o negativas", async () => {
  const t = setup();
  for (const qty of [0, -1, 1.5, "2"]) {
    await assertRejects(() => t.call("store_addToCart", { productId: "p1", qty }, { user: "u1" }), ZenithError);
  }
});

// ─── Dueño del carrito ───────────────────────────

Deno.test("carrito de usuario - otro usuario no puede modificarlo ni pagarlo", async () => {
  const t = setup();
  const { cartId } = await t.call("store_addToCart", { productId: "p1" }, { user: "dueno" });
  const otro = { user: "otro" };
  await assertStatus(t.call("store_removeFromCart", { cartId, productId: "p1" }, otro), 403);
  await assertStatus(t.call("store_checkout", { cartId, ...CHECKOUT }, otro), 403);
  await assertStatus(t.call("store_applyDiscount", { cartId, code: "X" }, otro), 403);
  await assertStatus(t.call("store_checkout", { cartId, ...CHECKOUT }), 403);
  assertEquals(t.cart(cartId).status, "active");
  assertEquals(t.stock(), 5);
});

Deno.test("carrito de invitado - exige el mismo sessionId", async () => {
  const t = setup();
  const { cartId } = await t.call("store_addToCart", { productId: "p1", sessionId: GUEST });
  await assertStatus(t.call("store_checkout", { cartId, sessionId: OTHER_GUEST, ...CHECKOUT }), 403);
  await assertStatus(t.call("store_checkout", { cartId, ...CHECKOUT }), 403);
  await assertStatus(t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "alguien" }), 403);
  const { order } = await t.call("store_checkout", { cartId, sessionId: GUEST, ...CHECKOUT });
  assertEquals(order.status, "pending");
});

Deno.test("carrito sin dueño identificable - solo master accede", async () => {
  const t = setup();
  t.tables.Cart = [{ objectId: "c9", status: "active", items: [], user: { _id: "u1" } }];
  await assertStatus(t.call("store_removeFromCart", { cartId: "c9", productId: "p1" }, { user: "u1" }), 403);
  await assertStatus(t.call("store_removeFromCart", { cartId: "c9", productId: "p1", sessionId: GUEST }), 403);
  const result = await t.call("store_removeFromCart", { cartId: "c9", productId: "p1" }, { master: true });
  assertEquals(result.cartId, "c9");
});

Deno.test("getOrdersByUser - solo devuelve las órdenes propias", async () => {
  const t = setup();
  const { cartId } = await t.call("store_addToCart", { productId: "p1" }, { user: "u1" });
  await t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" });
  await assertStatus(t.call("store_getOrdersByUser", {}), 401);
  await assertStatus(t.call("store_getOrdersByUser", { userId: "u1" }, { user: "u2" }), 403);
  assertEquals((await t.call("store_getOrdersByUser", {}, { user: "u1" })).count, 1);
  assertEquals((await t.call("store_getOrdersByUser", {}, { user: "u2" })).count, 0);
  assertEquals((await t.call("store_getOrdersByUser", { userId: "u1" }, { master: true })).count, 1);
});

// ─── Stock ───────────────────────────────────────

Deno.test("addToCart - cuenta lo que ya está en el carrito", async () => {
  const t = setup(3);
  await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  await assertRejects(() => t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" }), ZenithError);
  const { items } = await t.call("store_addToCart", { productId: "p1", qty: 1 }, { user: "u1" });
  assertEquals(items[0].qty, 3);
});

Deno.test("checkout - descuenta stock y completa el carrito", async () => {
  const t = setup(5);
  const { cartId } = await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  const { order } = await t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" });
  assertEquals(t.stock(), 3);
  assertEquals(t.cart(cartId).status, "completed");
  assertEquals(order.ownerId, "u1");
});

Deno.test("checkout - no se puede pagar dos veces el mismo carrito", async () => {
  const t = setup(5);
  const { cartId } = await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  await t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" });
  await assertStatus(t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" }), 400);
  assertEquals(t.stock(), 3);
});

Deno.test("checkout - si el stock se agotó, no crea orden y deja el carrito activo", async () => {
  const t = setup(2);
  const { cartId } = await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  t.tables.Product[0].stockQty = 1;
  await assertRejects(() => t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" }), ZenithError);
  assertEquals(t.stock(), 1);
  assertEquals(t.cart(cartId).status, "active");
  assertEquals(t.tables.Order ?? [], []);
});

Deno.test("checkout - si falla crear la orden, devuelve el stock", async () => {
  const t = setup(5);
  const { cartId } = await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  t.failInsert("Order");
  await assertRejects(() => t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" }), Error, "insert failed");
  assertEquals(t.stock(), 5);
  assertEquals(t.cart(cartId).status, "active");
});

Deno.test("checkout - revierte los items ya reservados si otro no alcanza", async () => {
  const t = setup(5);
  t.tables.Product.push({ objectId: "p2", name: "Mouse", salePrice: 5, stockQty: 1 });
  await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  const { cartId } = await t.call("store_addToCart", { productId: "p2", qty: 1 }, { user: "u1" });
  t.tables.Product[1].stockQty = 0;
  await assertRejects(() => t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" }), ZenithError);
  assertEquals(t.tables.Product[0].stockQty, 5);
  assertEquals(t.tables.Product[1].stockQty, 0);
});

Deno.test("checkout concurrente - la última unidad se vende exactamente una vez", async () => {
  const t = setup(1);
  const users = ["u1", "u2", "u3", "u4"];
  const carts: string[] = [];
  for (const user of users) carts.push((await t.call("store_addToCart", { productId: "p1" }, { user })).cartId);
  const results = await Promise.allSettled(
    users.map((user, i) => t.call("store_checkout", { cartId: carts[i], ...CHECKOUT }, { user })),
  );
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  assertEquals(t.stock(), 0);
  assertEquals(t.tables.Order.length, 1);
});

Deno.test("checkout concurrente - el mismo carrito crea una sola orden", async () => {
  const t = setup(10);
  const { cartId } = await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" })),
  );
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  assertEquals(t.tables.Order.length, 1);
  assertEquals(t.stock(), 8);
  assertEquals(t.cart(cartId).status, "completed");
});

// ─── Descuentos ──────────────────────────────────

Deno.test("applyDiscount - reaplicar el código no consume otro uso", async () => {
  const t = setup();
  t.tables.Discount = [{ objectId: "d1", code: "PROMO", type: "fixed", value: 1, isActive: true, usedCount: 0 }];
  const { cartId } = await t.call("store_addToCart", { productId: "p1" }, { user: "u1" });
  await t.call("store_applyDiscount", { cartId, code: "PROMO" }, { user: "u1" });
  await t.call("store_applyDiscount", { cartId, code: "PROMO" }, { user: "u1" });
  assertEquals(t.tables.Discount[0].usedCount, 1);
});

// ─── Motor por país ──────────────────────────────

Deno.test("checkout - calcula impuesto y envío con la regla del país", async () => {
  const t = setup();
  const { cartId } = await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  const { order } = await t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" });
  assertEquals([order.subtotal, order.tax, order.shipping, order.total], [20, 2, 5, 27]);
  assertEquals(order.countryCode, "XX");
});

Deno.test("checkout - sin regla para el destino no vende ni toca el stock", async () => {
  const t = setup();
  const { cartId } = await t.call("store_addToCart", { productId: "p1" }, { user: "u1" });
  const params = { cartId, ...CHECKOUT, shippingAddress: { country: "ZZ" } };
  await assertStatus(t.call("store_checkout", params, { user: "u1" }), 400);
  assertEquals(t.stock(), 5);
  assertEquals(t.cart(cartId).status, "active");
});

Deno.test("checkout - rechaza una moneda distinta a la del carrito", async () => {
  const t = setup();
  t.tables.StoreCountryRule[0].currency = "EUR";
  const { cartId } = await t.call("store_addToCart", { productId: "p1" }, { user: "u1" });
  await assertStatus(t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" }), 400);
});

Deno.test("store_quote - la subdivisión tiene prioridad y exige ser dueño", async () => {
  const t = setup();
  t.tables.StoreCountryRule.push({ ...RULE, objectId: "r2", code: "XX-A", taxRate: 20 });
  const { cartId } = await t.call("store_addToCart", { productId: "p1" }, { user: "u1" });
  const address = { country: "XX", region: "XX-A" };
  const quote = await t.call("store_quote", { cartId, shippingAddress: address }, { user: "u1" });
  assertEquals([quote.tax, quote.countryCode], [2, "XX-A"]);
  await assertStatus(t.call("store_quote", { cartId, shippingAddress: address }, { user: "u2" }), 403);
});

Deno.test("cupón de envío gratis - anula el envío de la regla", async () => {
  const t = setup();
  t.tables.Discount = [{ objectId: "d1", code: "ENVIO", type: "free_shipping", value: 0, isActive: true, usedCount: 0 }];
  const { cartId } = await t.call("store_addToCart", { productId: "p1" }, { user: "u1" });
  await t.call("store_applyDiscount", { cartId, code: "ENVIO" }, { user: "u1" });
  const { order } = await t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" });
  assertEquals([order.shipping, order.total], [0, 11]);
});

Deno.test("store_setCountryRule - solo con Master Key y con datos válidos", async () => {
  const t = setup();
  const rule = { code: "yy", currency: "usd", taxRate: 5, shippingFlat: 1 };
  await assertStatus(t.call("store_setCountryRule", rule, { user: "u1" }), 403);
  await assertRejects(() => t.call("store_setCountryRule", { ...rule, taxRate: 150 }, { master: true }), ZenithError);
  const created = await t.call("store_setCountryRule", rule, { master: true });
  assertEquals([created.code, created.currency], ["YY", "USD"]);
});

// ─── Cancelación ─────────────────────────────────

async function paidOrder(t: ReturnType<typeof setup>) {
  const { cartId } = await t.call("store_addToCart", { productId: "p1", qty: 2 }, { user: "u1" });
  return (await t.call("store_checkout", { cartId, ...CHECKOUT }, { user: "u1" })).order;
}

Deno.test("cancelar orden - devuelve el stock una sola vez", async () => {
  const t = setup(5);
  const order = await paidOrder(t);
  const trigger = t.triggers.get("afterSave:Order")!;
  const cancelled = { ...order, status: "cancelled" };
  await trigger({ object: cancelled, original: order });
  assertEquals(t.stock(), 5);
  await trigger({ object: cancelled, original: cancelled });
  assertEquals(t.stock(), 5);
});

Deno.test("cancelar orden - no devuelve stock si ya se envió", async () => {
  const t = setup(5);
  const order = await paidOrder(t);
  const shipped = { ...order, status: "shipped" };
  await t.triggers.get("afterSave:Order")!({ object: { ...order, status: "cancelled" }, original: shipped });
  assertEquals(t.stock(), 3);
});

// ─── Cálculo ─────────────────────────────────────

Deno.test("computeTotals - precio con impuesto incluido lo desglosa sin sumarlo", () => {
  const totals = computeTotals({
    subtotal: 110, discount: 0, freeShipping: false,
    rule: { code: "XX", currency: "USD", taxRate: 10, taxIncluded: true, shippingFlat: 0 },
  });
  assertEquals([totals.tax, totals.total], [10, 110]);
});

Deno.test("computeTotals - respeta envío gravado, envío gratis y decimales", () => {
  const rule = { code: "XX", currency: "CLP", decimals: 0, taxRate: 19, taxableShipping: true, shippingFlat: 1000, freeShippingFrom: 50000 };
  const low = computeTotals({ subtotal: 10000, discount: 0, freeShipping: false, rule });
  assertEquals([low.shipping, low.tax, low.total], [1000, 2090, 13090]);
  const high = computeTotals({ subtotal: 50000, discount: 0, freeShipping: false, rule });
  assertEquals([high.shipping, high.tax], [0, 9500]);
});
