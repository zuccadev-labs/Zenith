---
description: "Lo que analiza el CI en cada ejecución, el SBOM y la firma y atestación de la imagen del servidor."
tipo: explicacion
---

# ¿Cómo se analizan, firman y atestiguan las imágenes?

El CI analiza secretos, código, flujos de trabajo, Dockerfile, configuración y dependencias en cada ejecución;
genera el SBOM de la imagen y la firma dos veces, con clave propia y sin clave (Sigstore). Todo funciona con el plan
gratuito de GitHub desde que el repositorio es público (2026-11-19).

## Qué hace el CI en cada ejecución

| Paso | Herramienta | Falla el CI si… |
|---|---|---|
| Secretos en todo el historial | gitleaks 8.30.1 | aparece un secreto que no está en `.gitleaksignore`, donde cada falso positivo revisado figura por su huella |
| Análisis estático (SAST) | Semgrep OSS 1.185, reglas `p/default` | hay un hallazgo WARNING o ERROR |
| Vulnerabilidades de la imagen | Trivy 0.69 (acción v0.36.0) | hay una CRITICAL o HIGH con arreglo disponible |
| Inventario de componentes | syft (CycloneDX 1.7) | — (se publica como artefacto) |
| Firma del SBOM y del ID de la imagen | cosign 3.1.4, con clave propia | la firma no verifica con `zenith-backend/cosign.pub` |
| Provenance SLSA v1 | `tools/supply-chain/slsa-provenance.sh` + `cosign attest-blob` | la atestación no verifica |
| Publicación en el registro (desde `main`) | Zot propio + `cosign sign`/`attest` sobre el digest | la firma o la provenance no verifican |
| Firma *keyless* de la imagen (desde `main`) | cosign con la identidad OIDC del workflow, en el log público Rekor | la firma no verifica con la identidad exacta de `ci.yml@refs/heads/main` |
| Atestaciones de GitHub (desde `main`) | `actions/attest` 4.2: provenance SLSA y SBOM CycloneDX sobre el digest | — (las verifica `gh attestation verify`) |
| Paquetes npm y JSR | `release.yml` por tag, OIDC sin tokens; npm `--provenance`, JSR con provenance del repositorio vinculado | la versión del tag no es la del manifiesto |
| Vulnerabilidades de dependencias npm | OSV-Scanner 2.7 (`osv-scanner.toml` por carpeta para excepciones revisadas, con fecha de caducidad) | hay una vulnerabilidad conocida |
| Vulnerabilidades de dependencias Deno | `deno audit` (OSV-Scanner no lee `deno.lock`) | hay una vulnerabilidad conocida |
| Infraestructura como código | Trivy config 0.76 (`.trivyignore.yaml`) y Checkov 3.4 (`.checkov.yaml`, y sobre el chart renderizado) | un hallazgo HIGH/CRITICAL sin justificar |
| Dockerfile | hadolint 2.15 | un aviso |
| Workflows de GitHub Actions | zizmor 1.32 (medio y superior) y actionlint 1.7 | inyección de plantillas, credenciales persistidas, acciones sin fijar… |
| Dependencias | Dependabot (Deno, npm, Docker, Compose y Actions) | — (abre PR semanales) |

Todas las Actions de terceros están fijadas por SHA de commit, con la versión en un comentario; Dependabot las
actualiza.

## Activar la firma (una vez)

> Hecho el 2026-11-12: `zenith-backend/cosign.pub` está versionada y los secretos están en GitHub. La clave privada
> cifrada y su contraseña quedaron en `~/.config/zenith/cosign/` (0600) de la máquina que la generó: muévelas a un
> gestor de secretos. Para rotarla, repite estos pasos.

La firma usa **una clave propia** y **no** publica nada en el log de transparencia público de Sigstore. La firma
*keyless* sí lo haría, y con ella el nombre de este repositorio privado y de su workflow. Esa es la razón.

```bash
cosign generate-key-pair        # pide una contraseña; crea cosign.key (privada) y cosign.pub (pública)
gh secret set COSIGN_PRIVATE_KEY -R zuccadev-labs/Zenith < cosign.key
gh secret set COSIGN_PASSWORD    -R zuccadev-labs/Zenith      # la contraseña de la clave
mv cosign.pub zenith-backend/cosign.pub && git add zenith-backend/cosign.pub   # se versiona la pública
shred -u cosign.key             # la privada solo vive en el secreto (o en tu gestor de secretos)
```

A partir de ahí, el job `image` firma `zenith-backend.cdx.json` (el SBOM) y `zenith-backend.image-id` (el ID de la
imagen construida), verifica las firmas con la clave pública del repo y publica todo como artefacto.

## Verificar una imagen

```bash
gh run download <run-id> -R zuccadev-labs/Zenith -n sbom-zenith-backend-<sha>
cosign verify-blob --key zenith-backend/cosign.pub --insecure-ignore-tlog=true \
  --bundle zenith-backend.image-id.sigstore.json zenith-backend.image-id
docker image inspect zenith-backend:<tag> --format '{{.Id}}'   # tiene que ser el ID firmado
```

`--insecure-ignore-tlog=true` es necesario porque, a propósito, no se publica en el log de transparencia; la
confianza la da la clave pública versionada. Una modificación de un solo byte en lo firmado hace fallar la
verificación (probado en local).

## Verificar la provenance y la imagen del registro

```bash
cosign verify-blob-attestation --key zenith-backend/cosign.pub --insecure-ignore-tlog=true --type slsaprovenance1 \
  --bundle zenith-backend.image-id.provenance.sigstore.json zenith-backend.image-id
cosign verify --key zenith-backend/cosign.pub --insecure-ignore-tlog=true <registro>/zenith/zenith-backend@sha256:…
cosign verify-attestation --key zenith-backend/cosign.pub --insecure-ignore-tlog=true --type slsaprovenance1 \
  <registro>/zenith/zenith-backend@sha256:…
```

La provenance dice qué se construyó (repositorio y commit), cómo (workflow, ejecución, evento) y a partir de qué
(los digests de las imágenes base del Dockerfile). Es el mismo predicado SLSA que generan las atestaciones de GitHub,
firmado con nuestra clave en lugar de la de GitHub.

## Verificar sin nuestra clave (keyless y atestaciones de GitHub)

Desde que el repositorio es público, cada imagen de `main` lleva además una firma *keyless* registrada en Rekor y
las atestaciones de GitHub. Las dos se verifican solo con la identidad del workflow:

```bash
cosign verify <registro>/zenith/zenith-backend@sha256:… \
  --certificate-identity https://github.com/zuccadev-labs/Zenith/.github/workflows/ci.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://<registro>/zenith/zenith-backend@sha256:… -R zuccadev-labs/Zenith
gh attestation verify oci://<registro>/zenith/zenith-backend@sha256:… -R zuccadev-labs/Zenith \
  --predicate-type https://cyclonedx.org/bom
```

La firma con clave propia se mantiene: sirve sin conexión y sin depender de Sigstore.

## Lo que GitHub cobra y cómo se cubre gratis

| De pago en un repo privado | Alternativa libre en uso |
|---|---|
| CodeQL (licencia: solo código abierto) | Semgrep OSS, Trivy, Checkov, hadolint, zizmor, actionlint, OSV-Scanner, `deno audit` |
| Atestaciones de GitHub (Enterprise) | Provenance SLSA v1 firmada con cosign y clave propia, sin log público |
| Registro con espacio (GHCR: 500 MB) | Zot propio ([Registro de imágenes](./06-registro-de-imagenes.md)). La imagen comprimida pesa ~97 MB |
| Protección de ramas / rulesets | `.githooks/pre-push` + `tools/ship.sh` (push → CI de ese commit → veredicto) |
| CI en cada push | `tools/ship.sh` lanza el CI del commit empujado y espera su resultado |

## Pendiente para el futuro

- **CodeQL.** Con el repositorio público su licencia ya lo permite; añadirlo es el siguiente paso de análisis.
- La tabla anterior describe el repositorio cuando era privado. Hoy las atestaciones de GitHub, la firma *keyless*
  y los rulesets (`main` sin force-push ni borrado) ya están activos.
