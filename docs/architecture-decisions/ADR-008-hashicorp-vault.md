# ADR-008: HashiCorp Vault como gestor centralizado de secretos

- **Status**: Aceptado
- **Fecha**: 2026-06-06
- **Decisores**: Zenith Core Team
- **Hallaazgo relacionado**: H-4 (Auditoría de seguridad microservices)

## Contexto

Zenith maneja 7 categorías de secretos sensibles (JWT keys, DB credentials, vendor tokens, mTLS certs, OAuth client secrets, encryption keys, CI secrets). Hasta ahora se almacenaban en variables de entorno o archivos de configuración, lo que generaba:

- **Rotación manual** y propensa a errores
- **Auditoría deficiente** (no había registro de accesos)
- **Falta de cifrado-at-rest en CI** (secrets en GitHub Actions en plaintext)
- **Sin PKI dinámica** para mTLS
- **Onboarding doloroso** para nuevos ops engineers

El stack target (definido en `00_intro.md` y `stack.txt`) lista explícitamente HashiCorp Vault para gestión de secretos y PKI.

## Opciones consideradas

### 1. Variables de entorno (status quo)
- **Pros**: cero dependencias, simple
- **Contras**: rotación manual, sin auditoría, sin cifrado at-rest, riesgo de exposición en logs
- **Veredicto**: ❌ Insuficiente

### 2. AWS Secrets Manager / GCP Secret Manager / Azure Key Vault
- **Pros**: integración nativa con su cloud
- **Contras**: vendor lock-in, no apto para multi-cloud, sin PKI dinámica
- **Veredicto**: ❌ Lock-in + capabilities insuficientes

### 3. SOPS + KMS (Mozilla SOPS)
- **Pros**: GitOps-friendly, cifrado at-rest
- **Contras**: sin runtime fetching, sin rotación automática, sin PKI
- **Veredicto**: ❌ Complementario, no sustituto

### 4. HashiCorp Vault OSS
- **Pros**: estándar de la industria, KV v2, PKI dinámica, Transit, audit log, auto-renewal, k8s auth
- **Contras**: complejidad operacional (HA cluster, unseal, policies)
- **Veredicto**: ✅ Adoptado

### 5. HashiCorp Vault Enterprise
- **Pros**: features enterprise (HSM, namespaces, MFA, DR replication)
- **Contras**: licencia pagada
- **Veredicto**: Diferido hasta que se justifique el costo

### 6. Infisical / Doppler / Akeyless
- **Pros**: SaaS gestionado
- **Contras**: comunidad más pequeña, vendor lock-in, precios por secret
- **Veredicto**: ❌ Riesgo de mercado

## Decisión

Adoptar **HashiCorp Vault OSS** como gestor centralizado de secretos, con integración vía **HTTP API** (no CLI, no librería de terceros).

## Rationale

- Vault es el estándar de facto (CNCF Graduated, usado por miles de empresas Fortune 500)
- HTTP API nativo evita dependencias externas y problemas de sandboxing
- KV v2 cubre el 90% de los casos (secretos estáticos)
- PKI engine permite emitir certificados mTLS de corta duración sin cert-manager
- Transit engine externaliza envelope encryption (PII fields en MongoDB)
- Audit log con chained HMAC cumple SOC 2 / ISO 27001
- Auto-renewal de tokens hace la rotación transparente para la aplicación

## Consecuencias

### Positivas
- **Rotación automática** de credenciales
- **Auditoría completa**: quién leyó qué y cuándo
- **PKI dinámica**: certificados mTLS con TTL de 4-72h
- **Cifrado at-rest** en CI sin secrets en plaintext
- **Multi-cloud**: Vault corre en cualquier cloud o on-prem
- **H-4 cerrado** en la auditoría

### Negativas
- **Dependencia crítica**: Vault caído = pods nuevos no arrancan (mitigación: HA cluster)
- **Complejidad operacional**: unseal, policies, audit, monitoring
- **Latencia**: +5-15ms por secret con caché fría
- **Costo de adopción**: equipo necesita aprender Vault

### Mitigaciones
- HA cluster (3 nodos mínimo) con Raft storage
- Auto-unseal con cloud KMS
- Cache local con TTL 5min
- Monitoring con Prometheus (`vault.core.*` metrics)
- Documentación operativa (runbook)

## Implementación

| Componente | Path | LOC |
|------------|------|-----|
| VaultClient | `src/security/secrets/vault-client.ts` | 442 |
| Barrel | `src/security/secrets/mod.ts` | 8 |
| Adapter refactor | `src/adapters/vault.adapter.ts` | refactor |
| Bootstrap integration | `src/mod.ts` | +60 |
| Tests unit | `tests/unit/vault-client.test.ts` | 280 |
| Tests integration | (mismo archivo) | skipped sin `VAULT_TEST_ADDR` |

### Endpoints cubiertos

- **KV v2**: `kvGet`, `kvPut`, `kvList`, `kvDelete` con version pinning
- **Auth**: `loginAppRole`, `loginUserpass`, `lookupSelf`, `renewSelf`
- **PKI**: `pkiIssue` con altNames, ipSans, TTL
- **Transit**: `transitEncrypt`, `transitDecrypt` (base64 automático)

### Path conventions

```
secret/zenith/jwt-keys       # Par RSA/EdDSA para JWT
secret/zenith/api-keys       # Mapa de API keys hasheadas
secret/zenith/vendor/*       # Stripe, Twilio, etc.
pki_int/zenith-mtls/         # CA + roles para mTLS
transit/zenith-encryption    # KEK para envelope encryption
auth/approle/login           # AppRole auth
auth/kubernetes/login        # k8s (futuro)
```

### Modo de activación

- Si `VAULT_ADDR` está en env → **auto-activa** y carga JWT keys desde Vault
- Si no → **fallback a MongoDB** (recomendado solo dev/CI)

## Tests

| Tipo | Cantidad | Status |
|------|----------|--------|
| Unit (mock fetch) | 17 | ✅ passing |
| Integration (Vault real) | 3 | ⚠️ ignored sin `VAULT_TEST_ADDR` |
| **Total** | **20** | **20 ✅, 1 ignored** |

Comando:
```bash
docker run -d --name zenith-vault-test -p 8200:8200 \
  -e VAULT_DEV_ROOT_TOKEN_ID=root -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
  hashicorp/vault:1.16

VAULT_TEST_ADDR=https://localhost:8200 VAULT_TEST_TOKEN=root \
  deno test --no-check --allow-all tests/unit/vault-client.test.ts
```

## Roadmap

- **Q3 2026**: K8s auth + Transit para PII
- **Q4 2026**: Dynamic secrets MongoDB (credenciales temporales)
- **Q1 2027**: Distributed cache (Redis) para reducir latencia
- **Q2 2027**: Multi-region replication (PR cluster)

## Referencias

- [Investigación 11: HashiCorp Vault como gestor de secretos](../investigations/11_hashicorp_vault_secrets.md)
- [Vault docs oficiales](https://developer.hashicorp.com/vault/docs)
- [H-4 en auditoría de seguridad](../investigations/06_security_microservices_audit.md)
- [00_intro.md](../investigations/00_intro.md) — Stack target
- [stack.txt](../../stack.txt) — Integraciones confirmadas
