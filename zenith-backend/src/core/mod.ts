/**
 * @module @zenith/core
 * Re-exporta el núcleo completo de Zenith.
 * 
 * Este es el módulo principal que los Traits y adapters importan.
 * Nunca importes desde archivos internos directamente — usa este mod.ts.
 */

export * from "./types.ts";
export * from "./errors.ts";
export * from "./schema.types.ts";
export { extractContext, extractSessionToken, applyCORS, validateAppId, runPipeline, createRequestHandler, resolveAuthentication, applyRateLimit } from "./pipeline.ts";
export * from "./router.ts";
