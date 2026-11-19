/**
 * @plugin @zenith/crm-core (Open Source)
 *
 * CRM Core Plugin — Punto de entrada para usuarios que quieran extender la
 * lógica del CRM desde su `cloud/main.ts` o `plugins/` del proyecto.
 *
 * La lógica central (schemas, triggers, cloud functions, rutas HTTP)
 * está 100% encapsulada en el ZenithCRMTrait (src/traits/crm/crm.trait.ts).
 * Este plugin existe para permitir extensiones adicionales opcionales.
 *
 * Uso en cloud/main.ts del proyecto del usuario:
 *   import { Zen } from "@zuccadev-labs/zenith";
 *   // Agregar triggers o functions adicionales al CRM:
 *   Zen.Cloud.afterSave("Contact", async (req) => { ... });
 */

/**
 * No-op kept as the entry point of the CRM plugin: `CRMTrait` already sets up the CRM schemas,
 * triggers and routes. Extend the CRM from cloud code with `Zen.Cloud` hooks instead.
 */
export function installCRMPlugin(_Zen: any): void {
  // La inicialización completa del CRM (schemas, triggers, rutas)
  // se realiza automáticamente a través de ZenithCRMTrait en el motor.
}
