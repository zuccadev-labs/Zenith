/**
 * @module tests/unit/config-loader.test
 *
 * Regresión de seguridad CWE-798: el loader de configuración DEBE
 * fail-closed en producción cuando falta una variable requerida.
 *
 * ANTES: `requireEnv` devolvía `"unsafe_default_<name>"` incluso en
 * producción → un atacante que conociera el nombre de la env var
 * podía adivinar la master key.
 *
 * DESPUÉS: en `--mode=production`, cualquier env var faltante o
 * demasiado corta ABORTA el arranque.
 */

import { assertEquals, assertThrows } from "@std/assert";

// Helper: ejecutar main de un módulo con args limpios
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  mode: "dev" | "prod",
  fn: () => Promise<T>,
): Promise<T> {
  // Limpia y setea vars
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined) Deno.env.delete(k);
    else Deno.env.set(k, vars[k]!);
  }
  // Override del modo
  if (mode === "prod") {
    Deno.env.set("ZENITH_MODE", "production");
    // Deno.args no se puede modificar en runtime; usamos env var
  } else {
    Deno.env.delete("ZENITH_MODE");
  }

  try {
    return await fn();
  } finally {
    // Restore
    for (const k of Object.keys(vars)) Deno.env.delete(k);
    Deno.env.delete("ZENITH_MODE");
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("requireEnv — DEV mode: missing var returns unsafe_default_<name>", async () => {
  await withEnv({ TEST_VAR_MISSING_DEV: undefined }, "dev", async () => {
    const { requireEnv } = await import("../../config-loader.ts?dev1");
    const result = requireEnv("TEST_VAR_MISSING_DEV");
    assertEquals(result, "unsafe_default_TEST_VAR_MISSING_DEV");
  });
});

Deno.test("requireEnv — DEV mode: short var also throws (defense in depth)", async () => {
  // En DEV, un valor presente pero demasiado corto TAMBIÉN falla.
  // Esto es fail-loud: el dev se entera del problema en vez de continuar
  // con credenciales débiles. La única excepción es el placeholder
  // `unsafe_default_*` que es generado por la propia función.
  await withEnv({ TEST_VAR_SHORT_DEV: "short" }, "dev", async () => {
    const { requireEnv } = await import("../../config-loader.ts?dev2");
    assertThrows(
      () => requireEnv("TEST_VAR_SHORT_DEV", { minLength: 32, allowDevDefault: true }),
      Error,
      "too short",
    );
  });
});

Deno.test("requireEnv — PROD mode: missing var THROWS (fail-closed)", async () => {
  await withEnv({ TEST_VAR_MISSING_PROD: undefined }, "prod", async () => {
    const { requireEnv } = await import("../../config-loader.ts?prod1");
    assertThrows(
      () => requireEnv("TEST_VAR_MISSING_PROD", { minLength: 32, allowDevDefault: false }),
      Error,
      "TEST_VAR_MISSING_PROD",
    );
  });
});

Deno.test("requireEnv — PROD mode: short var THROWS (CWE-798 prevention)", async () => {
  await withEnv({ TEST_VAR_SHORT_PROD: "too_short" }, "prod", async () => {
    const { requireEnv } = await import("../../config-loader.ts?prod2");
    assertThrows(
      () => requireEnv("TEST_VAR_SHORT_PROD", { minLength: 32, allowDevDefault: false }),
      Error,
      "too short",
    );
  });
});

Deno.test("requireEnv — PROD mode: long enough var PASSES", async () => {
  const longKey = "a".repeat(64);
  await withEnv({ TEST_VAR_GOOD: longKey }, "prod", async () => {
    const { requireEnv } = await import("../../config-loader.ts?prod3");
    const result = requireEnv("TEST_VAR_GOOD", { minLength: 32, allowDevDefault: false });
    assertEquals(result, longKey);
  });
});

Deno.test("requireEnv — CWE-798 regression: attacker cannot guess master key via unsafe_default_", async () => {
  // El bug original: en producción, si APP1_MASTER_KEY no está seteada,
  // requireEnv devolvía "unsafe_default_APP1_MASTER_KEY".
  // Un atacante que conociera el nombre podía:
  //   1. Predecir la master key
  //   2. Acceder a toda la base de datos con permisos totales
  await withEnv({ APP1_MASTER_KEY: undefined }, "prod", async () => {
    const { requireEnv } = await import("../../config-loader.ts?cwe798");
    let thrown = false;
    try {
      requireEnv("APP1_MASTER_KEY", { minLength: 64, allowDevDefault: false });
    } catch {
      thrown = true;
    }
    assertEquals(thrown, true, "CWE-798: Production must fail-closed when master key is missing");
  });
});
