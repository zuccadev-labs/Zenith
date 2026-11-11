# Cadena de suministro: análisis, SBOM y firma

> Vigente a 2026-11-11. Todo lo de esta página funciona con el plan gratuito de GitHub. Lo que exige un plan de
> pago está al final.

## Qué hace el CI en cada ejecución

| Paso | Herramienta | Falla el CI si… |
|---|---|---|
| Secretos en todo el historial | gitleaks 8.30.1 | aparece un secreto que no está en `.gitleaksignore`, donde cada falso positivo revisado figura por su huella |
| Análisis estático (SAST) | Semgrep OSS 1.185, reglas `p/default` | hay un hallazgo WARNING o ERROR |
| Vulnerabilidades de la imagen | Trivy 0.69 (acción v0.36.0) | hay una CRITICAL o HIGH con arreglo disponible |
| Inventario de componentes | syft (CycloneDX 1.7) | — (se publica como artefacto) |
| Firma del SBOM y del ID de la imagen | cosign 3.1.4, con clave propia | la firma no verifica con `zenith-backend/cosign.pub` |
| Dependencias | Dependabot (Deno, npm, Docker, Compose y Actions) | — (abre PR semanales) |

## Activar la firma (una vez)

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

## Pendiente para el futuro (planes de pago o infraestructura que no hay)

- **CodeQL.** Su licencia prohíbe usarlo en código de un repositorio privado sin GitHub Advanced Security (*"any
  codebase that is not an Open Source Codebase (e.g., code in a private repo in GitHub)"*), incluso la CLI. Hasta
  entonces cubre Semgrep.
- **Protección de rama y rulesets.** No existen en repos privados del plan gratuito de organizaciones.
- **Firma en un registro y atestaciones** (`cosign sign <imagen>`, `actions/attest-build-provenance`). Necesitan
  publicar la imagen en un registro (GHCR da 500 MB a los privados gratuitos y la imagen pesa unos 490 MB), y las
  atestaciones de repos privados exigen GitHub Enterprise.
- **Firma keyless con OIDC.** Es gratuita, pero publica la identidad del repo en el log público. Tiene sentido si el
  repo se hace público.
