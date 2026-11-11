import { ZenLogger, ZenPlugins } from "../core/cloud.ts";

/**
 * LuxDB Cache Plugin
 * Este plugin sobrescribe el comportamiento por defecto de la caché de Zenith.
 * Se inicializa automáticamente si Deno.env.get("LUX_DB_URL") está configurado.
 *
 * Ventajas: Reutilizable, desacoplado del motor central y escalable.
 */

const LUX_DB_URL = Deno.env.get("LUX_DB_URL");

if (LUX_DB_URL) {
  ZenLogger.info(`[Plugin:LuxCache] Activando caché de alto rendimiento en ${LUX_DB_URL}...`);

  // Registramos este adaptador en el namespace oficial esperado por ZenConfig
  ZenPlugins.CacheAdapter = {
    get: async (key: string) => {
      try {
        const res = await fetch(`${LUX_DB_URL}/kv/${key}`);
        if (res.ok) {
          const data = await res.json();
          return data.value;
        }
      } catch (e) {
        ZenLogger.warn(`[Plugin:LuxCache] Get failed for key ${key}: ${e}`);
      }
      return null;
    },
    set: async (key: string, value: any) => {
      try {
        await fetch(`${LUX_DB_URL}/kv/${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
      } catch (e) {
        ZenLogger.warn(`[Plugin:LuxCache] Set failed for key ${key}: ${e}`);
      }
    },
  };
} else {
  // Opcional: Podríamos emitir un log de debug si no está configurado,
  // pero el motor central ya hace fallback silencioso a Deno.Kv
}
