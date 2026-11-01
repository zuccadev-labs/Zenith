/**
 * Tests para Zen.Cloud.defineSchema() — valores por defecto y campos requeridos.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { applySchema, defineSchema } from "../../src/core/cloud-schema.ts";
import { ZenithError } from "../../src/core/errors.ts";

Deno.test("applySchema - una clase sin registrar pasa intacta", () => {
  const doc = { a: 1 };
  assertEquals(applySchema("ClaseSinSchema", doc), doc);
});

Deno.test("applySchema - aplica valores por defecto sin compartir la referencia", () => {
  defineSchema("ConDefault", { items: { type: "Array", defaultValue: [] } });
  const first = applySchema("ConDefault", {});
  first.items.push(1);
  assertEquals(applySchema("ConDefault", {}).items, []);
});

Deno.test("applySchema - no pisa un valor enviado, ni siquiera si es falsy", () => {
  defineSchema("ConFalsy", { qty: { type: "Number", defaultValue: 5 } });
  assertEquals(applySchema("ConFalsy", { qty: 0 }).qty, 0);
});

Deno.test("applySchema - exige los campos requeridos", () => {
  defineSchema("ConRequerido", { name: { type: "String", required: true } });
  assertThrows(() => applySchema("ConRequerido", {}), ZenithError);
  assertEquals(applySchema("ConRequerido", { name: "x" }).name, "x");
});
