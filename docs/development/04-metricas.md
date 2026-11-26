# Métricas, alertas y dashboard

> Vigente a 2026-11-11. Probado de punta a punta: imagen de Zenith con MongoDB y ScyllaDB, Prometheus 3.16 raspando
> el puerto de métricas con las reglas canónicas y Grafana 13.3 con el dashboard (ver «Cómo se probó»).

## Cómo se raspa

Cada app tiene su ruta `/metrics` bajo su montaje (`/parse/metrics`), pero detrás del pipeline: pide Application ID y
una clave. Prometheus no la puede leer, y no debe: esa ruta pasa por el Ingress.

Por eso el proceso abre **un listener aparte** cuando existe `ZENITH_METRICS_PORT`
(`src/observability/metrics-server.ts`):

- Responde `GET /metrics` y nada más: cualquier otra ruta da 404 y cualquier otro método, 405.
- No pide credenciales. Lo protege la red, no una clave:
  - el chart no lo publica en el Ingress;
  - la NetworkPolicy solo deja entrar al namespace de monitorización.
- Junta las series de todas las apps del proceso en una sola exposición. Cada serie lleva la etiqueta `app` y cada
  familia tiene una sola línea `# TYPE` (Prometheus rechaza una familia declarada dos veces).
- `ZENITH_METRICS_HOST` fija la interfaz. Por defecto escucha en todas, que dentro de un pod es la red del pod.

En el chart, `service.metricsPort` (9090 por defecto) es el puerto que usan:

- la variable `ZENITH_METRICS_PORT` del contenedor;
- el puerto `metrics` del Service;
- el ServiceMonitor;
- las anotaciones `prometheus.io/*`;
- la regla de la NetworkPolicy.

**Antes de este cambio el ServiceMonitor apuntaba a un puerto 9090 que nadie servía**, así que en Kubernetes no se
raspaba nada.

## Catálogo

| Métrica | Tipo | Etiquetas | Dónde |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `code` | middleware HTTP (`observability.trait.ts`) |
| `http_request_duration_seconds` | histogram (buckets de Prometheus, 5 ms – 10 s) | `method`, `route` | ídem |
| `zenith_master_key_usage_total` | counter | — | `core/pipeline.ts` (`onMasterKey`), solo la master key estática |
| `zenith_api_key_requests_total` | counter | `env` (`live`/`test`) | `core/pipeline.ts` (`onApiKey`) |
| `zenith_circuit_breaker_state` | gauge (1 el estado actual, 0 los demás) | `circuit`, `state` (`CLOSED`/`OPEN`/`HALF_OPEN`) | `resilience/circuit.breaker.trait.ts` |
| `zenith_jobs_total` | counter | `type`, `result` | cola duradera (ADR-017) |
| `zenith_job_duration_ms` | summary (count y sum) | `type`, `result` | ídem |
| `zenith_jobs` | gauge | `status` (`pending`, `failed`) | ídem, `reportBacklog()` |
| `zenith_webhook_attempts_total` | counter | `result` | webhooks |
| `zenith_webhook_attempt_duration_ms` | summary | `result` | ídem |
| `zenith_webhook_messages_failed_total`, `zenith_webhook_endpoints_disabled_total` | counter | — | ídem |
| `zenith_webhook_messages`, `zenith_webhook_endpoints_disabled` | gauge | `status` | ídem |

Además, en el listener todas las series llevan `app`, y Prometheus añade `job` e `instance`.

### La etiqueta `route`

`route` es **la plantilla de la ruta que sirve la petición**, tal como la resuelve el router
(`ZenithRouter.routeOf`): `/classes/:className/:objectId`, `/queue/enqueue`, `/login`. Si ninguna ruta coincide, vale
`unmatched`, aunque la respuesta sea un 401 o un 429. Así:

- un escáner que prueba mil rutas suma a una sola serie;
- un id de objeto nunca llega a una etiqueta.

La ruta no lleva el prefijo de montaje (`/parse`): el servidor lo quita antes de pasar la petición a la app.

Sin router, en los tests o fuera del servidor, `routeLabel()` cambia los ids por `:id`, y un 404 fuera de las rutas
de objetos da `unmatched`.

## Alertas

La fuente es `observability/prometheus/zenith-alerts.yaml` (28 reglas). El chart incluye una copia en
`k8s/helm/zenith/files/` y el CI comprueba con `cmp` que sea idéntica. `prometheusRule.groups` solo sirve para grupos
extra, y está vacío en `values.yaml` y en `values-prod.yaml`. Antes, producción repetía 7 reglas, con etiquetas que el
código no emite, y promtool las rechazaba por duplicadas.

Cambios de este repaso:

- **`ZenithCircuitOpen`** pasa al archivo canónico, ahora que el circuit breaker publica su estado.
- **`ZenithCrashLooping`** reemplaza a `ZenithPluginSignatureInvalid`. Cuando la firma de un plugin no verifica, el
  arranque se aborta (`[SecOps H-05] ABORT`) y el proceso nunca sirve `/metrics`, así que un contador de fallos no se
  podía raspar. Lo que se ve es un pod que no arranca, y eso es lo que vigila la alerta. La descripción indica qué
  línea buscar en el log.
- **`ZenithHpaAtMax`** usaba una etiqueta `deployment` que kube-state-metrics no pone. Ahora usa
  `horizontalpodautoscaler`.
- Las alertas de errores usan `code` (no `status`) y la de latencia de login usa `route="/login"`.

## Dashboard

`observability/grafana/zenith-sre-overview.json` tiene 22 paneles. Una fila nueva, «Background work, resilience and
security», muestra:

- jobs por tipo y resultado, su backlog y su duración media;
- intentos y mensajes de webhooks;
- circuit breakers abiertos;
- usos de la master key;
- 401 y 429 por segundo.

La disponibilidad, la tasa de error y el burn rate usan `(… code=~"5.." …) or vector(0)` en el numerador. Sin errores
muestran 100 % y 0, en lugar de quedarse sin datos.

## Cómo se probó

```bash
docker build -t zenith-backend:local zenith-backend/
# MongoDB y ScyllaDB como en zenith-backend/docs/testing.md; luego:
docker run -d --name zenith-smoke --network host ... -e ZENITH_METRICS_PORT=29090 zenith-backend:local
# Prometheus 3.16.0 con job "zenith" -> 127.0.0.1:29090 y rule_files con zenith-alerts.yaml
# Grafana 13.3.1 con el dashboard provisionado (${DS_PROMETHEUS} -> uid del datasource)
```

Con tráfico real (CRUD con master key, 404 de objeto, rutas inexistentes, peticiones sin credenciales, una API key
`test`, jobs sin worker), se comprobó:

- el target sale `up` y las 28 reglas cargan sin error;
- `ZenithMasterKeyUsed` pasa a `firing` al minuto;
- todas las consultas del dashboard se ejecutaron a través de la API de Grafana (`/api/ds/query`):
  - devuelven datos las de HTTP, SLO, burn rate, API keys, master key, 401/429 y el backlog de jobs y webhooks;
  - quedan vacías, como se espera, las de exporters que el laboratorio no tiene (cAdvisor, MongoDB, Vault) y las de
    actividad que no hubo (jobs ejecutados, entregas de webhooks, circuit breakers).

Dos fallos que esta prueba encontró y que ningún test veía:

- El middleware de métricas HTTP **no se llamaba en el servidor**: el SLO, los paneles de latencia y las alertas de
  errores no tenían datos.
- Las peticiones sin credenciales a rutas inventadas creaban una serie por ruta: recibían 401 y no 404, que era lo
  único que se agrupaba.

El CI comprueba en cada ejecución (job `chart`):

- que la copia de las reglas en el chart sea idéntica a la canónica;
- `helm lint` y `helm template` con los valores por defecto y los de producción;
- kubeconform `-strict`, incluidos los CRD con el catálogo de datree;
- `promtool check rules` sobre el archivo canónico y sobre lo renderizado.
