/**
 * ERP Module — Orchestrator (Legacy Compatibility Layer)
 *
 * Desde la adopción de ZenithERPTrait, los schemas, triggers y rutas
 * del ERP son registrados automáticamente por Barrits al componer los traits.
 *
 * Este módulo se mantiene únicamente como punto de referencia para
 * extensiones adicionales vía `plugins/` de usuario final.
 */

/**
 * Stub para compatibilidad hacia atrás.
 */
export function initERPModule(_Zen: any): void {
  console.warn(
    "[ERPModule] DEPRECADO: initERPModule() es un no-op. Los schemas y triggers ERP se registran automáticamente vía ZenithERPTrait.",
  );
}
