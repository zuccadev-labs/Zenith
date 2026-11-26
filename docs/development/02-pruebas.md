---
description: "Los niveles de prueba de Zenith, cómo ejecutarlos en local contra servicios reales y qué cubre el CI."
tipo: guia
---

# ¿Cómo se prueba Zenith y qué cubre el CI?

Por niveles, de las unitarias al chart desplegado en un Kubernetes real. Para mí una funcionalidad no está terminada
hasta que pasa contra servicios reales, no solo en pruebas unitarias; este documento es la receta.

## Qué ejecuta el CI

| Trabajo de `.github/workflows/ci.yml` | Qué hace |
|---|---|
| `engine` | Formato, lint, tipos y pruebas unitarias del motor con `deno.lock` congelado; publicación simulada en JSR |
| `integration` | Integración contra MongoDB 9.0.8 (standalone y replica set), SurrealDB 4 y Vault 2 con TLS; también la prueba de carga |
| `e2e-engine-auth` | Punta a punta con engine-auth real. Solo corre con la variable de repositorio `ZUTOOL_E2E=true` y una deploy key de solo lectura del repositorio de zutool, que es privado |
| `cli` | Formato, tipos y pruebas del CLI, `zen init` y `zen dev` de punta a punta, publicación simulada y `tools/docs-coverage.ts` |
| `sdk` | `npm ci` y tipos del SDK de cliente |
| `image` | Build de la imagen, Trivy, SBOM, firma y publicación en el registro propio |
| `chart` | Helm lint y render, kubeconform, promtool sobre las alertas |
| `security` | gitleaks sobre todo el historial, Semgrep, zizmor, actionlint, hadolint, Trivy config, Checkov y OSV-Scanner |

## Niveles

| Nivel | Qué prueba | Dónde |
|---|---|---|
| Unitarias | Módulos aislados, con dobles (`tests/unit/_fake_db.ts`) | Local y CI |
| Integración | Adaptadores contra MongoDB 9.0.8 (standalone y replica set), SurrealDB y Vault | Local y CI |
| Punta a punta | `createZenithApp` con MongoDB y engine-auth reales, peticiones HTTP y comprobación en la base (`tests/integration/pieces-e2e.test.ts`, `boot.test.ts`, `engine-auth.test.ts`, `classes.test.ts`) | Local, y CI con `ZUTOOL_E2E` (necesita el binario de engine-auth) |
| Imagen | Build, escaneo de Trivy y arranque del contenedor con MongoDB y ScyllaDB | CI (build y Trivy) y local (arranque) |

## Todo en local

```bash
# Servicios
docker run -d --rm --name zenith-it-mongo   -p 127.0.0.1:27999:27017 --memory 2g mongo:9.0.8
docker run -d --rm --name zenith-it-mongors -p 127.0.0.1:28000:27017 --memory 2g mongo:9.0.8 --replSet rs0 --bind_ip_all
docker exec zenith-it-mongors mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'

# engine-auth y libzutool_auth.so, compilados en un clon de zutool (cargo build -p engine-auth -p zutool-auth)
export ENGINE_AUTH_BIN=<zutool>/target/debug/engine-auth ZUTOOL_LIB_DIR=<zutool>/target/debug
export ZENITH_TEST_MONGO=mongodb://127.0.0.1:27999
export ZENITH_TEST_MONGO_URI="mongodb://127.0.0.1:27999/?directConnection=true"
export MONGO_TEST_URI="mongodb://127.0.0.1:28000/?replicaSet=rs0&directConnection=true"
export TMPDIR=$HOME/.cache/zenith-tests-tmp   # si /tmp es pequeño: las pruebas escriben bases y binarios

cd zenith-backend
deno lint src/ && deno check --frozen src/mod.ts
systemd-run --user --scope -p MemoryMax=6G -E TMPDIR -E ENGINE_AUTH_BIN -E ZUTOOL_LIB_DIR -E ZENITH_TEST_MONGO \
  -E ZENITH_TEST_MONGO_URI -E MONGO_TEST_URI \
  deno test --allow-all --no-check --unstable-kv --frozen --ignore=tests/integration/engine.test.ts tests/
```

SurrealDB y Vault (con TLS, como exige el cliente):

```bash
docker run -d --rm --name zenith-it-surreal -p 127.0.0.1:28800:8000 surrealdb/surrealdb:v4.0.1 start --user root --pass root memory
docker run -d --rm --name zenith-it-vault -p 127.0.0.1:28200:8200 --cap-add IPC_LOCK -e VAULT_DEV_ROOT_TOKEN_ID=root \
  hashicorp/vault:2.2.2 server -dev -dev-tls -dev-listen-address=0.0.0.0:8200 -dev-tls-san=127.0.0.1
docker exec zenith-it-vault sh -c 'cat /tmp/vault-tls*/vault-ca.pem' > $TMPDIR/vault-ca.pem
export ZENITH_TEST_SURREAL_URL=http://127.0.0.1:28800 VAULT_TEST_ADDR=https://127.0.0.1:28200 VAULT_TEST_TOKEN=root
export DENO_CERT=$TMPDIR/vault-ca.pem
```

Sin un servicio, sus pruebas se omiten (`ignored`) en lugar de fallar. Con todos levantados no se omite ninguna.
La primera ejecución contra SurrealDB 4 (la versión del laboratorio) encontró que el adaptador estaba escrito para
2.x: no creaba el namespace ni la base, usaba `type::thing` (ahora `type::record`) y fallaba al leer una tabla aún
vacía.

## El laboratorio completo, en local

`tests/integration/engine.test.ts` arranca Zenith con todos los servicios del laboratorio, con las mismas imágenes
que `lab-infra/docker/docker-compose.yml`. Necesita `ZENITH_MASTER_KEY`, `MONGO_URI`, el binario y la biblioteca de
engine-auth; sin ellos sus 20 pruebas se omiten.

```bash
docker run -d --rm --name zenith-it-scylla -p 127.0.0.1:29042:9042 --memory 3g scylladb/scylla:2026.1.15 \
  --smp 1 --memory 1G --overprovisioned 1 --developer-mode 1
docker run -d --rm --name zenith-it-lux -p 127.0.0.1:29079:6379 -e LUX_BIND_HOST=0.0.0.0 -e LUX_PASSWORD=$LUXPW \
  ghcr.io/lux-db/lux:0.37.1
docker run -d --rm --name zenith-it-rustfs -p 127.0.0.1:29000:9000 -e "RUSTFS_VOLUMES=/data/rustfs{0..3}" \
  -e RUSTFS_UNSAFE_BYPASS_DISK_CHECK=true -e RUSTFS_ADDRESS=0.0.0.0:9000 -e RUSTFS_ACCESS_KEY=zenithlab \
  -e RUSTFS_SECRET_KEY=$RSK rustfs/rustfs:1.0.6
export ZENITH_MASTER_KEY=$(openssl rand -hex 40) MONGO_URI="mongodb://127.0.0.1:27999/lab?directConnection=true" \
  SCYLLA_URI=127.0.0.1:29042 RUSTFS_URI=http://127.0.0.1:29000 RUSTFS_ACCESS_KEY=zenithlab RUSTFS_SECRET_KEY=$RSK \
  REDIS_URI="redis://:$LUXPW@127.0.0.1:29079"
```

## Carga y fallos

`tests/integration/stress.test.ts` (con `ZENITH_STRESS=1`, el replica set y `ZENITH_STRESS_MONGO_CONTAINER`):
- **Cola:** 3 instancias procesan 600 trabajos sobre el mismo MongoDB. El 10 % falla una vez y MongoDB se pausa
  3 s en mitad de la ejecución.
- **Webhooks:** 300 mensajes, con un receptor que rechaza el 20 %.
- **Lo que comprueba:** cada trabajo se ejecuta y cada mensaje se acepta **exactamente una vez**.

Quitando la concesión de la condición de reclamo (`core/outbox.ts`), la prueba falla con duplicados reales.
Durante la pausa el driver de MongoDB espera en lugar de fallar, y el trabajo continúa al reanudarse.

## La imagen, de verdad

```bash
docker build -t zenith-backend:local zenith-backend/
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.76.2 image \
  --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 zenith-backend:local
docker run -d --rm --name zenith-it-scylla -p 127.0.0.1:29042:9042 --memory 3g scylladb/scylla:2026.1.15 \
  --smp 1 --memory 1G --overprovisioned 1 --developer-mode 1
docker run -d --name zenith-smoke --network host --read-only --tmpfs /tmp:exec -v zenith-smoke-data:/data \
  -e APP1_MASTER_KEY=$(openssl rand -hex 40) -e APP2_MASTER_KEY=$(openssl rand -hex 40) \
  -e MONGO_URI="mongodb://127.0.0.1:27999/smoke?directConnection=true" -e SCYLLA_URI=127.0.0.1:29042 \
  -e WEBHOOK_SECRETS_KEY=$(openssl rand -hex 32) zenith-backend:local
curl http://127.0.0.1:1337/parse/health
```

El arranque con el sistema de archivos de solo lectura encontró dos fallos que las pruebas no veían: el binario no
incluía `apps.config.ts` (import dinámico que `deno compile` no sigue) y los archivos se escribían en `/app`, donde
el usuario `zenith` no puede escribir.

## Lockfiles

`deno.lock` (motor y CLI) y `package-lock.json` (SDK) están versionados, y el CI usa `--frozen` / `npm ci`. Si
cambias dependencias, actualiza el lock en el mismo commit (`deno install`, `npm install`).

## El chart, en un Kubernetes real (kind + Calico)

Validar el chart (helm lint, kubeconform, Checkov) no basta: hay que desplegarlo. La red por defecto de kind
(kindnet) **no aplica NetworkPolicies**, así que el clúster de prueba usa Calico.

```bash
cat > kind-calico.yaml <<'K'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking: { disableDefaultCNI: true, podSubnet: 10.244.0.0/16 }
K
kind create cluster --name zenith-chart --config kind-calico.yaml
gh api -H "Accept: application/vnd.github.raw" "repos/projectcalico/calico/contents/manifests/calico.yaml?ref=v3.33.0" > calico.yaml
docker cp calico.yaml zenith-chart-control-plane:/calico.yaml
docker exec zenith-chart-control-plane kubectl apply -f /calico.yaml
kind load docker-image zenith-backend:local --name zenith-chart
# MongoDB y ScyllaDB en la red "kind" (Scylla debe arrancar ya en ella: escucha en su IP de arranque)
# secreto zenith-secrets con APP1/APP2_MASTER_KEY, WEBHOOK_SECRETS_KEY, MONGO_URI, SCYLLA_URI
helm install zenith k8s/helm/zenith -n zenith --set image.repository=zenith-backend --set image.tag=local \
  --set image.pullPolicy=Never --set autoscaling.enabled=false --set replicaCount=1 -f np-test.yaml
helm test zenith -n zenith
```

Se comprueba:

- **el pod llega a Ready**, con las sondas en `/health`;
- **pasa `helm test`;**
- **la NetworkPolicy se aplica** (pod con las etiquetas de Zenith frente a pod sin ellas):
  - salida: solo DNS, las bases de datos declaradas y HTTPS;
  - entrada: el propio namespace llega a todo, `monitoring` solo a 9090 y el resto a nada.

La primera vez (2026-11-11) destapó fallos que ninguna validación estática veía:

- **El pod no arrancaba.** La app escuchaba siempre en 1337 aunque el chart dijera otro puerto (producción usaba
  8080), y `/health` fuera de un montaje daba 404, así que las sondas nunca pasaban.
- **Las rutas de escritura.** Raíz de solo lectura sin volúmenes para `/data` ni `/tmp`, y UID 1000 frente al 10001
  dueño de `/data` en la imagen.
- **La NetworkPolicy solo permitía MongoDB como pod del mismo namespace**, así que una base de datos gestionada era
  inalcanzable, y no había forma de declarar ScyllaDB o Redis.
- **`helm test` fallaba siempre:** su pod llevaba las etiquetas selectoras de Zenith, era endpoint del Service y
  quedaba bajo la política de Zenith.
