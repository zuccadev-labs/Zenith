# ADR-003: API Keys estilo Stripe con Argon2id

**Status:** Accepted (Phase 0.D) — ampliado por [ADR-015](ADR-015-api-key-access-policy.md) (2026-11-10): los scopes se aplican de verdad, política de IP, keys `*` acotadas y gestión solo con master key.
**Date:** 2026-06-06
**Deciders:** Zenith Security Audit Team

## Context

El sistema heredado usaba una **master key estática** por app, configurada
en `apps.config.ts` y leída de variables de entorno. Esto significaba:

- **CWE-798 (Hard-coded Credentials)**: si el operador olvidaba setear
  `APP1_MASTER_KEY`, el sistema caía al default `unsafe_default_APP1_MASTER_KEY`.
  Mitigado parcialmente en Phase 0.B con fail-closed en producción, pero el
  modelo conceptual seguía siendo "una sola clave todopoderosa".

- **Sin scopes**: cualquier key podía hacer cualquier cosa. No había forma de
  dar acceso de "solo lectura" a un dashboard de analytics sin darle también
  acceso a borrar usuarios.

- **Sin rotación**: cambiar la master key requería actualizar el config y
  reiniciar el backend, con downtime. No había "grace period" para migrar
  gradualmente.

- **Hash débil**: el código original generaba un par RSA y persistía la
  clave privada en MongoDB `_GlobalConfig`. Catastrófico si la DB se filtra.

- **Sin audit log por key**: no había forma de saber qué key se usó para
  cada request, ni de detectar uso anómalo (geográficamente, temporalmente).

- **Sin rate limit por key**: una sola key podía agotar el quota global.

Esto incumple los requisitos de Fortune 500 (PCI-DSS 8.2.1, SOC 2 CC6.1,
NIST 800-53 AC-2/AC-3).

## Decision

Adoptamos el modelo de **API Keys estilo Stripe** con:

### 1. Formato de key

```
<prefix>_<env>_<id>_<secret>

prefix:  sk (server)     | pk (publishable)    | rk (restricted)
env:     live            | test
id:      8 chars (público, aparece en logs)
secret:  32 chars (secreto real, hasheado con Argon2id)
```

Ejemplo: `sk_live_aB3xY9zK_qR7vN2pT8mE4wK6hJ1cV0sZ9bF2dL5gX`

### 2. Hash: Argon2id (no SHA-256, no bcrypt)

Parámetros OWASP 2026:
- `memoryCost: 65536` KiB (64 MiB)
- `timeCost: 3` iterations
- `parallelism: 4` lanes
- `hashLength: 32` bytes
- `saltLength: 16` bytes (CSPRNG)

Verificación es timing-safe por construcción de Argon2id.

### 3. Scopes jerárquicos (estilo OAuth)

```
*                                super admin
admin:* / admin:read / admin:write
data:* / data:read / data:write / data:create / data:delete
users:* / users:read / users:write
functions:* / functions:invoke / functions:deploy
files:* / files:read / files:write / files:delete
push:* / push:send
analytics:read
webhooks:* / webhooks:read / webhooks:write
```

Defaults seguros por prefijo:
- `sk_` (server): CRUD + users + files + functions + push + analytics
- `pk_` (publishable): solo lectura
- `rk_` (restricted): 1 scope configurable (default: `analytics:read`)

### 4. Rotación con grace period

`rotate(id)` genera una key nueva que hereda los scopes + metadata, y
marca la anterior con `rotationExpiresAt` (default 24h). Durante la grace
period, ambas keys funcionan. Después, solo la nueva.

Esto permite zero-downtime rotation: deployas la nueva key, verificas que
funciona, luego la vieja deja de funcionar automáticamente.

### 5. Audit log (ECS format)

Cada evento relevante se loggea a `./logs/api-key-audit.jsonl` en formato
Elastic Common Schema, con campos estructurados:
- `@timestamp`, `log.level`, `event.category`, `event.action`
- `key.id`, `key.prefix`, `key.env`, `key.app_id`, `key.name`, `key.scopes`
- `client.ip` (resuelta del socket, NO de X-Forwarded-For)
- `actor.id` (quién creó/revocó)
- `reason` (motivo de rechazo/revocación)

**Nunca se loggea el plaintext ni el hash de la key.**

### 6. Rate limit por key (sliding window)

Cada key tiene un `requestsPerMinute` configurable. Default: `sk=1000`,
`pk=6000`, `rk=60`. Implementación: sliding window in-memory. Para
multi-nodo, Fase 1.G: Redis ZADD/ZRANGEBYSCORE.

### 7. Persistencia

- **Dev / single-node**: `InMemoryStore` (thread-safe via Map)
- **Producción multi-nodo**: `MongoDBStore` (Fase 1.G, con change streams
  para propagación de revocaciones en <1s)

### 8. Integración en el pipeline (Phase 0.D done)

El `pipeline.extractContext` en `src/core/pipeline.ts` se modificó para
aceptar un objeto de opciones:

```ts
extractContext({
  configMasterKey,    // legacy master key (fallback)
  publicKeyStr,       // RSA public key para JWT Zen-Internal-Token
  trustedProxies,     // lista de IPs de proxies (H-02)
  apiKeyManager,      // nuevo: manager de API keys
  rateLimiter,        // nuevo: PerKeyRateLimiter (sliding window)
  audit,              // bool, default true
})
```

**Orden de prioridad en la autenticación (cada request):**

1. **JWT Zen-Internal-Token** (firma RSA + claims) → `masterKey = true`
2. **API key** (Bearer / X-API-Key / Zen-Api-Key / X-Parse-REST-API-Key)
   → `ctx.apiKey = { id, prefix, env, appId, name, scopes, rateLimit }`
   → NO se considera master key
3. **Master key estática** (solo desde localhost) → comparación SHA-256
   en tiempo constante

**Cambios en `ZenithRequestContext`:**
- `masterKey?: boolean` (antes era `string`, ahora es un flag — el valor
  real de la key NUNCA se almacena en el contexto para evitar leaks en
  logs serializados)
- `apiKey?: { id, prefix, env, appId, name, scopes, rateLimit }` (nuevo)
- `apiKeyRejected?: string` (nuevo; motivo de fallo si vino master key)

**ServerTrait (`src/core/server.trait.ts`):**
- Inicializa `ApiKeyManager(new InMemoryStore())` y `PerKeyRateLimiter()`
- Llama a `bootstrapApiKey()` en `getHandler()` para que la primera
  vez que arranca un dev, se cree una `sk_live` con scopes `*` y se
  imprima en stdout con un banner loud
- Pasa el manager al pipeline vía `extractContext({...apiKeyManager, rateLimiter})`

**Seguridad adicional ganada en la integración:**
- El campo `masterKey` ya no contiene el valor de la key, solo el flag
  de validación. Esto previene CWE-200 (Information Exposure) si el
  contexto se serializa a logs.
- El campo legacy `apiKey` (string con el header crudo) se eliminó del
  contexto por la misma razón.

### 9. Migración desde master key

El sistema viejo (master key estática + Parse-Server compat) se mantiene
**durante la fase de transición**. El `pipeline.extractContext` ahora
intenta primero API key (vía `Authorization: Bearer` o `X-API-Key`), y
cae al master key solo si la request viene de localhost Y trae
`X-Parse-Master-Key`. Una vez que todas las apps internas estén
migradas, el fallback se eliminará (Fase 2).

## Consequences

### Positive
- Scope granular por key: un dashboard público puede tener `pk_` con
  solo `data:read`, no puede borrar nada.
- Rotación sin downtime.
- Hash Argon2id: un dump de DB no permite login offline.
- Audit log por uso: detectamos anomalías (IP desconocida, volumen raro).
- Rate limit por key: una key comprometida no agota el quota global.
- Formato auto-identificable: `sk_live_*` se ve en logs / env vars /
  dashboards y se distingue de un secret genérico.
- **Flag-based masterKey en contexto**: previene CWE-200 si el contexto
  se serializa a logs (no se leak el valor real).
- **Auth flow con prioridad clara**: API key gana sobre master key,
  pero JWT gana sobre ambos. Esto habilita zero-trust en redes internas.

### Negative / Risks
- **Costo de CPU**: Argon2id con 64 MiB + 3 iteraciones tarda ~200ms por
  hash. Para una verificación típica, eso son 200ms en el path crítico.
  Mitigación: cache de verificaciones exitosas por 60s en memoria
  (TODO Fase 1.G: Redis cache).
- **Onboarding**: el operador debe correr `zenith api-keys create` después
  de cada deploy. Se mitiga con bootstrap: en el primer arranque, si
  no hay keys, se crea una `sk_live` con nombre "bootstrap" y se imprime
  en stdout (con warning loud).
- **Persistencia**: `MongoDBStore` no está implementado aún. Hoy,
  reiniciar el backend borra todas las keys. **NO usar en producción
  hasta Fase 1.G.**
- **El master key sigue funcionando** para Parse-Server compat. Esto
  es deliberado durante la transición, pero es un riesgo residual.
  Fecha de remoción: Fase 2.

### Operational
- Bootstrap: en el primer arranque, si no hay keys, se crea una `sk_live`
  con todos los scopes y se imprime una sola vez. El operador debe
  copiarla inmediatamente a su secret manager.
- Backup de keys: NO se puede — el secreto se muestra una sola vez.
  El operador es responsable de guardarlo en su secret manager.
  Recomendación: AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager.
- Rotation policy recomendada: cada 90 días para `sk_live_*`,
  cada 365 días para `sk_test_*`/`pk_*`/`rk_*`.

## Alternatives Considered

| Alternative | Rejected because |
|---|---|
| Mantener master key estática con scopes | No resuelve rotación ni hash débil |
| OAuth2 con JWTs | Overhead operacional (auth server, refresh tokens) para un caso de uso machine-to-machine. JWTs sin revocación inmediata. |
| mTLS para clients | Requiere infraestructura PKI por cliente; no apto para apps mobile/web |
| API keys estilo AWS (AKIA...) | Sin scopes estándar, sin rotation built-in |
| bcrypt | Más viejo que Argon2id; vulnerable a GPU attacks con suficiente presupuesto |

## References

- Stripe API Keys documentation
- OWASP Password Storage Cheat Sheet (Argon2id parameters 2026)
- RFC 9106 (Argon2 Memory-Hard Function)
- NIST SP 800-63B (Digital Identity Guidelines — Authenticator Assurance)
- PCI-DSS v4.0 Requirement 8.2.1 (strong authentication)
- SOC 2 CC6.1 (Logical access controls)
