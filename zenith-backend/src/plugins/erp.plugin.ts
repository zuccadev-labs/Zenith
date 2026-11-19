/**
 * @plugin @zenith/erp-core (Open Source)
 *
 * ERP Core Plugin — Punto de entrada para usuarios que quieran extender la
 * lógica del ERP desde su `cloud/main.ts` o `plugins/` del proyecto.
 *
 * La lógica central (schemas, triggers, cloud functions, rutas HTTP)
 * está 100% encapsulada en el ZenithERPTrait (src/traits/erp/erp.trait.ts).
 * Este plugin existe para permitir extensiones adicionales opcionales.
 *
 * Uso en cloud/main.ts del proyecto del usuario:
 *   import { Zen } from "@zuccadev-labs/zenith";
 *   // Agregar triggers adicionales al ERP:
 *   Zen.Cloud.afterSave("Invoice", async (req) => { ... });
 */

/**
 * No-op kept as the entry point of the ERP plugin: `ERPTrait` already sets up the ERP schemas,
 * triggers and routes. Extend the ERP from cloud code with `Zen.Cloud` hooks instead.
 */
export function installERPPlugin(_Zen: any): void {
  // La inicialización completa del ERP (schemas, triggers, rutas)
  // se realiza automáticamente a través de ZenithERPTrait en el motor.
}
