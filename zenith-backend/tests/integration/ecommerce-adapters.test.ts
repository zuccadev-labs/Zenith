/**
 * Prueba updateIf y el checkout del plugin contra motores reales, con concurrencia real.
 *
 * Se ejecuta solo con las variables de entorno:
 *   ZENITH_TEST_MONGO_URI=mongodb://127.0.0.1:27017
 *   ZENITH_TEST_SURREAL_URL=http://127.0.0.1:8000
 */

import { assertEquals, assertExists } from "@std/assert";
import { MongoClient } from "mongodb";
import { createMongoAdapter } from "../../src/adapters/database/mongo.adapter.ts";
import { createSurrealAdapter, SurrealClient } from "../../src/adapters/database/surreal.adapter.ts";
import type { DatabaseAdapter } from "../../src/core/types.ts";
import { installEcommercePlugin } from "../../src/plugins/ecommerce.plugin.ts";

const RULE = { code: "XX", currency: "USD", decimals: 2, taxRate: 10, shippingFlat: 5, isActive: true };
const CHECKOUT = { shippingAddress: { country: "XX" }, paymentMethod: "card" };

function stockOf(doc: any): number {
  return Number(doc.stockQty);
}

function install(adapter: DatabaseAdapter) {
  const functions = new Map<string, (request: any) => Promise<any>>();
  const log = console.log;
  console.log = () => {};
  installEcommercePlugin({
    DB: adapter,
    Cloud: {
      define: (name: string, handler: any) => functions.set(name, handler),
      afterSave: () => {},
      beforeSave: () => {},
    },
  });
  console.log = log;
  return (name: string, params: any, user: string) =>
    functions.get(name)!({ params, user: { objectId: user }, master: false });
}

function suite(engine: string, withAdapter: (run: (adapter: DatabaseAdapter) => Promise<void>) => Promise<void>, ignore: boolean) {
  Deno.test({
    name: `${engine} - updateIf aplica solo si se cumple la condición, bajo concurrencia`,
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => withAdapter(async (adapter) => {
      const product = await adapter.insert("Product", { name: "A", stockQty: 3 } as any);
      const results = await Promise.all(Array.from({ length: 12 }, () =>
        adapter.updateIf!("Product", product.objectId!, { stockQty: { $gte: 1 } }, { stockQty: { __op: "Increment", amount: -1 } } as any)
      ));
      assertEquals(results.filter(Boolean).length, 3);
      const after = await adapter.findOne("Product", { where: { objectId: product.objectId } });
      assertExists(after);
      assertEquals(stockOf(after), 0);
    }),
  });

  Deno.test({
    name: `${engine} - update ejecuta Increment`,
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => withAdapter(async (adapter) => {
      const product = await adapter.insert("Product", { name: "B", stockQty: 3 } as any);
      await adapter.update("Product", product.objectId!, { stockQty: { __op: "Increment", amount: 2 } } as any);
      const after = await adapter.findOne("Product", { where: { objectId: product.objectId } });
      assertEquals(stockOf(after), 5);
    }),
  });

  Deno.test({
    name: `${engine} - checkouts simultáneos: última unidad y mismo carrito`,
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => withAdapter(async (adapter) => {
      const call = install(adapter);
      await adapter.insert("StoreCountryRule", { ...RULE } as any);
      const product = await adapter.insert("Product", { name: "C", sku: "C", salePrice: 10, stockQty: 1 } as any);

      const users = ["u1", "u2", "u3", "u4", "u5", "u6"];
      const carts: string[] = [];
      for (const user of users) carts.push((await call("store_addToCart", { productId: product.objectId }, user)).cartId);
      const contested = await Promise.allSettled(users.map((user, i) => call("store_checkout", { cartId: carts[i], ...CHECKOUT }, user)));
      assertEquals(contested.filter((r) => r.status === "fulfilled").length, 1);
      assertEquals(stockOf(await adapter.findOne("Product", { where: { objectId: product.objectId } })), 0);

      const plenty = await adapter.insert("Product", { name: "D", sku: "D", salePrice: 10, stockQty: 10 } as any);
      const { cartId } = await call("store_addToCart", { productId: plenty.objectId, qty: 2 }, "buyer");
      const repeated = await Promise.allSettled(Array.from({ length: 6 }, () => call("store_checkout", { cartId, ...CHECKOUT }, "buyer")));
      assertEquals(repeated.filter((r) => r.status === "fulfilled").length, 1);
      assertEquals(stockOf(await adapter.findOne("Product", { where: { objectId: plenty.objectId } })), 8);
    }),
  });
}

const mongoUri = Deno.env.get("ZENITH_TEST_MONGO_URI");
suite("mongo", async (run) => {
  const client = new MongoClient(mongoUri!);
  await client.connect();
  const db = client.db(`zenith_test_${crypto.randomUUID().slice(0, 8)}`);
  try {
    await run(createMongoAdapter(db as any));
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}, !mongoUri);

const surrealUrl = Deno.env.get("ZENITH_TEST_SURREAL_URL");
suite("surreal", async (run) => {
  const client = new SurrealClient({ url: surrealUrl!, user: "root", pass: "root", namespace: "zenith", database: `t${crypto.randomUUID().slice(0, 8)}` } as any);
  await run(createSurrealAdapter(client));
}, !surrealUrl);
