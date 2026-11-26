---
description: "El registro de imágenes propio (Zot): por qué existe, cómo se despliega, cómo se publica y verifica una imagen y cómo se deshace."
tipo: guia
---

# ¿Cómo funciona el registro propio (Zot)?

Zot guarda la imagen del servidor con sus firmas y atestaciones de cosign. Está desplegado desde el 2026-11-12 en
`registry.vemar.app`: Zot 2.1.23 en un droplet de DigitalOcean, con el DNS en Cloudflare y el registro A sin
proxy, porque el proxy gratuito corta las subidas de más de 100 MB. La contraseña de `reader` está en
`~/.config/zenith/registry-reader.env` (0600) de la máquina que lo desplegó.

## Por qué

GHCR da 500 MB a los repos privados del plan gratuito, y las atestaciones de GitHub exigen Enterprise.
[Zot](https://zotregistry.dev) es un registro OCI 1.1 de código abierto (Apache-2.0). Guarda las firmas y
atestaciones de cosign como *referrers* de la imagen, sin etiquetas aparte, y es un binario único con poca memoria.
La imagen de Zenith comprimida ocupa unos 97 MB.

## Cómo está montado

- **Configuración:** `infra/registry/zot-config.json`.
- **Acceso:** autenticación htpasswd con bcrypt.
  - `ci` puede leer y escribir (lo usa el CI);
  - `reader` solo lee (despliegues y personas);
  - `engines` publica los motores del ecosistema: lee, crea y actualiza solo en `zutool/**` y `chifof/**`, sin borrar. Se crea con
    `infra/registry/add-user.sh root@<servidor> registry.vemar.app engines`, que guarda su contraseña en el llavero
    (`zkeyring get zenith-registry engines-password`) y deja copia `*.bak-<fecha>` de la configuración en el servidor;
  - para cambiar solo los permisos (sin tocar usuarios ni contraseñas): `infra/registry/apply-config.sh root@<servidor>
    registry.vemar.app`;
  - el acceso anónimo está cerrado (401).
- **Formatos:** OCI y, con `http.compat: ["docker2s2"]`, el manifiesto clásico de Docker (schema 2), que es lo
  que publica Docker con el almacén de imágenes clásico, como en los runners de GitHub. Sin eso Zot responde 415.
- **Retención:** las últimas 20 etiquetas por repositorio. Se borran las imágenes sin etiqueta, pero nunca las firmas
  ni las atestaciones de una imagen que se conserva. Hay scrub diario de integridad.
- **Contenedor:**
  - `--user 65532`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`;
  - 384 MB de memoria;
  - solo en `127.0.0.1`, detrás de Caddy, que pone el TLS.

## Desplegar

1. Crea el registro DNS A del dominio hacia el servidor, por ejemplo `registry.vemar.app`.
2. Ejecuta desde la raíz del repo:

```bash
infra/registry/deploy.sh root@<servidor> registry.vemar.app
```

El script es aditivo:

- **en el servidor:**
  - `/etc/zot` y `/var/lib/zot`;
  - el contenedor `zenith-zot`;
  - un bloque en el Caddyfile, con copia de seguridad previa y `caddy validate`;
- **en GitHub:** la variable `ZENITH_REGISTRY` y los secretos `ZENITH_REGISTRY_USER` y `ZENITH_REGISTRY_PASSWORD`.

Las contraseñas se generan en tu máquina y al servidor solo llegan los hashes. Al final muestra una vez la contraseña
de `reader`.

Con la clave de cosign configurada (`supply-chain.md`), cada CI de `main` hace esto:

1. publica `zenith/zenith-backend:<sha>`;
2. lo firma;
3. le adjunta la provenance SLSA y el SBOM;
4. lo verifica;
5. deja la referencia por digest en el archivo `zenith-backend.image-ref` del artefacto `sbom-zenith-backend-<sha>`
   (`gh run download <run> -n sbom-zenith-backend-<sha>`).

Primera publicación verificada el 2026-11-12 (run 43159733424): la firma y las atestaciones SLSA y CycloneDX
validan con `cosign.pub`, `reader` descarga pero no puede publicar y el acceso anónimo recibe 401.

## Usarlo en Kubernetes

```yaml
# values-prod.yaml
image:
  registry: registry.vemar.app
  repository: zenith/zenith-backend
  tag: "<sha>"
  digest: "sha256:…"   # el de zenith-backend.image-ref: fija exactamente la imagen firmada
imagePullSecrets:
  - name: zenith-registry   # kubectl create secret docker-registry zenith-registry --docker-server=… --docker-username=reader --docker-password=…
```

## Rollback

En el servidor:

1. restaura la copia `Caddyfile.bak-zenith-registry-*`, ejecuta `caddy validate` y `systemctl reload caddy`;
2. `docker rm -f zenith-zot`;
3. `rm -r /etc/zot /var/lib/zot`.

En GitHub, borra la variable y los secretos:

```bash
gh variable delete ZENITH_REGISTRY
gh secret delete ZENITH_REGISTRY_USER
gh secret delete ZENITH_REGISTRY_PASSWORD
```
