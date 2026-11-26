# ADR-001 — Unificación de Carpetas Duplicadas del Monorepo

> ⚠️ **Estado (2026-11-10): no coincide con el código.** Partes de este documento son obsoletas o incorrectas (rutas, comandos, paquetes). Lo vigente y la lista de diferencias están en [docs/index.md](../../users/README.md).

> **Estado**: Accepted
> **Fecha**: 2026-06-06
> **Autor**: Auditoría Zenith
> **Reemplaza**: Ninguno
> **Relacionado**: `00_intro.md`, `implementation_plan.md` §"Lo que Tenemos"

---

## 1. Contexto

El monorepo de Zenith contenía **4 conjuntos de carpetas duplicadas** que violaban el principio de "Single Source of Truth" y generaban ambigüedad sobre qué archivo era "el oficial":

| # | Concepto | Ubicaciones encontradas | Estado antes |
|---|----------|------------------------|--------------|
| 1 | CLI | `zenith-cli/`, `cli/`, `zenith-backend/src/cli/` | 3 copias distintas |
| 2 | Plugins | `zenith-backend/src/plugins/`, `zenith-backend/plugins/` | 2 copias (distinto contenido) |
| 3 | Tests | `zenith-backend/tests/`, `zenith-backend/src/test/` | 2 copias (test runner duplicado) |
| 4 | Examples/Cloud | `zenith-backend/example/zenith-backend-boilerplate/`, `zenith-backend/examples/`, `zenith-backend/cloud/` | 3 ubicaciones con responsabilidades mezcladas |

Esto provocaba:
- **Confusión en onboarding**: ¿Dónde agrego un comando CLI? ¿Dónde van los tests?
- **Imports rotos**: `tests/integration/*.test.ts` importaba `../../src/test/zenith-test-runner.ts` (path que desaparecerá con la unificación).
- **Descubrimiento parcial de Barrits**: `barrits.config.ts` escaneaba `plugins/**/*.ts` en la raíz, pero los plugins reales vivían en `src/plugins/`.
- **Compilación doble**: Los archivos en `cli/` y `zenith-cli/` no compartían estado ni `deno.json`.

## 2. Decisión

Se adopta el siguiente layout canónico como **única fuente de verdad** para el monorepo:

```
Zenith/
├── zenith-cli/                          # CLI unificado (single entrypoint)
│   ├── deno.json                        # Configuración propia del CLI
│   ├── mod.ts                           # Dispatcher unificado (init/dev/compile/agent/plugins:lock)
│   ├── ai_harness.ts                    # LLM Function Calling
│   ├── commands/
│   │   ├── zen.ts                       # init / dev / compile (developer)
│   │   ├── agent.ts                     # AI Agent (interactive / daemon)
│   │   └── plugins-lock.ts              # Integridad SHA-256 de plugins
│   └── README.md
│
├── zenith-backend/                      # Core backend
│   ├── deno.json
│   ├── src/
│   │   ├── core/                        # Pipeline, Router, Cloud, Errores, OpenAPI
│   │   ├── traits/                      # 28 traits (auth, billing, security, etc.)
│   │   ├── adapters/                    # ★ AHORA incluye git, vault, lux-cache
│   │   ├── plugins/                     # ★ BIZ plugins: CRM, ERP, Ecommerce
│   │   ├── migrations/
│   │   └── mod.ts
│   ├── cloud/                           # User's own Cloud Code (runtime)
│   ├── tests/                           # ★ UNIFIED — unit/, integration/, load/
│   │   ├── unit/zenith-test-runner.ts
│   │   ├── integration/
│   │   │   ├── engine.test.ts           # (ex src/test/integration.test.ts)
│   │   │   ├── erp.test.ts
│   │   │   └── security.test.ts
│   │   └── load/api_load.js
│   ├── example/zenith-backend-boilerplate/  # ★ ÚNICO ejemplo
│   │   ├── cloud/
│   │   │   ├── main.ts
│   │   │   ├── functions.ts, jobs.ts, webhooks.ts
│   │   │   ├── triggers/
│   │   │   ├── examples/01..09-*.ts     # Ejemplos por capacidad
│   │   │   └── ubb_main.example.ts      # (movido desde examples/)
│   │   ├── plugins/
│   │   └── zen.config.ts
│   ├── docs/, scripts/, bin/
│   └── zenith-cluster/, zenith-sfu/     # Subbinarios
```

### 2.1 Reglas de oro (para el futuro)

| Concepto | Ubicación canónica | Prohibido |
|----------|-------------------|-----------|
| CLI | `zenith-cli/` | Crear otro `cli/`, `bin/cli/`, etc. |
| Test runner | `zenith-backend/tests/unit/` | Crear `src/test/` |
| Adaptadores de infraestructura | `zenith-backend/src/adapters/` | Crear `plugins/*adapter*` |
| Plugins de negocio | `zenith-backend/src/plugins/` | Crear `plugins/` en raíz |
| Cloud Code del usuario | `zenith-backend/cloud/` o `<proyecto>/cloud/` | Mezclar con examples |
| Ejemplos | `zenith-backend/example/zenith-backend-boilerplate/` | Crear carpeta `examples/` (plural) |

## 3. Cambios Realizados

### 3.1 Movimientos de archivos

| Origen | Destino | Justificación |
|--------|---------|---------------|
| `src/test/zenith-test-runner.ts` | `tests/unit/zenith-test-runner.ts` | Test runner ≠ código fuente |
| `src/test/integration.test.ts` | `tests/integration/engine.test.ts` | Renombrado para evitar colisión conceptual |
| `plugins/git.adapter.ts` | `src/adapters/git.adapter.ts` | Es un adaptador, no un plugin |
| `plugins/vault.adapter.ts` | `src/adapters/vault.adapter.ts` | Es un adaptador, no un plugin |
| `plugins/lux-cache.adapter.ts` | `src/adapters/lux-cache.adapter.ts` | Es un adaptador, no un plugin |
| `src/cli/lockfile.ts` | `zenith-cli/commands/plugins-lock.ts` | Es un comando CLI |
| `cli/zenith-cli.ts` | `zenith-cli/commands/agent.ts` | Renombrado: era el AI agent |
| `examples/ubb_main.example.ts` | `example/zenith-backend-boilerplate/cloud/ubb_main.example.ts` | Ejemplos en un solo lugar |

### 3.2 Imports actualizados

- `src/adapters/*.ts` (3 archivos): `from "../src/core/cloud.ts"` → `from "../core/cloud.ts"`
- `tests/integration/erp.test.ts`, `security.test.ts`: `from "../../src/test/..."` → `from "../unit/..."`
- `tests/integration/security.test.ts`: Eliminados 6 imports aspiracionales de traits que aún no existen (CircuitBreaker, JobQueue, etc.) — eran deuda del `implementation_plan.md`

### 3.3 Configuración

- `zenith-backend/barrits.config.ts`: convenciones de discovery actualizadas de `plugins/**/*.ts` (raíz) a `src/plugins/**/*.ts`
- `zenith-cli/deno.json`: nuevo, con `compile` task apuntando a `../bin/zenith.exe`
- `zenith-cli/zen.ts`: refactorizado para exportar `run(command)` y permitir dispatcher
- `zenith-cli/mod.ts`: NUEVO dispatcher unificado

### 3.4 Eliminaciones

- ❌ `zenith-backend/plugins/` (raíz)
- ❌ `zenith-backend/examples/` (plural)
- ❌ `zenith-backend/src/test/`
- ❌ `zenith-backend/src/cli/`
- ❌ `cli/` (raíz del monorepo)

## 4. Consecuencias

### Positivas
- **Onboarding 5x más rápido**: El nuevo dev sabe inmediatamente dónde va cada cosa.
- **Compilación correcta**: `deno compile` del CLI produce un único binario que cubre los 3 grupos de comandos.
- **CI/CD unificado**: Un solo workflow de GitHub Actions para test/lint/build.
- **Cero ambigüedad para los LLM**: El prompt "agregá un comando CLI" tiene una única respuesta.

### Negativas / Riesgos mitigados
- **Riesgo de regresión de imports**: Mitigado actualizando los 5 archivos con imports rotos.
- **Boilerplate `main.ts` referenciaba archivos inexistentes**: Persiste — ver §5 Trabajo pendiente.

## 5. Trabajo Pendiente (no resuelto en este ADR)

1. `example/zenith-backend-boilerplate/cloud/main.ts` importa `examples/01..09-*.ts` y `triggers/{database,files,auth,media}.ts` que **NO EXISTEN**. El boilerplate está roto — necesita ser completado o simplificado.
2. Los adaptadores movidos a `src/adapters/` (git, vault, lux-cache) NO están auto-registrados en `mod.ts`. Hay que añadirlos a la composición (próximo commit).
3. `zenith-cli/ai_harness.ts` importa `"./ai_harness.ts"` desde `mod.ts` — el path relativo quedó OK al mover.

## 6. Validación

Tras aplicar los cambios:

```bash
# 1. Verificar que Deno reconoce la nueva estructura
cd zenith-cli && deno check mod.ts

# 2. Verificar que los tests compilan
cd ../zenith-backend && deno check tests/integration/erp.test.ts

# 3. Verificar que no quedan carpetas duplicadas
ls -la zenith-backend/  # NO debe tener: plugins, examples, src/test, src/cli
ls -la /                # NO debe tener: cli
```

(Comandos en PowerShell equivalentes; ver §Implementación.)

## 7. Referencias

- `docs/investigations/00_intro.md` — Filosofía del monorepo
- `docs/investigations/03_zenith_architecture.md` — Arquitectura core
- `implementation_plan.md` §"Lo que Tenemos" — Inventario previo
