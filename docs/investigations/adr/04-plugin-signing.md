# ADR-004: Plugin Manifest Signing con Ed25519

- **Estado:** Accepted
- **Fecha:** 2026-06-06
- **Decisores:** Zenith Core Team
- **Sprint:** Phase 1.E (cierra H-5)

## Contexto

El sistema actual de plugins (`src/mod.ts` boot loader) verifica que
cada plugin coincida con un SHA-256 en `plugins.lock.json`. Este
mecanismo es vulnerable a los siguientes ataques de supply chain:

| # | Amenaza | Impacto |
|---|---------|---------|
| 1 | Insider con write access al repo agrega un plugin backdoor | RCE en el cluster |
| 2 | Cuenta de developer comprometida vía phishing | RCE persistente |
| 3 | MITM al `git push` (sin TLS enforced en el remote) | Inyección silenciosa |
| 4 | Compromiso del registry/CDN donde se distribuyen plugins | RCE masivo |
| 5 | Lockfile desactualizado con hashes viejos de plugins vulnerables | DoS o RCE |

El SHA-256 **detecta modificación del archivo** pero **no la
autoría**. Cualquiera que pueda escribir al lockfile puede "registrar"
un nuevo plugin malicioso con su hash válido.

## Decisión

Implementamos un sistema de **firma criptográfica de manifests con
Ed25519** y una **cadena de confianza tipo TOFU (Trust On First Use)**:

```
Plugin Author
  └─ Genera par Ed25519 (keygen)
  └─ Firma PluginManifest con private key → .manifest.json
       └─> Backend verifica firma con public key del trust store
            └─> Trust store: ~/.zenith/trusted-keys.json (global)
                          + <project>/.zenith/trusted-keys.json (local)
```

### Formato del manifest firmado

```json
{
  "manifestVersion": "1.0",
  "plugin": {
    "name": "crm.plugin.ts",
    "version": "1.2.3",
    "sha256": "abc123...",
    "size": 12345,
    "permissions": ["data:read", "data:write"],
    "author": {
      "id": "acme-corp",
      "keyId": "acme-corp-ed25519-A11B3055",
      "contact": "ops@acme.example"
    }
  },
  "signature": {
    "alg": "Ed25519",
    "keyId": "acme-corp-ed25519-A11B3055",
    "value": "<base64 firma 64 bytes>",
    "signedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### Algoritmos y formatos

- **Firma:** Ed25519 (RFC 8032), 64 bytes raw, base64.
- **Hash de contenido:** SHA-256, hex (sin cambios respecto a Phase 0).
- **Serialización para firma:** JCS (RFC 8785) — JSON canónico con keys
  ordenadas lexicográficamente, sin whitespace, escapes JSON
  estándar. Sin esto, dos manifests lógicamente iguales firmarían
  diferente.
- **Storage de claves:**
  - Pública: SPKI DER (~44 bytes) → base64
  - Privada: PKCS8 DER (~48 bytes) → base64
- **Key ID:** `<author-id>-ed25519-<8hex>` donde los 8 hex son los
  primeros 4 bytes del SHA-256 de la SPKI pública.
- **Fingerprint visual:** `ed25519:AB:CD:EF:GH` (mismo SHA-256, con
  separadores, para display).

### Trust store

- **Global:** `~/.zenith/trusted-keys.json`
- **Project-local:** `<project>/.zenith/trusted-keys.json`
- **Merge:** project-local pisa a global si hay conflicto.
- **Formato:** JSON canónico, ordenado por `keyId`.
- **Permisos:** lectura pública, escritura solo manual via CLI.

### Política de carga (loader en `src/mod.ts`)

```
¿Existe trust store con al menos 1 clave?
├── NO  → modo legacy: solo SHA-256 contra lockfile (compatibilidad)
└── SÍ  → modo strict:
           1. Verificar que <plugin>.manifest.json existe
           2. Validar estructura del manifest
           3. Buscar keyId en trust store
           4. Si revocada → ABORT (a menos que allowRevoked=true)
           5. Verificar firma Ed25519 con public key
           6. Re-hashear archivo del plugin → debe matchear sha256
           7. Re-medir tamaño → debe matchear size
           8. Verificar name del plugin vs basename del archivo
           9. Si todo OK → import
```

### Revocación

- Una key revocada (campo `revokedAt`) **no valida nuevas firmas**.
- Mantiene las firmas previas en la base (auditoría forense).
- Cargar un plugin firmado con key revocada → `key_revoked` failure.
- CLI: `zenith plugin revoke <keyId> --reason="..."`

### Workflow de adoption (zero-friction)

1. **Dev genera su par:** `zenith plugin keygen acme-corp` → guarda
   en `~/.zenith/keys/acme-corp.{pub,priv}` con permisos 600.
2. **Dev firma cada plugin:** `zenith plugin sign crm.plugin.ts
   --author=acme-corp --version=1.2.3 --permissions="data:read,..."`
   → produce `crm.plugin.ts.manifest.json`.
3. **Dev commitea al repo:** `crm.plugin.ts` + `crm.plugin.ts.manifest.json`.
4. **Operator aprueba la key (una sola vez):** `zenith plugin trust
   acme-corp-ed25519-A11B3055 <pubKey>` → guarda en
   `<project>/.zenith/trusted-keys.json`.
5. **Backend en CI:** detecta trust store, verifica firmas, rechaza
   plugins sin firmar o con firmas inválidas.

### Threat model (qué cubre, qué NO cubre)

**Cubre:**
- Insider malicioso que NO tiene la private key del author.
- Cuenta de developer comprometida sin acceso a `~/.zenith/keys/`.
- MITM en git remote (la firma está en el manifest commiteado).
- Compromiso del CDN/registry (la firma no se puede falsificar sin
  la private key).
- Plugin modificado post-firma (SHA-256 en manifest vs archivo real).

**NO cubre (out of scope para este ADR):**
- Compromiso de la máquina del author (keylogger, etc.) → requeriría
  HSM o keys en enclave (Apple Secure Enclave, AWS Nitro).
- Vulnerabilidades en el código del plugin mismo → eso es SCA
  (Software Composition Analysis), no signing.
- Reproducción de un manifest viejo válido para un plugin viejo
  vulnerable → mitigable con revocación de versión + lockfile
  semver.
- Compromiso del backend que verifica (si alguien controla el
  proceso que llama `verifyPlugin`, puede bypasearlo) → out of scope,
  requiere runtime attestation.

### Por qué Ed25519 (no RSA, ECDSA P-256, etc.)

- **Velocidad:** Ed25519 es 10-100x más rápido que RSA-2048 para
  sign/verify. Importante porque la verificación se hace en cada
  boot, no una sola vez.
- **Tamaño:** Firma de 64 bytes vs 256 de RSA-2048 → manifests
  más pequeños.
- **Seguridad:** 128-bit security level (vs 112 de RSA-2048).
  Recomendado por NIST desde 2023.
- **Determinismo:** RFC 8032 Ed25519 es determinista (no como
  ECDSA), lo que permite reproducibilidad de tests.
- **Curva segura:** Ed25519 es una curva Twisted Edwards completa
  (no las "weak" curves de NIST P-256).

### Por qué JCS (RFC 8785) y no otro canonical JSON

- Estándar IETF (RFC oficial).
- No requiere libraries externas (subset de JSON normalizado).
- Soportado por todas las implementaciones modernas de Sigstore /
  TUF / sigstore-go.
- Resistente a malleability (no permite reordenamiento de keys
  sin invalidar la firma).

### Por qué TOFU y no transparencia tipo Certificate Transparency

- CT requiere infraestructura (logs, monitores, gossip) que está
  fuera del scope de un BaaS open-source.
- TOFU es el estándar de facto para code signing en ausencia de
  PKI global (npm signing, cargo, go modules).
- Upgrade path: cuando haya un "Zenith Trust Root" oficial, el
  trust store puede incluir claves firmadas por la root (key
  transparency opcional).

## Alternativas consideradas

### 1. RSA-2048 + PKCS#1 v1.5

- ❌ Más lento (especialmente verify).
- ❌ Firmas 4x más grandes.
- ✅ Compatibilidad legacy con HSMs.
- **Rechazado:** sin ventaja para nuestro caso de uso.

### 2. ECDSA P-256 (secp256r1)

- ✅ Curva NIST, soporte amplio.
- ❌ No determinista (requiere RFC 6979 para reproducibilidad).
- ❌ Históricamente controversial (Dual_EC_DRBG backdoor, aunque
  P-256 no estaba afectada, manchó la reputación).
- **Rechazado:** Ed25519 es superior técnicamente.

### 3. HMAC con shared secret

- ❌ Requiere secreto compartido entre author y operator (no escala).
- ❌ No hay no-repudio.
- **Rechazado:** pierde la propiedad principal de firma digital.

### 4. The Update Framework (TUF)

- ✅ Estándar de la Cloud Native Computing Foundation.
- ✅ Roles separados (root, targets, snapshot, timestamp).
- ❌ Mucha más infraestructura (varios metadata files, repo server).
- ❌ Overkill para plugins single-tenant.
- **Rechazado para v1.** Considerado para v2 si hay un "Zenith
  Plugin Registry" centralizado.

### 5. Sigstore / cosign

- ✅ Estándar moderno, integración con OIDC + Rekor.
- ✅ Transparencia built-in (Rekor log).
- ❌ Dependencia externa (sigstore infrastructure).
- ❌ Keyless signing requiere OIDC provider.
- **Rechazado para v1.** Considerado para v2 si el ecosistema
  Zenith crece y se quiere firma keyless contra un IdP corporativo.

## Consecuencias

### Positivas

- **Detección de supply chain attacks:** cualquier modificación no
  autorizada del plugin o de su registro es detectable.
- **No-repudio:** una firma válida prueba que el plugin fue
  publicado por el autor (su private key, al menos).
- **Rotación de claves sin downtime:** se pueden tener múltiples
  keys activas por author (válidas hasta que se revoquen).
- **Fail-closed en producción:** si el trust store está
  configurado, plugins sin firma rechazados.
- **Adopción gradual:** si no hay trust store configurado, se
  cae al modo legacy (SHA-256 only). Cero fricción para migrar.
- **Compatible con el sistema de permisos:** el manifest declara
  qué permisos necesita el plugin, y el runtime puede hacer
  enforcement adicional (Fase 2).

### Negativas

- **Más fricción para developers:** tienen que firmar cada plugin.
- **Rotación de claves:** si pierden la private key, hay que
  re-firmar todos los plugins. Mitigable con múltiples keys.
- **No recovery sin backup de la private key:** si el author
  pierde `~/.zenith/keys/<author>.priv`, los plugins firmados
  quedan inverificables. Mitigable con KMS/HSM en corporativo.
- **Migración de plugins existentes:** todos los plugins
  actuales en `src/plugins/` no tienen manifest. En strict mode,
  fallarían. Hay que firmarlos todos en una migration window.

### Neutrales

- Se mantiene el lockfile SHA-256 (Phase 0.A) como segunda capa
  de defensa. Defense in depth.
- El sistema no bloquea el desarrollo: en dev sin trust store,
  funciona como antes.

## Plan de migración

1. **Fase 1 (este ADR):** implementar y mergear. **No romper nada**
   en proyectos existentes.
2. **Fase 2 (próximo sprint):** firmar todos los plugins de
   `src/plugins/` (crm, erp, ecommerce). Agregar al trust store
   de la organización.
3. **Fase 3:** mover el sistema a "strict-by-default" en CI. Hacer
   que `zenith dev` falle si hay plugins sin firmar en strict mode.

## Métricas de éxito

- 100% de los plugins oficiales firmados.
- 0 falsos positivos en CI (la verificación tarda <10ms por plugin).
- Tiempo de rotación de clave: < 5 minutos.
- Tests: 34/34 pasando en el nuevo módulo (Phase 1.E).

## Referencias

- RFC 8032: Edwards-Curve Digital Signature Algorithm (EdDSA)
- RFC 8785: JSON Canonicalization Scheme (JCS)
- OWASP Top 10 - A06:2021 Vulnerable and Outdated Components
- SLSA (Supply-chain Levels for Software Artifacts): nivel 3
  requiere firma criptográfica.
- NIST SP 800-186: Recommendations for Discrete Logarithm-Based
  Cryptography (incluye Ed25519).
