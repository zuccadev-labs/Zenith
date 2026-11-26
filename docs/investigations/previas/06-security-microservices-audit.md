---
description: "Investigación previa al código actual: 06 — Hardening de Seguridad, Microservicios y Auditoría Corporativa."
tipo: investigacion
estado: histórica
---

# 06 — Hardening de Seguridad, Microservicios y Auditoría Corporativa

> **Nota del 2026-11-26.** La escribí antes del código actual: sus imports y rutas (`@zenith/core`, `src/cli/`…)
> no son los de hoy. La dejo porque explica de dónde salen varias decisiones. Lo vigente está en
> [Usar Zenith](../../users/README.md).

> **Fase**: Implementación Enterprise  
> **Autor**: Equipo Zenith — @zuccadev-labs  
> **Fecha**: 2026-05-22  
> **Estado**: Implementado v1.0  
> **Prerrequisito**: [05_observability_and_openapi.md](./05-observability-and-openapi.md)

---

## 1. Seguridad en Dos Capas: CLPs + ACLs

### 1.1 Decisión Arquitectónica (ADR)
Parse Server implementa seguridad en dos niveles complementarios. Zenith adopta esta misma filosofía:

- **Class Level Permissions (CLP):** Reglas a nivel de tabla. Definen quién puede hacer `find`, `get`, `create`, `update`, `delete` sobre una clase entera. Se configuran vía `PUT /schemas/:className` con Master Key.
- **Object Level ACL:** Reglas a nivel de fila. Cada objeto puede tener un campo `ACL` que define permisos por usuario o rol específico.

**Flujo de Evaluación:**
```
Request → CLP Check → ACL Check → Operación en BD
```

El motor CLP se evalúa **antes** del ACL. Si el CLP niega la operación, el ACL del objeto nunca se evalúa. Esto es exactamente como funciona Parse Server.

### 1.2 Zero-Trust Mode
Configurable vía `zen.config.ts`. Cuando `zeroTrustMode: true`, los objetos sin ACL explícito deniegan todo acceso. Cuando `false` (default, compatibilidad Parse), los objetos sin ACL son públicos.

### 1.3 `requiresAuthentication`
Si una CLP define `requiresAuthentication: true` para una operación, cualquier request sin un JWT válido recibirá HTTP 403. Esto protege clases sensibles sin necesidad de configurar roles.

---

## 2. Rate Limiting (Infraestructura Pura)

### 2.1 Decisión Arquitectónica (ADR)
Se adopta `Deno.Kv` como almacén de contadores de rate limiting por su latencia sub-milisegundo y por ser nativo de Deno (cero dependencias externas).

**Justificación:**
- **No es visible para el usuario final.** Es un mecanismo transparente del pipeline que cuenta peticiones por IP.
- **Anti-fuerza bruta:** Los endpoints `/login` y `/users` tienen una cuota estricta de 10 req/min por IP. Si un atacante intenta millones de contraseñas, será bloqueado con HTTP 429 después de 10 intentos.
- **Anti-DDoS global:** Todos los demás endpoints tienen una cuota de 100 req/min por IP.
- **Master Key bypass:** Las operaciones administrativas no están sujetas a rate limiting.

### 2.2 Posición en el Pipeline
El rate limiter se ejecuta **después** de la autenticación y **antes** del routing. Esto permite que el sistema identifique al usuario (si existe) antes de evaluar la cuota.

---

## 3. Arquitectura de Microservicios (Cloud Native)

### 3.1 Decisión Arquitectónica (ADR)
Se desmanteló el Router Monolítico (`buildZenithRouter`) y se creó un Router Dinámico (`buildDynamicRouter`) que descubre rutas automáticamente.

**Justificación:**
- **Kubernetes-Ready:** Cada Trait declara sus propias rutas HTTP mediante un array `routes`. Si un binario de Zenith se compone solo con `[MediaStreamTrait]`, ese pod expondrá únicamente `/media/*`. Las rutas `/classes/*` y `/users` **no existirán** en memoria.
- **Eliminación de acoplamiento:** El archivo `router.ts` ya no conoce la existencia de ningún Trait específico. Solo itera las dependencias inyectadas y monta lo que encuentre.
- **Binarios independientes:** Esto prepara el camino para que CI/CD compile distintos contenedores Docker:
  - `zenith-api` → ServerTrait + RestCrudTrait + UserTrait + SchemaTrait
  - `zenith-media` → ServerTrait + MediaStreamTrait
  - `zenith-full` → Todos los Traits

### 3.2 `RestCrudTrait`
Las operaciones genéricas de base de datos (`GET /classes/:className`, etc.) se extrajeron a un Trait independiente que consume `database-crud`, `schema-validation` y `access-control`. Esto garantiza que la seguridad (CLPs + ACLs) se evalúe obligatoriamente antes de cualquier operación CRUD.

---

## 4. Resolución de Autenticación en el Pipeline

### 4.1 Decisión Arquitectónica (ADR)
Se creó el paso `resolveAuthentication()` que se ejecuta en cada request para decodificar el JWT e inyectar `ctx.auth` (userId + roles) de forma inmutable en el contexto.

**Justificación:**
- Sin este paso, el motor de CLPs y ACLs estaba "ciego": evaluaba permisos pero nunca sabía quién era el usuario.
- El JWT asimétrico (RS256) permite validar la identidad **sin consultar la base de datos**, reduciendo la latencia a cero para la fase de autenticación.
- Si el token es inválido o no existe, el usuario queda como "anónimo" y el ACL/CLP decidirá si tiene acceso.

---

## 5. Auditoría Post-Implementación

Se ejecutó una auditoría completa de los 20 archivos fuente. Se encontraron y corrigieron 6 hallazgos:

| ID | Severidad | Descripción |
|---|---|---|
| AUDIT-1 | Crítico | `RateLimitTrait` y `RestCrudTrait` no registrados en composición de Barrits |
| AUDIT-2 | Crítico | Rate Limiter existía pero no estaba conectado al pipeline |
| AUDIT-3 | Alto | MediaTrait lanzaba `new Error()` causando HTTP 500 genéricos |
| AUDIT-4 | Alto | Errores internos de MediaTrait sin códigos HTTP semánticos |
| AUDIT-5 | Medio | Validación de registro emitía error de servidor (500) en vez de cliente (400) |
| AUDIT-6 | Medio | Tipo `ZenithAuthContext` definía campos muertos (`isMaster`, `isReadOnly`) |

Todos los hallazgos fueron corregidos en el mismo ciclo de auditoría.
