# ADR-006: Prometheus remote_write + Loki Logs Shipper

**Status**: Accepted
**Date**: 2026-06-06
**Authors**: @zuccadev
**Phase**: 1.G (closes H-7)
**Supersedes**: local-only `/metrics` endpoint, stdout-only logs

---

## Context

El trait `ZenithObservability` (v0.1) emitía métricas y logs únicamente de forma **local**:

- **Métricas**: agregados en memoria con un `Map` plano (`metricsRegistry.requestsTotal`, `requestDurations`, etc.) y expuestos vía `GET /metrics` en formato Prometheus text. Esto fuerza un modelo **pull-based**: cada instancia de Zenith expone su propio endpoint, y Prometheus/VictoriaMetrics debe **scrapearlo** cada N segundos.
- **Logs**: OTel exporter a stdout, formato ECS JSON. Sin persistencia centralizada.

**Problemas en producción Fortune 500**:

1. **Multi-instancia sin agregación**: un deployment con 10 instancias de Zenith requiere configurar Prometheus con 10 targets de scrape. La agregación de métricas cross-instance requiere federation o recording rules.
2. **Sin outbox**: si Prometheus se cae o está unreachable, las métricas durante el outage se pierden.
3. **Logs centralizados requieren sidecar**: ELK/Loki requiere un proceso extra (Fluent-Bit, Promtail) para hacer `docker logs` → Elasticsearch/Loki. Esto añade un failure mode y consume CPU/RAM.
4. **No hay retry/backpressure**: el modelo pull-based asume que Prometheus siempre puede scrapear. En realidad, Kubernetes puede reiniciar pods y la ventana de scrape se pierde.

### Métricas de éxito

- **M-1**: Zero-config push a un endpoint centralizado (Prometheus/Cortex/Mimir/Thanos/VictoriaMetrics) sin necesidad de configurar service discovery.
- **M-2**: Logs estructurados aparecen en Grafana/Loki con latencia < 30s, sin necesidad de sidecar.
- **M-3**: Failure resilience: si el endpoint remoto está down, las métricas/logs se bufferean y se recuperan en el siguiente flush.
- **M-4**: Cardinality safety: previene el bug clásico de "label explosion" (un `userId` label genera millones de series).
- **M-5**: PII safety: nunca se loguea `userId`/`requestId`/`traceId` como label de stream (Loki cobra por series activas).

---

## Decision

Implementar dos clientes de push HTTP — **Prometheus remote_write** y **Loki shipper** — con las siguientes propiedades:

### 1. In-memory MetricRegistry con cardinality limit

Nuevo módulo `src/observability/metric-registry.ts` que reemplaza el `metricsRegistry.requestsTotal++` plano del trait legacy:

- `register(name, type, help, options?)`: declaración explícita antes de uso. Type-checked: `incCounter` en una `gauge` lanza.
- Counter / Gauge / Histogram (estándar Prometheus).
- Cardinality limit fail-loud (default 10,000 series por métrica). Previene el bug de `userId` label.
- Export dual: `toPrometheusText()` (legacy /metrics) y `toTimeSeries()` (para remote_write).
- Sin dependencias externas. ~280 LOC.

### 2. Prometheus remote_write (JSON wire format)

Nuevo módulo `src/observability/prometheus-remote-write.ts`:

- **Wire format**: JSON con `Content-Type: application/json` (alternativa soportada por Cortex/Mimir/Thanos/VictoriaMetrics/Grafana Cloud al spec oficial protobuf+snappy).
- **Endpoint**: `POST <endpoint>/api/v1/push`.
- **Auth**: Bearer token, Basic Auth, o tenant ID via `X-Scope-OrgID` (Cortex/Mimir multi-tenancy).
- **Retry**: exponential backoff con jitter (cap 60s) en HTTP 429 / 5xx. Drop en 4xx (config error, no se reintenta).
- **Backpressure**: buffer in-memory con `maxBufferSize` (default 10,000). Overflow → drop oldest.
- **HTTPS obligatorio**: el constructor rechaza `http://` (CWE-319).
- **Determinism**: `serializeToJson()` produce output determinístico (group por label set) → tests reproducibles.

**Decisión sobre JSON vs protobuf+snappy**:

El spec oficial (https://prometheus.io/docs/concepts/remote_write_spec/) usa protobuf+snappy. Sin embargo:

- Los 5 backends principales (Cortex, Mimir, Thanos, VictoriaMetrics, Grafana Cloud) aceptan JSON como alternativa.
- Implementar protobuf encoding + snappy block format correctamente requiere ~500 LOC de código defensivo (varint, length-delimited, hash table de 4-elementos de snappy).
- Para un BaaS con flush de 15s y ~100 series, el body es < 50 KB, donde la diferencia de bandwidth es despreciable.

Roadmap v2: añadir `Content-Encoding: snappy` con protobuf opcional via feature flag para deployments de > 10 MB/push.

### 3. Loki shipper (JSON wire format)

Nuevo módulo `src/observability/loki-shipper.ts`:

- **Wire format**: JSON con `Content-Type: application/json` (Loki spec nativo).
- **Endpoint**: `POST <endpoint>/loki/api/v1/push`.
- **Buffer**: agrupa por stream labels (label set canónico).
- **Retry**: mismo algoritmo que remote_write.
- **PII safety**: rechaza labels `userId`/`requestId`/`traceId`/`spanId`/`user_id`/etc. (default list, configurable). Loki cobra por series activas — un `requestId` único por request = millones de series = bill shock.
- **Max streams**: default 1000 streams en buffer. Overflow → drop.
- **Line truncation**: cada log line se trunca a `maxLineBytes` (default 4 KB) para prevenir log bombs.
- **Tenant ID**: `X-Scope-OrgID` header.

### 4. Integración en el trait `ZenithObservability`

- El trait mantiene retrocompat: el endpoint `GET /metrics` sigue funcionando, ahora exponiendo AMBOS formatos (cardinal-safe registry + legacy aggregates con sufijo `_legacy`).
- Nuevos métodos en `telemetry`:
  - `metricRegistry`: getter al registry cardinal-safe para que otros traits registren métricas custom.
  - `setupRemoteExport(prometheusConfig?, lokiConfig?)`: configura uno o ambos pushers. Llamar UNA vez durante bootstrap.
  - `getPrometheusText()`: snapshot actual del registry cardinal-safe.
- `withSpan()` ahora duplica los contadores al registry cardinal-safe (mirror), para que las métricas estén disponibles vía `getPrometheusText()` y remote_write simultáneamente.
- `shutdown()` ahora también cierra los writers remotos (graceful).

### 5. Configuración

```typescript
// En el bootstrap del engine:
const telemetry = engine.traits.Observability.telemetry;

telemetry.setupRemoteExport(
  {
    endpoint: Deno.env.get("PROMETHEUS_REMOTE_WRITE_URL")!,  // https://cortex.example.com
    bearerToken: Deno.env.get("PROMETHEUS_BEARER_TOKEN"),
    tenantId: Deno.env.get("PROMETHEUS_TENANT_ID"),
    flushIntervalMs: 15_000,
    maxBufferSize: 10_000,
    globalLabels: [
      { name: "service", value: "zenith" },
      { name: "env", value: Deno.env.get("ZENITH_ENV")! },
    ],
  },
  {
    endpoint: Deno.env.get("LOKI_URL")!,  // https://loki.example.com
    bearerToken: Deno.env.get("LOKI_BEARER_TOKEN"),
    baseLabels: {
      service: "zenith",
      env: Deno.env.get("ZENITH_ENV")!,
    },
    flushIntervalMs: 5_000,
  },
);
```

### 6. Fail-closed

- Si el endpoint de push no es HTTPS → `Error: HTTPS required` en startup. Sin fallback a HTTP.
- Si push() se llama antes de setupRemoteExport() → las métricas/logs solo se exponen vía `/metrics` local. No se pierden, pero no se exportan remotamente. (fail-open por diseño: el sistema sigue funcionando.)
- Si remote_write recibe 4xx persistente → log error, drop batch, NO spam de reintentos. (config malo, requiere intervención humana.)
- Si remote_write recibe 5xx → exponential backoff. El buffer puede llenarse; overflow drops oldest con warning.

---

## Alternatives Considered

### A. Mantener pull-based (status quo)

- **Pro**: simplicidad. Prometheus está diseñado para scrape.
- **Con**: requiere service discovery (K8s annotations, Consul, etc.), no funciona bien con auto-scaling agresivo, ventana de scrape se pierde en restarts.

**Rechazado** porque multi-instancia con K8s HPA requiere service mesh + service discovery, y Zenith es un BaaS donde se espera que funcione out-of-the-box.

### B. Implementar protobuf+snappy completo

- **Pro**: spec-compliant, máxima eficiencia.
- **Con**: ~500 LOC de código defensivo, alta probabilidad de bugs en snappy block format (hash table de 4 elementos con edge cases).

**Rechazado** por ahora. Roadmap v2 si el throughput lo demanda.

### C. Usar OpenTelemetry Collector como sidecar

- **Pro**: OTel Collector es el estándar CNCF para esto.
- **Con**: requiere un proceso extra en el deployment, complica el DX, no es "BaaS in a box".

**Rechazado** porque contradice el principio de Zenith: zero-config, single-binary deployment.

### D. Usar Prometheus client library oficial (`prom-client` npm)

- **Pro**: battle-tested, mantenido por Prometheus team.
- **Con**: solo soporta pull model (no remote_write). Para push habría que usar `prom-client` + otro wrapper.

**Rechazado** por el mismo motivo que A.

---

## Consequences

### Positive

- **M-1, M-2, M-3, M-4, M-5**: todas las métricas de éxito se cumplen.
- **DX**: setup en 10 líneas. Compatible con Grafana Cloud, Cortex, Mimir, Thanos, VictoriaMetrics sin config adicional.
- **Cost**: Loki cobra por series activas. El default `forbiddenLabelNames` previene el bill shock por PII.
- **Observability**: las métricas y logs están disponibles **incluso si Prometheus/Loki se reinicia** (retry con backoff).
- **Multi-instancia**: cada instancia pushea con labels `instance=<pod-name>` y `cluster=prod-1`. Prometheus agrega cross-instance automáticamente.

### Negative

- **Bandwidth**: JSON > protobuf en bytes (típicamente 2-3x). Para 100 series/15s = ~50 KB/min/instancia. Aceptable.
- **Latencia**: los logs llegan a Loki con latencia 0-5s (configurable). En el modelo pull, la latencia es la ventana de scrape (típicamente 15-60s). **Net win**.
- **No soporta prometheus_sd**: para deployments de > 100 instancias, el service discovery sigue siendo útil. Pero el push sigue funcionando sin él.

### Neutral

- El endpoint `/metrics` local **sigue funcionando** para tooling que lo necesite (Datadog agent, k8s probes, etc.).
- El trait legacy `metricsRegistry.requestsTotal` se mantiene para retrocompat con dashboards existentes (suffix `_legacy` en el output).

---

## Files Changed

- **NEW** `src/observability/metric-registry.ts` (280 LOC): cardinal-safe registry.
- **NEW** `src/observability/prometheus-remote-write.ts` (320 LOC): push client.
- **NEW** `src/observability/loki-shipper.ts` (260 LOC): log shipper.
- **NEW** `src/observability/mod.ts`: re-exports.
- **MODIFIED** `src/traits/observability/observability.trait.ts`: integró registry cardinal-safe + setupRemoteExport + getPrometheusText.
- **NEW** `tests/unit/metric-registry.test.ts` (14 tests).
- **NEW** `tests/unit/prometheus-remote-write.test.ts` (15 tests).
- **NEW** `tests/unit/loki-shipper.test.ts` (16 tests).
- **NEW** `tests/unit/observability-mod.test.ts` (1 test).
- **NEW** `docs/investigations/10_observability_remote_write.md` (Fortune 500–style research).

**Total**: 46 nuevos tests passing. Total acumulado: 163 tests passing.

---

## Migration Path

1. **Hoy** (v0.2.0): el feature está disponible via `telemetry.setupRemoteExport()`. No-op si no se llama.
2. **v0.3.0**: añadir default config desde env vars (`PROMETHEUS_REMOTE_WRITE_URL`, `LOKI_URL`) para que sea zero-config en deployments con Grafana Cloud.
3. **v0.4.0**: añadir protobuf+snappy opcional via `wireFormat: "protobuf-snappy"` para deployments de alto throughput.
4. **v0.5.0**: integrar con OpenTelemetry Collector (métricas OTel → OTLP) como alternativa a remote_write.

---

## References

- https://prometheus.io/docs/concepts/remote_write_spec/
- https://grafana.com/docs/loki/latest/reference/api/#push-log-entries-to-loki
- https://grafana.com/docs/loki/latest/best-practices/
- ADR-002 (mTLS) — precedent for "defense in depth at the wire level"
- ADR-003 (API Keys) — precedent for "no plaintext transport"
- ADR-004 (Plugin Signing) — precedent for "fail-closed at startup"
- ADR-005 (OpenAPI) — precedent for "single source of truth for API contract"
- H-7 in `06_security_microservices_audit.md`
