# Investigación 11: HashiCorp Vault como gestor de secretos (H-4)

> ℹ️ **Estado: histórico.** Investigación previa al diseño actual; sus imports y rutas (`@zenith/core`, `src/cli/`…) no son los del código. Índice vigente: [docs/index.md](../index.md).

**Autor**: Zenith Core Team
**Fecha**: 2026-06-06
**Status**: Cerrado
**ADR relacionado**: [ADR-008](../architecture-decisions/ADR-008-hashicorp-vault.md)
**Auditoría**: [06_security_microservices_audit.md](../investigations/06_security_microservices_audit.md) → H-4

---

## 1. Contexto y amenaza

Zenith es un BaaS multi-tenant con 7 orígenes de secretos sensibles:

| Categoría | Secretos |
|-----------|----------|
| Identidad | JWT signing keys (RS256/EdDSA), tokens de refresh, session cookies |
| Base de datos | MongoDB connection string, Redis URL, PostgreSQL/Lux-DB |
| Storage | AWS S3 access keys, GCS service account, Postal API token |
| mTLS | CA root, server certs, client certs (k8s) |
| Auth externo | Keycloak/Zitadel client secret, OAuth client_secret |
| Encryption at rest | data encryption keys (DEK) para campos PII |
| Vendor | Stripe, Twilio, SendGrid, Mapbox, etc. |

Históricamente todos estos secretos estaban en variables de entorno o archivos de configuración. Eso tiene tres problemas:

1. **Rotación manual**: cambiar una key requiere redeploy + downtime
2. **Auditoría deficiente**: no se sabe quién leyó qué
3. **Falta de cifrado-at-rest en CI**: secrets en plaintext en GitHub Actions secrets
4. **Sin PKI dinámica**: certificados mTLS con TTL fijo

Vault resuelve los cuatro.

## 2. Por qué Vault

Vault es el estándar de la industria para gestión de secretos (6+ años en producción, CNCF Graduated, usado por Adobe, Capital One, SocGen, BBVA, etc.). Razones técnicas:

- **Audit log append-only** con HMAC chained hashing (cualquier tampering detectable)
- **PKI dinámica** con certificados TTL cortos (4-72h) y revocación automática
- **Transit engine** para envelope encryption sin manejar HSMs directamente
- **Token TTL** con auto-renewal (los pods no se enteran de las rotaciones)
- **Multi-cloud / multi-region replication** (PR cluster disaster recovery)
- **Policy as code** con HCL
- **Auth federation**: Kubernetes (ServiceAccount tokens), AWS IAM, GCP IAM, LDAP/OIDC

Competidores evaluados:

| Solución | Veredicto |
|----------|-----------|
| HashiCorp Vault OSS | ✅ Adoptado |
| AWS Secrets Manager | ❌ Lock-in a AWS, sin PKI dinámica |
| GCP Secret Manager | ❌ Lock-in GCP |
| Azure Key Vault | ❌ Lock-in Azure |
| Infisical | ❌ Más joven, comunidad pequeña |
| SOPS + KMS | ❌ Sin runtime fetching, sin rotación automática |

## 3. Decisión de arquitectura: HTTP API vs CLI

Vault tiene dos formas de integrarse:

### Opción A: HTTP API (nativo)
- Pros: cero dependencias nativas, paralelizable, trivial de mockear, control fino sobre TLS, retry/backoff
- Contras: hay que implementar autenticación, renovación, retries
- **Veredicto**: ✅ Adoptado

### Opción B: vault CLI subprocess
- Pros: shell battle-tested, fácil de debuggear
- Contras: spawn overhead (~50ms), stdout parsing, gestión de procesos en Deno, problemático con sandboxing
- **Veredicto**: ❌ Descartado

### Opción C: Cliente de terceros (node-vault)
- Pros: listo
- Contras: dep NPM, problemas de typings en Deno
- **Veredicto: ❌ Descartado**

**Resultado**: implementación custom de HTTP API client en `src/security/secrets/vault-client.ts` (442 LOC).

## 4. Endpoints implementados

### KV v2 (secretos genéricos)
- `GET /v1/{mount}/data/{path}` → `kvGet(path, version?)`
- `POST /v1/{mount}/data/{path}` → `kvPut(path, data)`
- `DELETE /v1/{mount}/data/{path}` → `kvDelete(path, versions?)`
- `LIST /v1/{mount}/metadata/{path}` → `kvList(path)`

Casos de uso: JWT keys, OAuth client secrets, vendor tokens, config sensible.

### Auth
- `POST /v1/auth/approle/login` → `loginAppRole(roleId, secretId)`
- `PUT /v1/auth/userpass/login/:user` → `loginUserpass(user, pass)`
- `POST /v1/auth/kubernetes/login` → `loginKubernetes(role, jwt)` (futuro)
- `GET /v1/token/self` → `lookupSelf()`
- `POST /v1/token/renew-self` → `renewSelf()`

### PKI
- `POST /v1/pki/issue/{role}` → `pkiIssue(role, commonName, opts)`

Caso de uso: certificados mTLS efímeros (4-72h) para pods k8s. Reduce dependencia de cert-manager.

### Transit (envelope encryption)
- `POST /v1/transit/encrypt/{key}` → `transitEncrypt(key, plaintext)`
- `POST /v1/transit/decrypt/{key}` → `transitDecrypt(key, ciphertext)`

Caso de uso: cifrado de PII en MongoDB sin manejar KEK/DEK directamente.

## 5. Seguridad del cliente

### 5.1 TLS obligatorio

```ts
function validateHttpsUrl(url: string, field: string) {
  if (!url.startsWith("https://")) {
    throw new Error(`[vault] ${field} must use HTTPS (CWE-319)`);
  }
}
```

Bloquea `http://` desde el constructor. Previene MITM por configuración insegura.

### 5.2 HTTPS con CA custom

Para entornos on-prem, el cliente acepta una CA adicional:

```ts
new VaultClient({
  address: "https://vault.internal:8200",
  caCert: readFileSync("/etc/zenith/vault-ca.pem"),
  token: "...",
});
```

Implementado vía `Deno.createHttpClient({ caCertificates: [...] })` con TLS pinning opcional por SPKI.

### 5.3 No log de tokens

El logger solo emite eventos con el **accessor** (no el token). El accessor es un identificador opaco que no es usable para autenticarse.

### 5.4 Retry con backoff exponencial

```ts
async rawRequest(method, url, body, auth = true, attempt = 0) {
  const res = await fetch(...);
  if (res.ok) return await res.json();
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    if (attempt < this.cfg.maxRetries) {
      const delay = this.cfg.retryBaseMs * 2 ** attempt;
      await sleep(delay + jitter);
      return this.rawRequest(method, url, body, auth, attempt + 1);
    }
  }
  // 4xx (no 429) o retries agotados: error inmediato
  throw new VaultError(...);
}
```

No se reintenta en 4xx (excepto 429) porque son errores del cliente (path incorrecto, permisos, etc.) que no se arreglan con reintentos.

### 5.5 Idempotencia

- `kvGet`, `lookupSelf`: idempotentes, se reintentan seguros
- `kvPut`, `kvDelete`: NO idempotentes si la red falla a mitad. Estrategia: el caller maneja deduplicación vía metadata.version
- `pkiIssue`: NO idempotente, los reintentos generan certificados duplicados. Caller debe cuidar.

## 6. Auto-activación y bootstrap

```ts
// src/mod.ts
const VAULT_ADDR = Deno.env.get("VAULT_ADDR");
if (VAULT_ADDR) {
  const vault = new VaultClient({
    address: VAULT_ADDR,
    roleId: Deno.env.get("VAULT_ROLE_ID"),
    secretId: Deno.env.get("VAULT_SECRET_ID"),
  });
  await vault.loginAppRole(...);
  // Cargar JWT keys desde Vault con auto-generación si no existen
  const { publicKey, privateKey } = await loadOrGenerateJwtKeys(vault, "zenith/jwt-keys");
  config.jwt.publicKey = publicKey;
  config.jwt.privateKey = privateKey;
} else {
  // Fallback a MongoDB (_GlobalConfig collection)
  ...
}
```

El sistema es **fail-safe**: si Vault no está disponible, Zenith arranca igual con claves en MongoDB. Esto permite desarrollo local sin Vault (firma `VAULT_ADDR`).

En producción, **se exige `VAULT_ADDR` configurado** vía `config-loader.ts` (ya existente desde Phase 0.B).

## 7. Tests

| Test type | Cobertura | Cantidad |
|-----------|-----------|----------|
| Unit (mock fetch) | constructor, KV v2, auth, PKI, Transit, retry, headers, errores | 17 |
| Integration (Vault real en Docker) | roundtrip, lookupSelf, kvList | 3 |
| Ignored (sin VAULT_TEST_ADDR) | integration | 1 |

**Total: 20 passing, 1 ignored**.

### Cómo correr los integration tests

```bash
docker run -d --name zenith-vault-test -p 8200:8200 \
  -e VAULT_DEV_ROOT_TOKEN_ID=root \
  -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
  hashicorp/vault:1.16

VAULT_TEST_ADDR=https://localhost:8200 VAULT_TEST_TOKEN=root \
  deno test --no-check --allow-all tests/unit/vault-client.test.ts
```

## 8. Operativa

### Despliegue recomendado

```
┌──────────────────┐
│ Zenith Pod (k8s) │
│                  │
│  VaultClient     │──── HTTPS ────▶ Vault HA Cluster
│  + AppRole auth  │                  (3 nodos mínimo)
│  + token renew   │◀──── audit ────▶  + S3 backend
└──────────────────┘
```

**Configuración mínima producción**:
- 3 instancias Vault en HA (Raft storage)
- S3 backend (o Azure Blob, GCS, Consul, etc.)
- Auto-unseal con AWS KMS / Azure Key Vault / GCP CKMS
- Network policies k8s: solo pods con label `app=zenith` pueden hablar a Vault
- Audit log a Splunk/Datadog/Loki (Vault → filebeat → Loki)
- 99.99% SLA con monitoring Prometheus + alerting

### Path conventions

- `secret/zenith/jwt-keys` (KV v2, par RSA/EdDSA)
- `secret/zenith/api-keys` (mapa de IDs)
- `secret/zenith/vendor/{stripe,twilio,...}` (tokens)
- `pki/zenith-mtls/` (CA + roles para mTLS)
- `transit/zenith-encryption` (KEK para PII)
- `auth/approle/login` (AppRole)
- `auth/kubernetes/login` (k8s, futuro)

### Rotación de JWT keys

```ts
async function rotateJwtKeys(vault: VaultClient, newKeyPair: KeyPair) {
  // 1. Escribir nueva key
  await vault.kvPut("zenith/jwt-keys", {
    publicKey: newKeyPair.publicKey,
    privateKey: newKeyPair.privateKey,
    kid: newKeyPair.kid,
    createdAt: new Date().toISOString(),
  });
  // 2. Los pods subsiguientes cargan la nueva key (vía auto-renewal)
  // 3. Cache local de kid → publicKey se invalida vía metadata
}
```

## 9. Trade-offs aceptados

1. **Vault como dependencia crítica**: si Vault cae, los pods existentes siguen funcionando (no revalidan tokens en cada request). Los pods nuevos fallan al arrancar. **Mitigación**: HA cluster + monitoring.
2. **Latencia adicional**: ~5-15ms por cada `kvGet` con caché fría. **Mitigación**: cache local con TTL de 5min.
3. **Complejidad operacional**: cluster Vault + unseal + policies + audit. **Mitigación**: Terraform/Opentofu IaC (no incluido en este repo, recomendación).

## 10. Roadmap

- **v2 (Q3 2026)**: K8s auth (ServiceAccount tokens), Transit engine para PII
- **v3 (Q4 2026)**: Dynamic secrets para MongoDB (genera credenciales temporales con TTL de 1h)
- **v4 (Q1 2027)**: Secret caching distribuido (Redis) para reducir latencia de Vault
- **v5 (Q2 2027)**: Multi-region replication (PR cluster) para disaster recovery

## 11. Conclusión

H-4 (Vault secrets) se cierra. La integración está:
- **Completa**: 20 tests, cubre KV/PKI/Transit/Auth
- **Segura**: HTTPS obligatorio, no log de tokens, retry con backoff, validación de CA
- **Operable**: auto-activación por env, fallback a MongoDB para dev
- **Documentada**: este informe + ADR-008

Recomendado: desplegar Vault HA cluster antes de producción.
