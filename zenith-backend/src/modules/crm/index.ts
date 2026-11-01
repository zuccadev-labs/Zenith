/**
 * CRM Module — Orchestrator (Legacy Compatibility Layer)
 *
 * Desde la adopción de ZenithCRMTrait, los schemas, triggers y rutas
 * del CRM son registrados automáticamente por Barrits al componer los traits.
 *
 * Este módulo se mantiene únicamente como punto de referencia para
 * extensiones adicionales vía `plugins/` de usuario final.
 * NO debe ser invocado directamente por el motor core.
 */

/**
 * Stub para compatibilidad hacia atrás con código de usuario que
 * importe `initCRMModule` desde versiones anteriores.
 * El motor ya no llama a esta función; el CRMTrait la reemplaza.
 */
export function initCRMModule(_Zen: any): void {
  console.warn("[CRMModule] DEPRECADO: initCRMModule() es un no-op. Los schemas y triggers CRM se registran automáticamente vía ZenithCRMTrait.");
}
