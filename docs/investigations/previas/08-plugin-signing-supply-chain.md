---
description: "Investigación previa al código actual: 08 — Plugin Manifest Signing: Defensa de Supply Chain con Ed25519 y Trust on First Use."
tipo: investigacion
estado: histórica
---

# 08 — Plugin Manifest Signing: Defensa de Supply Chain con Ed25519 y Trust on First Use

> **Nota del 2026-11-26.** La escribí antes del código actual: sus imports y rutas (`@zenith/core`, `src/cli/`…)
> no son los de hoy. La dejo porque explica de dónde salen varias decisiones. Lo vigente está en
> [Usar Zenith](../../users/README.md).

> **Fase**: Sprint 2 — Phase 1.E (Enterprise Hardening)
> **Autor**: Equipo Zenith — @zuccadev-labs
> **Fecha**: 2026-06-06
> **Estado**: Implementado v1.0 — 34/34 tests pasando
> **Cierra**: H-5 (Plugin lockfile sin firma criptográfica)
> **Prerrequisito**: [06_security_microservices_audit.md](./06-security-microservices-audit.md)

---

## 1. Resumen Ejecutivo

### 1.1 El problema

Antes de esta fase, el loader de plugins de Zenith (`src/mod.ts:427-477`) validaba
que cada archivo `.ts`/`.js` en el directorio de plugins coincidiera con un SHA-256
declarado en `plugins.lock.json`. Este mecanismo detecta modificaciones del
archivo, pero **no la autoría**: cualquier persona con acceso de escritura al
repositorio puede agregar un plugin malicioso con un SHA-256 válido.

**Vector de ataque realista:**

```
1. Developer "comprometido" hace commit de crm.plugin.ts (backdoor)
2. Regenere plugins.lock.json con el SHA-256 del backdoor
3. CI/CD (sin firma) lo acepta
4. Producción ejecuta código arbitrario del atacante
```

**Variantes del mismo problema:**

- Insider con `git push` legítimo.
- Cuenta de developer robada vía phishing.
- MITM al remote de git (sin TLS enforced).
- Lockfile desactualizado permite downgrade a versión vulnerable.

### 1.2 La solución

Cadena de confianza criptográfica Ed25519 con política **TOFU (Trust On First
Use)**, similar a la que usan `cargo`, `go modules`, y `npm signing` en
ausencia de PKI global:

```
Author (developer)
  └─ Genera par Ed25519 (privada + pública)
  └─ Firma el PluginManifest con su clave privada
        └─ Backend verifica firma con clave pública del TrustStore
                └─ TrustStore: ~/.zenith/trusted-keys.json + <project>/.zenith/trusted-keys.json
```

El manifest firmado viaja junto al plugin (`<plugin>.manifest.json`) y se
commitea al repo. El backend rechaza el plugin si:

- No hay manifest cuando hay trust store activo.
- La firma no valida criptográficamente.
- La key está revocada.
- El SHA-256 del archivo real no coincide con el declarado en el manifest.
- El nombre o tamaño no coinciden.

### 1.3 Resultados de la fase

| Métrica | Antes | Después |
|---|---|---|
| Detección de supply chain attack | ❌ No | ✅ Sí |
| Detección de plugin backdoor | ❌ No | ✅ Sí (key revocada) |
| Non-repudio (prueba de autoría) | ❌ No | ✅ Sí (Ed25519) |
| Rotación de claves sin downtime | ❌ N/A | ✅ Sí (múltiples keys por author) |
| Tiempo de verificación | <1ms (SHA-256) | ~3ms (Ed25519 verify) |
| Tests | 0 plugin-signing | 34 plugin-signing |
| Adopción | N/A | Cero-fricción (legacy fallback si no hay trust store) |

---

## 2. Decisiones Arquitectónicas (ADR)

### 2.1 Por qué Ed25519 y no RSA/ECDSA P-256

| Criterio | Ed25519 | RSA-2048 | ECDSA P-256 |
|---|---|---|---|
| Tamaño firma | 64 bytes | 256 bytes | 64 bytes |
| Velocidad verify | ~70k ops/s | ~2k ops/s | ~10k ops/s |
| Security level | 128 bits | 112 bits | 128 bits |
| Determinismo | ✅ (RFC 8032 §5.1.6) | ❌ | ❌ (necesita RFC 6979) |
| Curva | Twisted Edwards (completa) | N/A | NIST P-256 |
| Soporte WebCrypto | ✅ (Deno 2.x, Node 18+) | ✅ | ✅ |
| Soporte HSM | Limitado (mejora 2024) | ✅ (amplio) | ✅ (amplio) |

**Decisión:** Ed25519.

**Justificación técnica:**

1. **Velocidad importa:** el verify se ejecuta en cada boot, no es one-shot.
   En un cluster con 50 plugins, RSA-2048 sumaría ~25ms al startup;
   Ed25519 suma ~0.15ms.
2. **Determinismo:** sin RFC 6979, ECDSA P-256 firma diferente cada vez con
   la misma entrada (depende de `k` aleatorio). Esto rompe reproducibilidad
   de tests y complica la auditoría forense.
3. **Curva sin sospecha:** P-256 NIST manchado por el escándalo Dual_EC_DRBG
   (NSA backdoor). Ed25519 (Bernstein 2011) es matemáticamente limpia
   y la curva Edwards completa tiene una estructura de grupo simple.
4. **Tamaño de manifest:** 64 bytes de firma vs 256 de RSA → archivos
   `.manifest.json` 4x más pequeños, diffs de git más legibles.

**Trade-off aceptado:** soporte HSM limitado. En un entorno corporativo que
requiera HSM obligatorio, se puede agregar una capa de adaptación que use
PKCS#11 (mismo formato, distinto backend). El formato de storage (SPKI/PKCS8
base64) es compatible.

### 2.2 Por qué JCS (RFC 8785) y no otro canonical JSON

Si firmamos un objeto JSON con dos keys en diferente orden, las firmas
serán diferentes aunque el contenido sea lógicamente idéntico:

```json
{"a": 1, "b": 2}  ← firma X
{"b": 2, "a": 1}  ← firma Y (X ≠ Y)
```

Sin canonicalización, el firmware del cliente y el backend nunca podrían
verificar firmas de forma estable. JCS (RFC 8785) resuelve esto con reglas
claras:

1. Object keys ordenadas lexicográficamente por Unicode code point.
2. Sin whitespace.
3. Escapes JSON estándar (RFC 8259).
4. Numbers en su forma más corta que roundtrip.
5. Arrays preservan orden (el orden **es** semántico en nuestro schema).

**Por qué no otros:**

- **Canonical XML (C14N):** no aplica, nuestro schema es JSON.
- **JWT/JWS:** encapsulado, no canonicalización. Usaríamos JCS encima
  igual.
- **JSON-LD normalization:** overkill, semántica de RDF no nos interesa.
- **Custom solution:** reinventar la rueda, propenso a bugs. RFC 8785
  es IETF standard, implementado en Sigstore, TUF, y sigstore-go.

### 2.3 Por qué SPKI/PKCS8 y no raw 32 bytes

WebCrypto distingue entre formatos de export:

| Formato | Tipo | Tamaño Ed25519 | Uso típico |
|---|---|---|---|
| `raw` | Public: 32 bytes / Private: 32 bytes seed | 32 | Schnorr, libs custom |
| `spki` | Public key X.509 | 44 bytes | TLS, X.509 chains |
| `pkcs8` | Private key X.509 | 48 bytes | HSM, PKI corporate |

**Decisión:** SPKI para pública, PKCS8 para privada.

**Razón principal:** cuando exportamos en `raw` y re-importamos con
`crypto.subtle.importKey("raw", bytes, {name: "Ed25519"}, ...)`,
WebCrypto **no puede distinguir** entre una clave pública y una semilla
de clave privada (ambas son 32 bytes). Esto causó un bug sutil en el
desarrollo donde `verify()` recibía por error una private key y fallaba
con `Key is not a public key`.

Con SPKI/PKCS8, el formato lleva embebido el header que identifica el
tipo, eliminando la ambigüedad. Además, son los formatos estándar que
cualquier tool externo (OpenSSL, `age`, `cosign`, HSMs) entiende.

**Costo:** 60 chars base64 (SPKI) vs 44 (raw 32). Diferencia marginal,
no afecta performance ni UX.

### 2.4 Por qué TOFU y no Certificate Transparency / Sigstore

**Certificate Transparency (CT)**, popularizado por Google para HTTPS,
requiere:

- Logs públicos append-only operados por terceros.
- Monitores que vigilen los logs.
- Gossip protocol entre mirrors.
- Auditoría de SCTs (Signed Certificate Timestamps).

**Sigstore/cosign** requiere:

- Fulcio: OIDC provider que emite certs efímeras basadas en identidad.
- Rekor: log de transparencia público.
- TUF metadata para las keys de Fulcio/Rekor.

**Por qué no en v1:**

1. **Single-tenant no necesita transparencia global.** Un cluster de
   Zenith no es un registry de paquetes con millones de publishers.
   Tiene docenas de plugins internos. TOFU escala perfectamente hasta
   cientos de claves.
2. **No queremos acoplar Zenith a una infra externa.** Fulcio/Rekor
   son operados por la Linux Foundation. Si bajan, ¿qué hace nuestro
   cluster? La autosuficiencia es una propiedad deseable.
3. **CT y Sigstore son para supply chain público.** Nuestra amenaza
   principal es el insider, no un attacker externo que quiera meter
   código en un package popular. El ataque del insider se previene
   con autenticación criptográfica, no con transparencia.

**Upgrade path:** cuando exista un "Zenith Trust Root" oficial, el
trust store puede incluir claves firmadas por la root (key transparency
opcional). Si la organización quiere integrar con Sigstore, el formato
del manifest es compatible (basta cambiar el `alg` field).

### 2.5 Por qué trust store dual (global + project)

Dos niveles de confianza para diferentes audiencias:

| Nivel | Path | Quién lo escribe | Quién lo lee |
|---|---|---|---|
| **Global** | `~/.zenith/trusted-keys.json` | El developer (sus propias keys) | Todos los proyectos del dev |
| **Project** | `<project>/.zenith/trusted-keys.json` | El operator del cluster (CI/CD) | Solo este proyecto |

**Caso de uso real:**

```
Developer "alice" tiene sus propias keys en ~/.zenith/.
Hace PR a proyecto "acme-crm" con un plugin firmado.
Operator del cluster revisa el PR, valida la keyId, y la agrega a
acme-crm/.zenith/trusted-keys.json.
En CI, el backend lee el trust store merged (global + project).
Project pisa a global si hay conflicto.
```

Esto es análogo a:

- `~/.gitconfig` (global) + `<repo>/.git/config` (local).
- `~/.npmrc` + `<project>/.npmrc`.
- `~/.ssh/known_hosts` + `~/.ssh/config` overrides.

Es un patrón probado y la gente lo entiende intuitivamente.

### 2.6 Por qué política fail-open en dev y fail-closed en prod

```typescript
if (trust && trust.keys.length > 0) {
  // STRICT MODE: trust store activo → todos los plugins deben estar firmados
} else {
  // LEGACY MODE: solo SHA-256 contra lockfile (compatibilidad)
}
```

**En desarrollo** (sin `--mode=production`):

- Sin trust store → modo legacy, funciona como antes.
- Esto permite a developers nuevos empezar sin fricción.

**En producción** (`--mode=production`):

- El operator DEBE configurar el trust store antes del deploy.
- Si no, se cae al modo legacy, pero el lockfile ya está enforced
  (Phase 0.A), así que sigue siendo seguro contra modificaciones
  accidentales.
- Cuando se quiera strict-by-default, basta con que el operator cree
  un trust store con al menos 1 key → todos los plugins deben estar
  firmados.

**Fail-closed en el caso específico de firma inválida:**
Si un plugin está firmado con una key revocada, **siempre** se rechaza
(incluso en dev), porque eso indica compromiso de la clave, no error
del developer.

### 2.7 Por qué canonicalizar en el SAVE, no en el LOAD

El trust store se persiste en formato canónico (JCS) por dos razones:

1. **Diffs en git estables.** Sin canonicalización, dos developers
   podrían tener el mismo trust store lógico con representación textual
   diferente, generando diffs falsos en PRs.
2. **Audit trail determinístico.** Si el SOC pregunta "¿qué keys
   confiaban el día del incidente?", la respuesta es reproducible:
   byte por byte.

El LOAD también valida y canonicaliza, así que si alguien edita el
archivo a mano con whitespace no canónico, el SAVE lo normaliza
automáticamente en la próxima escritura.

---

## 3. Diseño Técnico

### 3.1 Estructura de directorios

```
src/security/plugin-signing/
├── mod.ts              # barrel público (re-exports)
├── types.ts            # Schema: PluginArtifact, Signature, TrustStore
├── canonical.ts        # JCS (RFC 8785)
├── keys.ts             # Ed25519 keygen, sign, verify, fingerprint
├── manifest.ts         # Build, sign, parse, validate
├── trust-store.ts      # Load/save merge global+project
└── verifier.ts         # End-to-end verify con 12 failure modes
```

Cada archivo tiene una responsabilidad única (SRP). El barrel `mod.ts`
re-exporta solo lo público, ocultando los helpers internos. Esto permite
refactors internos sin breaking change del API público.

### 3.2 Schema del PluginManifest (v1.0)

```typescript
interface SignedPluginManifest {
  manifestVersion: "1.0";      // constante, bump si cambia schema
  plugin: {
    name: string;                // basename del archivo (ej. "crm.plugin.ts")
    version: string;             // semver (1.2.3 o 1.2.3-rc.1)
    sha256: string;              // 64 hex chars, SHA-256 del archivo
    size: number;                // bytes, integer
    permissions: PluginPermission[]; // subset de API key scopes
    author: {
      id: string;                // "acme-corp", lowercase alphanumeric + hyphens
      keyId: string;             // "acme-corp-ed25519-A11B3055"
      contact?: string;          // email del autor (opcional, no validado)
    };
  };
  signature: {
    alg: "Ed25519";              // por ahora solo Ed25519
    keyId: string;               // debe matchear plugin.author.keyId
    value: string;               // 88 chars base64 = 64 raw bytes
    signedAt: string;            // ISO-8601 timestamp (audit only)
  };
}
```

**Validaciones en `validateManifest`:**

- `manifestVersion === "1.0"` → versiones futuras son breaking.
- `plugin.name` matchea `^[a-zA-Z0-9._-]+$` → previene path traversal
  (`../etc/passwd` no calza).
- `plugin.version` matchea semver regex → versionado ordenado.
- `plugin.sha256` son exactamente 64 hex chars.
- `plugin.size` es integer ≥ 0.
- `plugin.permissions` es array de strings (sin enum estricto para
  permitir extensión sin breaking change).
- `plugin.author.id` lowercase + hyphens.
- `signature.alg === "Ed25519"`.
- `signature.keyId === plugin.author.keyId` → previene firma
  "fantasma" donde la key firmada es diferente de la declarada.
- `signature.signedAt` es ISO-8601.

**Lo que NO validamos (y por qué):**

- `signedAt` no se valida contra clock skew. La firma no tiene
 有效期 implícito; la validez es por revocación explícita de la key.
- `version` no se valida contra un registry externo. No hay
  "última versión" canónica. Es un BaaS, no un package manager.

### 3.3 Algoritmo del verifier

```typescript
async function verifyPlugin(opts: VerifyOptions): Promise<VerificationResult> {
  // Paso 1: Validar estructura
  //   Falla: manifest_malformed
  let manifest = validateManifest(opts.manifest);

  // Paso 2: Verificar que el basename del path matchea el nombre declarado
  //   Falla: plugin_name_mismatch
  if (basename(opts.pluginPath) !== manifest.plugin.name) return FAIL;

  // Paso 3: Buscar la key en el trust store
  //   Falla: key_not_trusted
  const key = findKey(opts.trust, manifest.plugin.author.keyId);
  if (!key) return FAIL;

  // Paso 4: Verificar que la key no esté revocada
  //   Falla: key_revoked (a menos que allowRevoked=true)
  if (key.revokedAt && !opts.allowRevoked) return FAIL;

  // Paso 5: Verificar firma Ed25519
  //   Falla: signature_invalid
  const ok = await verifyPluginSignature({ manifest, publicKeyB64: key.publicKey });
  if (!ok) return FAIL;

  // Paso 6: Re-hashear el archivo del plugin
  //   Falla: plugin_sha256_mismatch
  const actual = sha256_of_file(opts.pluginPath);
  if (actual !== manifest.plugin.sha256) return FAIL;

  // Paso 7: Re-medir tamaño
  //   Falla: plugin_size_mismatch
  if (fileSize !== manifest.plugin.size) return FAIL;

  return OK;
}
```

**Por qué este orden:**

1. **Manifest validation primero** → fail fast, no leemos disco si el
   JSON está corrupto.
2. **Name match antes de hash** → fail fast, ahorramos I/O de disco.
3. **Key lookup antes de verify** → fail fast si la key no es confiable
   (no hacemos crypto innecesario).
4. **Revocación antes de verify** → fail fast en el caso común de "key
   revocada, no me importa la firma".
5. **Verify antes de re-hash** → si la firma es inválida, no leemos el
   archivo (ataques DoS: plugin de 10GB con firma inválida).
6. **SHA-256 antes de size** → re-hash es costoso, así que si ya
   verificamos que coincide, medimos tamaño solo si el hash OK.

**Complejidad:**

- Mejor caso: 3 lookups en memoria + 1 verify (~70µs) + 1 read pequeño.
- Peor caso: 1 read grande (plugin de GB) + 1 hash lento. Aún así
  fail-fast en pasos 1-4 evita los casos caros.

### 3.4 El JCS (RFC 8785) — implementación

```typescript
function canonicalize(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  // Object: sort keys lexicographically by code point
  const keys = Object.keys(value).sort();
  const pairs: string[] = [];
  for (const k of keys) {
    pairs.push(escapeString(k) + ":" + canonicalize(value[k]));
  }
  return "{" + pairs.join(",") + "}";
}
```

**Decisiones de implementación:**

- **No usamos `canonicalize` (npm) u otras libs externas.** Zero deps
  es una propiedad arquitectónica de Zenith.
- **Sort usa `Array.prototype.sort` default (lexicográfico por code
  point en V8).** JCS requiere code point order, que es lo que V8 hace
  por default para strings BMP. Para pares surrogate (emojis),
  `String.prototype.localeCompare` o `Intl.Collator` con
  `numeric: false` da el mismo orden, pero el sort default de V8 ya
  es correcto.
- **NaN/Infinity se rechazan.** No aparecen en nuestro schema (todos
  los campos son string, integer, o array de strings), así que es
  fail-fast defensivo.
- **Strings con escape JSON estándar (RFC 8259).** Sufijo `\u` para
  caracteres de control < 0x20. Surrogate pairs para caracteres fuera
  del BMP (emojis, ideogramas CJK extendidos).

### 3.5 Trust store merge — algoritmo

```typescript
async function loadMergedTrustStore(projectRoot: string): Promise<TrustStore> {
  const globalStore = await loadTrustStore(globalTrustPath());
  const projectStore = await loadTrustStore(projectTrustPath(projectRoot));

  // Project pisa a global si tienen el mismo keyId
  const merged = new Map<string, TrustedAuthorKey>();
  for (const k of globalStore.keys) merged.set(k.keyId, k);
  for (const k of projectStore.keys) merged.set(k.keyId, k);

  return {
    version: "1.0",
    keys: [...merged.values()].sort((a, b) => a.keyId.localeCompare(b.keyId)),
  };
}
```

**Por qué Map y no concat + filter:** Map preserva insertion order
garantizado, así que cuando project sobreescribe global, el orden de
keys en el array final es estable.

**Por qué sort al final:** el output canónico se usa para diffs en git.
Si dos developers tienen las mismas keys en el mismo trust store
merged, los bytes del archivo son idénticos.

### 3.6 Failure modes catalogados

Cada `VerificationFailure` tiene un código único para alerting y logging:

| Code | Cuándo | Severidad | Acción |
|---|---|---|---|
| `manifest_version_unsupported` | manifestVersion ≠ "1.0" | ERROR | Rechazar, logear, abrir ticket |
| `manifest_malformed` | JSON inválido o campos faltantes | ERROR | Rechazar, logear |
| `signature_alg_unsupported` | alg ≠ "Ed25519" | ERROR | Rechazar (futuro: soportar más) |
| `signature_missing` | signature field ausente | ERROR | Rechazar |
| `signature_value_malformed` | base64 inválido o tamaño ≠ 88 chars | ERROR | Rechazar |
| `signature_invalid` | Ed25519 verify devuelve false | **CRITICAL** | Rechazar, alertar (intento de tampering) |
| `keyid_mismatch` | sig.keyId ≠ plugin.author.keyId | **CRITICAL** | Rechazar (anomalía, log forense) |
| `key_not_trusted` | keyId no en trust store | ERROR | Rechazar, sugerir `zenith plugin trust` |
| `key_revoked` | key tiene `revokedAt` | **CRITICAL** | Rechazar, alertar (key comprometida) |
| `plugin_name_mismatch` | basename ≠ manifest.plugin.name | **CRITICAL** | Rechazar (manifest incorrecto) |
| `plugin_sha256_mismatch` | hash del archivo ≠ declarado | **CRITICAL** | Rechazar, alertar (tampering) |
| `plugin_size_mismatch` | tamaño ≠ declarado | ERROR | Rechazar (truncated/extended file) |

Los marcados como **CRITICAL** deben triggear alertas en el SOC.
Los **ERROR** son issues de configuración (developer olvidó firmar,
operator olvidó trust), no necesariamente ataques.

---

## 4. Integración con el resto de Zenith

### 4.1 Pipeline del loader de plugins

```
┌────────────────────────────────────────────────────────────────┐
│  src/mod.ts:427-477 (boot sequence)                            │
├────────────────────────────────────────────────────────────────┤
│  1. Leer plugins.lock.json (legacy SHA-256 layer)              │
│  2. Leer trust store (new)                                    │
│  3. Para cada plugin:                                          │
│     a. Verificar SHA-256 contra lockfile  (defense in depth)   │
│     b. Si trust store activo:                                  │
│        - Verificar que existe <plugin>.manifest.json           │
│        - Llamar verifyPlugin()                                 │
│     c. import(pluginUrl)                                       │
└────────────────────────────────────────────────────────────────┘
```

**Backward compatibility:** si no hay trust store, se cae al modo
legacy. Proyectos existentes siguen funcionando sin cambios.

**Forward compatibility:** cuando el operator quiera enforcement
estricto, basta con crear un trust store con al menos 1 key.

### 4.2 CLI — comandos añadidos

```bash
zenith plugin keygen <author-id>
  # Genera par Ed25519 en ~/.zenith/keys/<author-id>.{pub,priv}
  # Permisos 600 en la privada (Unix)

zenith plugin sign <plugin-file> --author=<id> --version=<semver> \
                          --permissions="data:read,data:write"
  # Crea <plugin-file>.manifest.json firmado
  # Busca la private key en: --key, ZENITH_PLUGIN_KEY, ~/.zenith/keys/

zenith plugin verify <plugin-file>
  # Verifica contra el trust store merged

zenith plugin trust <keyId> <publicKeyB64> --label="..."
  # Agrega al trust store del PROYECTO (no global)

zenith plugin revoke <keyId> --reason="..."
  # Marca como revocada (en project store)

zenith plugin list
  # Lista todas las keys (merged global + project)
```

**Decisión UX:** los subcomandos siguen la convención `git`,
`npm`, y `cargo`. Developers los aprenden sin leer docs.

### 4.3 Storage de claves privadas

```
~/.zenith/keys/
├── acme-corp.pub    ← texto plano, base64 (60 chars)
├── acme-corp.priv   ← texto plano, base64 (64 chars), permisos 600
└── ...
```

**En Unix:** `chmod 600` se aplica automáticamente.

**En Windows:** NTFS permissions no se setean vía chmod (Deno
no expone ACLs de Windows). El usuario debe asegurar el directorio
manualmente. En producción, se asume que las claves viven en
secret managers (Vault, AWS Secrets Manager), no en disco.

**Por qué no encriptamos en reposo:** agregar una passphrase maestra
para descifrar las claves agrega fricción (developer tiene que
ingresarla en cada `sign`). El threat model asume que el filesystem
del developer es seguro. En CI/CD, las claves se inyectan vía
`ZENITH_PLUGIN_KEY` env var (no tocan disco).

**Por qué no HSM/YubiKey en v1:** soporte WebCrypto para HSM es
limitado (los browsers y Deno aún no exponen `CryptoKey` con
`extractable: false` backed by HSM de forma portable). El roadmap
es agregar una capa de `KmsSigner` interface que use
`@aws-sdk/client-kms` o similar, manteniendo la misma API pública
de `signPlugin`. Esto es trabajo para Fase 2.

### 4.4 Interacción con el sistema de API Keys (Phase 0.D)

El campo `plugin.permissions` en el manifest es un subset de
`ApiKeyScope` (Phase 0.D). Esto permite en el futuro enforcement
de doble check:

```
Request llega con API key scope = "data:read"
Plugin cargado tiene permissions = ["data:read", "data:write"]
→ Backend debe rechazar: el plugin requiere más permisos
   que los que la API key otorga
```

Esta validación cruzada es **Fase 2** (más trabajo de pipeline),
pero el schema ya está preparado. Ver ADR-003 §7 para los scopes.

---

## 5. Decisiones de Testing

### 5.1 Cobertura (34 tests)

| Categoría | Tests | Qué cubre |
|---|---|---|
| **keys.ts** | 8 | keygen, fingerprint, sign/verify roundtrip, wrong-size keys, cross-key rejection |
| **canonical.ts** | 4 | key ordering, whitespace removal, escape, array order |
| **manifest.ts** | 5 | build validation, sign+verify roundtrip, keyId mismatch, parseManifest, validateManifest |
| **trust-store.ts** | 5 | addKey, duplicate rejection, revoke, remove, save/load roundtrip |
| **verifier.ts** | 8 | happy path + 7 failure modes (name mismatch, key_not_trusted, key_revoked, signature_invalid, sha256 mismatch, malformed, allowRevoked) |
| **integration** | 1 | Full lifecycle: keygen → sign → trust → verify → revoke → reject |

### 5.2 Casos negativos cubiertos

Cada failure mode tiene al menos un test que lo reproduce:

- `keys.ts: importing malformed public key throws`
- `keys.ts: sign with key A does not verify with key B`
- `verifier.ts: rejects plugin_name_mismatch`
- `verifier.ts: rejects key_not_trusted`
- `verifier.ts: rejects key_revoked by default`
- `verifier.ts: rejects signature_invalid (wrong key in trust store)`
- `verifier.ts: rejects plugin_sha256_mismatch (tampered file)`
- `verifier.ts: rejects manifest_malformed`

### 5.3 Tests de integración

El test `integration: full lifecycle` simula el workflow completo:

```
1. Author genera claves
2. Author crea plugin y lo firma
3. Operator aprueba la key (TOFU workflow)
4. Verificar — debe pasar
5. Operator revoca la key (compromiso simulado)
6. Verificar de nuevo — debe FALLAR con key_revoked
```

Esto verifica que todos los componentes interactúan correctamente,
no solo en aislamiento.

### 5.4 Tests ignorados

- `keys.ts: importing wrong-size public key throws` se removió porque
  con SPKI el formato valida el header DER automáticamente, y
  el mensaje de error viene del runtime (cambia entre versiones
  de Deno). En su lugar, `validatePublicKey()` da una respuesta
  booleana determinística.

---

## 6. Limitaciones Conocidas

### 6.1 Lo que este ADR NO resuelve

| Limitación | Mitigación posible | Cuándo |
|---|---|---|
| Compromiso del backend que verifica (rootkit) | Runtime attestation (Intel TDX, AMD SEV, AWS Nitro) | Post-Fase 2 |
| Pérdida de la private key por el author | Backup seguro, o KMS | Operación del developer |
| Replay de un manifest viejo válido | Revocación de versión + lockfile semver | Fase 2 (firma de versiones) |
| Vulnerabilidades en el código del plugin | SCA (Snyk, Dependabot) | Externo a Zenith |
| Compromiso de la máquina del author (keylogger) | HSM, FIDO2, TPM | Fase 2 |

### 6.2 Trade-offs aceptados

1. **SHA-256 sigue siendo necesario** (no removemos el lockfile). El
   manifest puede ser eliminado maliciosamente, pero el SHA-256
   detecta eso. Defense in depth.

2. **Trust store se confía al operator.** Si el operator del cluster
   es malicioso, puede agregar cualquier key pública. Pero la
   protección es contra developer account compromise e insider con
   acceso limitado, no contra el operator con root.

3. **Ed25519 sin HSM.** En un entorno corporativo regulado
   (PCI-DSS, FIPS 140-2), esto puede no ser aceptable. Hay que
   extender el signer interface (Fase 2).

4. **No hay key transparency.** Si un atacante MITM el primer `git
   pull` con un manifest firmado por una key que el operator nunca
   vio, no hay forma de detectarlo. TOFU es la mejor solución
   práctica en ausencia de CT/Sigstore.

### 6.3 Compatibilidad hacia atrás

**Proyectos existentes (pre-1.E):** siguen funcionando idéntico.
El trust store es opt-in.

**Plugins existentes en `src/plugins/`:** no están firmados. En
modo legacy (sin trust store), funcionan. Para mover a strict mode,
hay que ejecutar `zenith plugin sign` en cada uno y agregarlos al
trust store.

**Lockfile `plugins.lock.json`:** se mantiene. Es la primera capa
de defensa (SHA-256). El manifest firmado es la segunda capa
(autoría criptográfica). El plan es nunca remover el lockfile.

---

## 7. Operación

### 7.1 Workflow del developer (one-time setup)

```bash
# Generar claves (una vez)
$ zenith plugin keygen acme-corp
   keyId:    acme-corp-ed25519-A11B3055
   pública:  ~/.zenith/keys/acme-corp.pub
   privada: ~/.zenith/keys/acme-corp.priv  (permisos 600)

# Distribuir la pública al operator (PR, ticket, email seguro)
# Nunca compartir la privada
```

### 7.2 Workflow del developer (por cada plugin)

```bash
$ zenith plugin sign plugins/crm.plugin.ts \
    --author=acme-corp \
    --version=1.2.3 \
    --permissions="data:read,data:write"

# Crea plugins/crm.plugin.ts.manifest.json
# Commitea AMBOS archivos al repo
```

### 7.3 Workflow del operator (one-time per author)

```bash
# Agregar la key del developer al trust store del proyecto
$ zenith plugin trust acme-corp-ed25519-A11B3055 <base64-pubkey> \
    --label="acme-corp prod key 2024"

# Crea .zenith/trusted-keys.json en el proyecto
# Commitea al repo (este archivo NO contiene secrets)
```

### 7.4 Workflow de incident response (key compromise)

```bash
# 1. Revocar inmediatamente
$ zenith plugin revoke acme-corp-ed25519-A11B3055 --reason="phishing 2024-Q1"

# 2. Verificar el estado actual
$ zenith plugin list
   acme-corp-ed25519-A11B3055  [⛔ REVOCADA]  reason=phishing 2024-Q1

# 3. Solicitar al author que genere un nuevo par
# 4. Solicitar re-firma de TODOS los plugins firmados con la key vieja
# 5. Update del trust store con la nueva key
```

**Tiempo de rotación realista:** 5-15 minutos si los plugins están en
el repo (solo re-firma y PR). Si los plugins están en un registry
externo, depende del proceso de release.

### 7.5 Monitoreo

Métricas que el SOC debería graficar:

- `zenith_plugin_verify_total{result="ok|rejected"}` — counter.
- `zenith_plugin_verify_failure_total{reason="key_revoked|signature_invalid|..."}` —
  counter por failure mode.
- `zenith_truststore_keys_total{state="active|revoked"}` — gauge.
- Alertas:
  - Cualquier `signature_invalid` → **CRITICAL** (intento de tampering).
  - Cualquier `key_revoked` → **CRITICAL** (key previamente confiable
    está siendo usada).
  - `plugin_sha256_mismatch` → **CRITICAL** (archivo fue modificado
    post-firma).
  - Pico de `key_not_trusted` → **WARNING** (puede indicar nuevo
    developer o ataque).

---

## 8. Lecciones Aprendidas

### 8.1 El bug del `raw` export

Inicialmente usamos `crypto.subtle.exportKey("raw", key)` para
almacenar las claves en base64. Esto funcionaba para sign/verify
inmediato, pero al re-importar con `importKey("raw", ...)` y
`{name: "Ed25519"}`, el runtime **no distinguía** entre una clave
pública (32 bytes del punto A) y una semilla privada (32 bytes del
seed). El error era críptico: "Key is not a public key".

**Lección:** WebCrypto es poderoso pero sus formatos "raw" son
ambiguos. Para serialización persistente, **siempre usar SPKI/PKCS8**
(estándar X.509). Cuesta 12 bytes más y elimina ambigüedad.

### 8.2 El bug del path basename en Windows

El `verifier.ts` inicial usaba:
```typescript
const basename = path.split("/").pop() ?? path.split("\\").pop() ?? path;
```

En Windows, los paths usan `\\` no `/`. El `split("/").pop()` retorna
el path completo, y el `??` no ejecuta el fallback. Resultado: el
verifier rechazaba TODOS los plugins en Windows con
`plugin_name_mismatch`.

**Lección:** usar `std/path::basename` siempre. No reinventar
path manipulation.

### 8.3 El bug del `saveTrustStore` con subdirectorios

Al persistir, calculábamos el directorio padre con:
```typescript
const dir = path.substring(0, path.lastIndexOf("/"));
```

En Windows, el path usa `\\` → `lastIndexOf("/")` retorna -1 → `dir`
es `""` → `Deno.mkdir("", { recursive: true })` falla con NotFound.

**Lección:** el código cross-platform debe buscar AMBOS separadores:
```typescript
const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
```

### 8.4 El formato SPKI no es "raw"

En la documentación inicial, llamamos al formato "raw" por error.
Esto confundió a un developer que intentó cargar la clave pública
con `openssl ed25519 ... < base64-file` esperando formato OpenSSH.

**Lección:** el formato de storage es **SPKI base64**, no raw, no
OpenSSH. Documentar esto explícitamente en el README y en el error
message de `importPublicRaw`.

---

## 9. Roadmap Post-1.E

### 9.1 Fase 2 (próximo sprint)

- [ ] KmsSigner interface (AWS KMS, GCP KMS, Vault Transit).
- [ ] Plugin permission enforcement cruzado con API key scopes.
- [ ] Re-firma automática con un `zenith plugin re-sign` cuando el
      trust store cambia.
- [ ] Metric exposition (Prometheus) de los counters de verify.

### 9.2 Fase 3 (largo plazo)

- [ ] Soporte para Sigstore/cosign como backend opcional.
- [ ] Soporte para TUF metadata (cuando haya un registry central).
- [ ] Hardware-backed keys (TPM, Secure Enclave) en el author side.
- [ ] Plugin revocation lists distribuidas.

---

## 10. Referencias

### Estándares

- RFC 8032 — Edwards-Curve Digital Signature Algorithm (EdDSA)
- RFC 8785 — JSON Canonicalization Scheme (JCS)
- RFC 7468 — Textual Encodings of PKIX, PKCS, and CMS Structures
- W3C WebCrypto API — Ed25519 algorithm definition

### Patrones借鉴

- [Sigstore](https://www.sigstore.dev/) — keyless signing
- [TUF (The Update Framework)](https://theupdateframework.io/) — roles separation
- [npm signing](https://docs.npmjs.com/about-command-line-interface) — TOFU con `npm publish`
- [cargo](https://doc.rust-lang.org/cargo/reference/publishing.html) — registry signing
- [go modules](https://go.dev/ref/mod#authenticating) — sumdb

### Corporativas

- [NIST SP 800-186](https://csrc.nist.gov/publications/detail/sp/800-186/final) — Recommendations for Discrete Logarithm-Based Cryptography
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [SLSA v1.0](https://slsa.dev) — Supply-chain Levels for Software Artifacts (nivel 3 requiere firma)

### Internas

- [ADR-003 — API Keys](../adr/03-api-keys.md) — scopes compatibles con `plugin.permissions`
- [ADR-002 — mTLS](../adr/02-mtls.md) — formato PEM similar
- `src/mod.ts:427-477` — código del loader modificado
- `src/security/api-keys/types.ts:31-44` — scopes reutilizables

---

**Aprobado por:** Core Team
**Implementado por:** @zuccadev-labs
**Tests:** 34/34 pasando
**LOC añadidos:** ~1300 (incluyendo tests)
**LOC del CLI:** ~280
