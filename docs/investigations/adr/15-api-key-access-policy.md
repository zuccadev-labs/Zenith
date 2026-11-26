---
description: "ADR-015 — Scopes y política de acceso de las API keys."
tipo: adr
estado: aceptada
---

# ADR-015 — Scopes y política de acceso de las API keys

> **Estado:** Aceptada
> **Fecha:** 2026-11-10
> **Relacionado:** `zenith-backend/src/security/api-keys/policy.ts`, `scopes.ts`, `manager.ts`, `routes.ts`,
> `bootstrap.ts`, `src/core/router.ts`, `src/traits/rest/crud.trait.ts`, ADR-003, ADR-013, ADR-014
> **Ampliada por:** [ADR-016](./16-shared-crypto-and-single-api-keys.md): un solo sistema de API keys (se retiró `/zen/apikeys` del trait workspace)

## Contexto

ADR-003 introdujo API keys al estilo de Stripe (`sk_`, `pk_` y `rk_`, con scopes). La auditoría del
2026-11-10 encontró que el modelo solo existía sobre el papel:

1. **Los scopes no se comprobaban.** El router daba acceso `user` a cualquier key válida, y `requireScope` no se
   llamaba en ningún sitio. Una `pk_`, que por definición es de solo lectura, podía escribir en `/classes` y
   `/batch`.
2. **Una key con scope `*` era la master key sin sus límites.** El router la trata como master (`isMaster`), pero:
   - la master key solo se acepta desde localhost y la key `*` valía desde cualquier IP;
   - podía no caducar nunca;
   - podía crear otras keys `*`, así que quien la robara podía hacerse permanente.
3. **La rotación ensanchaba la key.** `rotate()` no copiaba `expiresAt`: una key con caducidad rotaba a otra
   que no caducaba nunca.
4. **La key de arranque (`*`, 24 h) se imprime en la salida estándar** y valía desde cualquier sitio, así que
   bastaba con que acabara en un log.

No había keys emitidas en producción (nada publicado; el laboratorio no existe), así que el cambio no afecta
a ningún cliente.

## Referencias

- **Stripe**, [API keys: access policies](https://docs.stripe.com/keys#access-policies): restringe cada key a
  direcciones IPv4 o rangos CIDR, bloquea y notifica el resto, y recomienda «configurar access policies en todas
  las keys de live».
- **Stripe**, [Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys): permisos por recurso
  Read/Write/None; GET es lectura, POST y DELETE son escritura; una key por servicio; «Preferred: use restricted
  keys wherever possible».
- **Stripe**, [Best practices](https://docs.stripe.com/keys-best-practices): mínimo privilegio, «a clear policy
  about which team members have permission to create» keys, «rotate secret API keys periodically», auditoría de
  los logs.
- **OWASP**, [API2:2023 Broken Authentication](https://api-security.owasp.org/editions/2023/en/0xa2-broken-authentication):
  «API keys should not be used for user authentication. They should only be used for API clients
  authentication». Zenith lo cumple: los usuarios entran con sesión (engine-auth) y las keys son de servidores.

## Decisión

### 1. Los scopes se aplican (mínimo privilegio)
- **Router:** una ruta `user` solo acepta API keys si declara `scope`. Si no lo declara, las rechaza; el valor por
  defecto es cerrado.
- **CRUD, por operación:**

  | Operación | Scope |
  |---|---|
  | Leer | `data:read` |
  | Crear | `data:create` |
  | Modificar o incrementar | `data:write` |
  | Borrar | `data:delete` |
  | Clase `_User` | `users:read` / `users:write` |

  `/batch` comprueba cada suboperación, porque pasa por las mismas funciones.
- **OpenAPI:** documenta el scope en la `security` de cada operación.

### 2. Política de acceso por IP (`allowedIps`), como Stripe
- **Cualquier key puede llevarla:** una lista de direcciones IPv4/IPv6 o rangos CIDR, de 100 entradas como
  máximo. Las IPv4 vistas por un socket de doble pila (`::ffff:a.b.c.d`) cuentan como IPv4.
- **Fuera de la lista,** la key se rechaza con 401 y el intento queda en la auditoría
  (`key.rejected`, `reason: ip_not_allowed`, con la IP).
- **La IP es la del socket.** `X-Forwarded-For` solo se usa si el socket es un proxy declarado en
  `trustedProxies`, así que un cliente no puede elegirla.
- **La política se comprueba al final:** un secreto incorrecto se informa como tal, sin revelar que existe una
  política.

### 3. Las keys sin restricciones (scope `*`) se tratan como la master key
Zenith va más lejos que Stripe, que recomienda la política pero no la exige. Aquí una key `*` equivale a la
master key, que ya está limitada a localhost, así que exigirle la política es lo coherente:
- **Solo puede ser `sk_`.** Una `pk_` o una `rk_` nunca tienen acceso total.
- **`allowedIps` es obligatoria** y no puede abrirlo todo (`0.0.0.0/0` y `::/0` se rechazan).
- **Caduca en 90 días como máximo** (`UNRESTRICTED_MAX_LIFETIME_DAYS`). Para renovarla se rota.
- **Una key `*` guardada sin lista** (datos anteriores) se rechaza con `policy_missing`: falla en cerrado.

### 4. Solo la master key gestiona keys
`/zen/api-keys` (listar, crear, revocar y rotar) rechaza cualquier API key con 403, incluida una `*`. Quién
puede crear keys queda así limitado a quien tiene la master key en el servidor (desde localhost), y una key
robada no puede crear otra ni revivirse.

### 5. Rotar nunca ensancha una key
La key nueva conserva los scopes, la `allowedIps` y la duración de la anterior. La anterior sigue valiendo
durante el periodo de gracia: 24 h por defecto, 30 días como máximo.

### 6. La key de arranque solo vale desde la propia máquina
Se crea únicamente en desarrollo, dura 24 h y lleva `allowedIps: ["127.0.0.1", "::1"]`, igual que la master key.

## Consecuencias

- `zen api-keys create` admite `--allowed-ips "IP o CIDR,…"`. Una key `*` necesita además `--expires` de 90 días
  como máximo, por ejemplo:
  `zen api-keys create --name deploy --scopes "*" --allowed-ips 203.0.113.10 --expires 30d`.
- **Despliegues sin IP fija** (autoescalado, serverless): no pueden usar keys `*`. Deben usar keys con scopes
  concretos, que es lo que recomienda Stripe, o salir por una IP fija (NAT gateway).
- **Detrás de un proxy:** el servidor debe declararlo en `trustedProxies`. Si no, todas las peticiones llegan con
  la IP del proxy y la lista no distingue clientes.
- **Pendiente** (mejoras que Stripe tiene y Zenith no):
  - políticas por ASN, país o tipo de red (Tor, VPN anónimas);
  - aprobación humana de acciones sensibles para keys de agentes;
  - aviso activo, más allá del log de auditoría, cuando se bloquea un intento.

## Pruebas

- **`tests/unit/api-keys-policy.test.ts`:** CIDR IPv4 e IPv6, IPv4 mapeada, reglas de las keys `*`, verificación,
  `policy_missing` y rotación.
- **`tests/integration/api-keys-http.test.ts`:** por HTTP sobre MongoDB, las altas `*` rechazadas, el uso fuera de
  la lista, la gestión prohibida a las keys y la rotación que conserva la política.
- **`tests/integration/api-key-scopes.test.ts`:** los scopes del CRUD y del batch.
- **Pruebas de mutación:** quitar la comprobación de IP, la restricción de gestión solo con master key o la de
  scopes del CRUD hace fallar las pruebas.
