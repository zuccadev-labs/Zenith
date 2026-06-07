import { defineBarritsConfig } from "@zuccadev-labs/barrits";

/**
 * Barrits Trait Discovery
 *
 * Tras la unificación de carpetas (ADR-001), los plugins de negocio viven
 * exclusivamente en `src/plugins/`. La carpeta `/plugins` a nivel de raíz
 * ha sido eliminada — los adaptadores que contenía (git, vault, lux-cache)
 * fueron reubicados a `src/adapters/` porque SON adaptadores, no plugins.
 */
export default defineBarritsConfig({
  runtime: "deno",
  traitsDiscovery: {
    conventions: [
      "src/traits/**/*.ts",
      "src/traits/**/*.trait.ts",
      "src/plugins/**/*.ts",
      "src/plugins/**/*.trait.ts",
      "cloud/**/*.ts"
    ]
  },
  traitConflictStrategy: "error"
});
