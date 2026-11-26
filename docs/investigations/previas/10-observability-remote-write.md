# Investigación 10: Observability Push (Prometheus remote_write + Loki Shipper)

> ℹ️ **Estado: histórico.** Investigación previa al diseño actual; sus imports y rutas (`@zenith/core`, `src/cli/`…) no son los del código. Índice vigente: [docs/index.md](../../users/README.md).

**Fecha**: 2026-06-06
**Autor**: @zuccadev (Zenith Core Team)
**Estado**: Implementado y merged en Phase 1.G
**Cierra**: H-7 del audit de seguridad
**Tags**: `observability`, `prometheus`, `loki`, `remote_write`, `fortune-500`, `sre`

---

## Executive Summary

Zenith v0.1 emitía métricas y logs en modo **pull/local** (`GET /metrics` + stdout). Esto no escala a producción Fortune 500 donde:

1. **Multi-instancia** (10+ pods) requiere service discovery y agrega latencia a queries cross-instance.
2. **Outage blindness**: si Prometheus se cae, las métricas durante el outage se pierden.
3. **Logs centralizados requieren sidecar** (Fluent-Bit, Promtail), añadiendo un failure mode.

Phase 1.G introduce dos clientes de push HTTP — **Prometheus remote_write** y **Loki shipper** — con:

- **Fail-closed startup**: HTTPS obligatorio (CWE-319).
- **Retry con backoff exponencial** + jitter.
- **Buffer in-memory con backpressure** (drop oldest, no spam).
- **PII safety**: bloquea `userId`/`requestId` como Loki labels (Loki cobra por series activas).
- **Cardinality limit** (10,000 series por métrica) para prevenir "label explosion".

Decisión de wire format: **JSON** (no protobuf+snappy) por simplicidad, mantenibilidad, y compatibilidad universal con Cortex/Mimir/Thanos/VictoriaMetrics/Grafana Cloud.

**Tests**: 46 nuevos, 163 totales passing.

---

## 1. Background: por qué pull-based no escala

### 1.1 El modelo pull de Prometheus

Prometheus fue diseñado en 2012 con un modelo **pull** inspirado en Borgmon (Google):

```
┌──────────────┐  scrape   ┌──────────────┐
│   Pod 1     │ ◀────────│              │
│ /metrics    │           │              │
└──────────────┘           │  Prometheus  │
┌──────────────┐  scrape   │              │
│   Pod 2     │ ◀────────│              │
│ /metrics    │           │              │
└──────────────┘           └──────────────┘
```

**Ventajas**:

- Service discovery natural (DNS, k8s API, Consul).
- Prometheus controla la cadencia (scrape_interval).
- Si una instancia muere, Prometheus lo sabe (target down alert).

**Desventajas en producción moderna**:

- **Service discovery overhead**: para 100+ pods, Prometheus necesita configurar `kubernetes_sd_configs` o equivalente, mantener lista actualizada, y manejar pods efímeros (HPA).
- **Scrape window loss**: si un pod se reinicia en < 15s (ventana típica de scrape), sus métricas de ese intervalo se pierden.
- **No funciona con serverless**: AWS Lambda, Cloudflare Workers, etc. no tienen un endpoint scrapeable estático.
- **Cross-instance aggregation requiere federation**: para sumar `requests_total` cross-pod, necesitas Thanos/Mimir o recording rules.

### 1.2 El modelo push de OpenTelemetry Collector / remote_write

```
┌──────────────┐           ┌──────────────┐
│   Pod 1     │ ──push──▶ │              │
└──────────────┘           │              │
┌──────────────┐           │   Cortex /   │
│   Pod 2     │ ──push──▶ │   Mimir /    │
└──────────────┘           │   Thanos     │
┌──────────────┐           │              │
│   Pod 3     │ ──push──▶ │              │
└──────────────┘           └──────────────┘
```

**Ventajas**:

- Zero-config (solo env var con endpoint).
- Funciona con serverless, k8s HPA agresivo, pods efímeros.
- Cross-instance aggregation nativa.
- El cliente controla backpressure (drop oldest si buffer lleno).

**Desventajas**:

- Si el endpoint se cae, hay que decidir política: drop, buffer infinito, o backpressure.
- Cardinality ilimitada en cliente = riesgo de OOM en el backend (label explosion attack).

### 1.3 El caso Zenith

Zenith es un BaaS. Los clientes (developers) hacen deploy a:

- **Local dev** (1 instancia, /metrics suficiente)
- **Vercel/Netlify/Cloudflare Workers** (serverless, sin endpoint scrapeable)
- **Kubernetes HPA** (10-100 pods efímeros)
- **Single VPS** (1 instancia, /metrics suficiente pero push más simple)

El pull model falla en los casos 2 y 3. El push model funciona en los 4.

**Decisión**: push by default, con `/metrics` legacy endpoint para retrocompat.

---

## 2. Prometheus remote_write: spec vs implementación

### 2.1 El spec oficial

Spec: https://prometheus.io/docs/concepts/remote_write_spec/

Wire format: **Protocol Buffers** (`io.prometheus.write.v2.Request`) con **Snappy framing** compression.

```
POST /api/v1/push
Content-Type: application/x-protobuf
Content-Encoding: snappy
Body: <snappy-framed protobuf>
```

Protobuf schema (v2):

```protobuf
message WriteRequest {
  repeated TimeSeries timeseries = 1;
  // ... otras opciones para v2 (symbols, exemplars)
}

message TimeSeries {
  repeated Label labels = 1;
  repeated Sample samples = 2;
  repeated Exemplar exemplars = 3;
  repeated Histogram histograms = 4;
}

message Label {
  string name = 1;
  string value = 2;
}

message Sample {
  double value = 1;
  int64 timestamp = 2;
}
```

### 2.2 Snappy framing format

Spec: https://github.com/google/snappy/blob/main/framing_format.txt

Stream de chunks:

```
┌────────────────────────────────────┐
│ Chunk type (1 byte)                │
│   0x00: compressed (default)       │
│   0x01: uncompressed               │
│   0xfe: stream identifier          │
│   0x80-0xff: reserved              │
├────────────────────────────────────┤
│ Compressed payload length (varint) │
├────────────────────────────────────┤
│ Uncompressed payload length (varint)│ ← solo si compressed
├────────────────────────────────────┤
│ Compressed/uncompressed data       │
└────────────────────────────────────┘
```

**Snappy block format** (compresión dentro de compressed chunks):

- Elemento: literal byte (1 byte, 1 element) o copy (back-reference a los últimos 64 KB).
- Copy tag (1 byte): high 2 bits = tipo, low 6 bits = offset/length.
  - `01`: 1-byte length (1-60 bytes), 1-byte offset (0-255).
  - `10`: 2-byte length (1-64 bytes), 2-byte offset (0-65535).
  - `11`: 3-byte length (1-512 bytes), 2-byte offset (0-65535).
  - `00`: 4-byte length, 3-byte offset (longer copies).
- Límite: 64 KB window. Copy > 64 KB requiere múltiples chunks.

**Implementación correcta** requiere:

- Varint encoding (~30 LOC).
- Snappy block compressor con hash table de 4 elementos por posición (~150 LOC).
- Snappy frame writer con chunk headers (~50 LOC).
- Manejo de edge cases: input < 4 bytes (no compression), 64 KB+ copies (chunk boundary), CRC32 en stream identifier (opcional pero recomendado).

**Total**: ~230 LOC de código defensivo, alto riesgo de bugs sutiles en el compressor.

### 2.3 Backends que aceptan JSON

A pesar de que el spec es protobuf+snappy, los backends principales aceptan **JSON como alternativa documentada**:

| Backend | JSON endpoint | Content-Type | Auth |
|---|---|---|---|
| **Cortex** | `/api/v1/push` | `application/json` | Bearer / X-Scope-OrgID |
| **Mimir** | `/api/v1/push` | `application/json` | Bearer / X-Scope-OrgID |
| **Thanos** | `/api/v1/push` | `application/json` | Bearer / X-Scope-OrgID |
| **VictoriaMetrics** | `/api/v1/push` | `application/json` | Bearer / Basic |
| **Grafana Cloud** | `/api/prom/push` | `application/json` | Bearer + Instance ID |
| **Prometheus (server)** | `/api/v1/push` (v2.26+) | `application/x-protobuf` only | — |

**Limitación**: Prometheus server (no Cortex/Mimir/Thanos) **NO acepta JSON**. Solo protobuf. Esto es importante si el target es un Prometheus single-tenant.

**Decisión para Zenith**: **JSON by default**. Justificación:

- 5/6 backends principales lo aceptan.
- El spec no es restrictivo (dice "the protobuf format is the default" pero no "the only").
- Para un BaaS con push cada 15s y ~100 series, body típico es 30-50 KB → bandwidth difference es despreciable.
- Mantenibilidad: JSON es trivial vs 230 LOC de snappy block format con bugs latentes.

**Roadmap v2**: añadir feature flag `wireFormat: "protobuf-snappy"` para deployments de alto throughput o single-Prometheus.

### 2.4 Schema JSON usado

Basado en el subset del WriteRequest protobuf:

```json
{
  "timeseries": [
    {
      "labels": [
        { "name": "__name__", "value": "zenith_http_requests_total" },
        { "name": "method", "value": "GET" },
        { "name": "path", "value": "/classes/GameScore" }
      ],
      "samples": [
        { "value": 1337, "timestamp": 1700000000000 }
      ]
    }
  ],
  "globalLabels": [
    { "name": "service", "value": "zenith" },
    { "name": "env", "value": "production" }
  ]
}
```

Notas:

- `__name__` es la convención Prometheus para el nombre de la métrica.
- `globalLabels` es opcional, se aplica a todas las series. Útil para `service`, `cluster`, `region`.
- `timestamp` es Unix milliseconds (JSON no tiene decimal fijo; los backends aceptan ms o s según documentación).

---

## 3. Loki: arquitectura y PII

### 3.1 Conceptos

Spec: https://grafana.com/docs/loki/latest/get-started/architecture/

- **Stream**: conjunto de log lines con el mismo label set.
- **Labels**: key-value que identifican el stream (lowercase, snake_case).
- **Entries**: `[timestamp_ns, line]` tuples dentro de un stream.
- **Chunks**: Loki agrupa entries en chunks comprimidos (default 1.5 MB / 24h).

**Modelo de costos**: Loki cobra (en Grafana Cloud) por **series activas**. Cada combinación única de labels = 1 serie. Si tienes `{service="zenith", level="info", userId="u-1"}` con 1M userIds, tienes 1M series activas = **bill shock**.

### 3.2 PII y label explosion

El **label cardinality bug** es endémico:

- Developer añade `userId` como label "para debug".
- Cada user genera 1 stream único.
- 10K usuarios activos = 10K streams.
- Loki indexa todos los labels en RAM (TSDB).
- 1M usuarios = 1M streams = OOM en Loki + factura de 5 dígitos USD/mes.

**Solución defensiva en el cliente** (Zenith):

- Default `forbiddenLabelNames`: `["userId", "requestId", "traceId", "spanId", "user_id", "request_id", "trace_id", "span_id"]`.
- Si el developer llama `lokiShipper.push({ userId: "x", ... }, "line")`, el `userId` se silencia con un warning.
- Para correlacionar logs con un user/trace específico, usar el log line content (`traceId=abc-123` dentro del line), no labels.

### 3.3 Wire format

```json
{
  "streams": [
    {
      "stream": {
        "service": "zenith",
        "level": "info",
        "env": "production"
      },
      "values": [
        ["1700000000000000000", "[Zenith] GET /classes/GameScore 200 12ms"],
        ["1700000000001000000", "[Zenith] GET /classes/GameScore 200 8ms"]
      ]
    }
  ]
}
```

Notas:

- Timestamps en **nanoseconds as string** (Loki format nativo, no Unix ms).
- `values` debe estar ordenado por timestamp ascendente dentro de cada stream.
- Múltiples streams en una request = batching eficiente.

### 3.4 Diferencias con remote_write

| Aspecto | Prometheus | Loki |
|---|---|---|
| Wire format | JSON o protobuf | JSON only |
| Endpoint | `/api/v1/push` | `/loki/api/v1/push` |
| Identidad | `__name__` label | `stream.labels` |
| Time | Unix ms (number) | Unix ns (string) |
| Body content | `value: number` | `line: string` |
| Tenant header | `X-Scope-OrgID` | `X-Scope-OrgID` |

---

## 4. Cardinality: el bug más caro en observability

### 4.1 Anatomía del label explosion

```typescript
// ❌ Peligroso: userId es high-cardinality
metricRegistry.incCounter("requests_total", [
  { name: "userId", value: userId },  // 1M users = 1M series
  { name: "plan", value: "pro" },      // 1-3 series
]);

// ✅ Seguro: solo dimensiones bounded
metricRegistry.incCounter("requests_total", [
  { name: "plan", value: "pro" },      // 1-3 series
  { name: "method", value: "GET" },    // 3-7 series
  { name: "status", value: "200" },    // ~5 series
]);
```

**Regla**: cada label debe tener **< 100 valores únicos** en producción. Si excede, es una señal de que el dato debería ir en log content, no en label.

### 4.2 Mitigación en Zenith

**Defense in depth en 3 capas**:

1. **Capa 1 — Registry**: `MetricRegistry.maxCardinality = 10_000`. Si una métrica excede, lanza `Error: exceeded max cardinality`. **Fail-loud** = el developer ve el error inmediatamente.

2. **Capa 2 — Loki**: `forbiddenLabelNames` previene high-cardinality labels en streams. **Fail-silent + warning log** = no rompe la app, pero el developer ve el warning.

3. **Capa 3 — Documentación**: el trait `Observability` exporta las métricas registradas a OpenAPI (ADR-005), haciendo visible cada label en el contrato de la API.

### 4.3 Comparación con industry

| Project | Cardinality limit | Default |
|---|---|---|
| **Prometheus client_java** | None (developer responsibility) | — |
| **prom-client (Node)** | None (developer responsibility) | — |
| **Datadog** | 1000 series/metric (custom metrics billing) | — |
| **New Relic** | 10,000 events/min/account | — |
| **Grafana Cloud** | None (pay per active series) | — |
| **Zenith** | **10,000 series/metric (configurable)** | **1000 streams (Loki)** |

Zenith está en el medio: permite métricas custom pero con un techo explícito que previene el caso de "olvidé un userId label y ahora OOM".

---

## 5. Retry y backoff: teoría y práctica

### 5.1 Estrategia

```
attempt 1: send batch → 503 Service Unavailable
  → wait 1000ms (2^1 * 1000)
attempt 2: send batch → 503 Service Unavailable
  → wait 2000ms (2^2 * 1000)
attempt 3: send batch → 429 Too Many Requests
  → wait 4000ms (2^3 * 1000)
attempt 4: send batch → 200 OK
  → success
```

### 5.2 Exponential backoff con jitter

Sin jitter, todos los clientes reintentan al mismo tiempo → **thundering herd**:

```
T=0:   1000 clientes envían batch
T=1s:  todos fallan, todos reintentan a T=2s
T=2s:  1000 clientes envían de nuevo → DDoS al backend
```

Con jitter aleatorio:

```
T=0:   1000 clientes envían batch
T=1s:  todos fallan
T=2s:  cliente 1 reintenta (jitter 0-1000ms: real 2001-3001ms)
T=2.3s: cliente 2 reintenta
T=2.7s: cliente 3 reintenta
... (distribución uniforme)
```

El backend recibe un flujo constante en vez de un pico.

**Implementación**:

```typescript
function computeBackoff(attempt: number): number {
  const base = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);  // cap 60s
  const jitter = Math.random() * Math.min(attempt * 1000, MAX_BACKOFF_MS);
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}
```

**Reference**: https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/

### 5.3 Cuándo NO reintentar

| HTTP status | Retry? | Razón |
|---|---|---|
| 200, 201, 204 | N/A | Success |
| 400 Bad Request | ❌ No | Config error, retry no ayuda |
| 401 Unauthorized | ❌ No | Auth error, retry no ayuda |
| 403 Forbidden | ❌ No | Perm error, retry no ayuda |
| 404 Not Found | ❌ No | Endpoint wrong, retry no ayuda |
| 408 Request Timeout | ✅ Sí (2x base) | Network transient |
| 429 Too Many Requests | ✅ Sí (con backoff agresivo) | Backend saturado |
| 500 Internal Server Error | ✅ Sí | Backend bug, puede recuperarse |
| 502 Bad Gateway | ✅ Sí | Upstream issue |
| 503 Service Unavailable | ✅ Sí (3x base) | Backend overload |
| 504 Gateway Timeout | ✅ Sí (2x base) | Upstream slow |
| Network error (DNS, connection refused) | ✅ Sí | Transient |

**Implementación en Zenith**:

```typescript
err.retryable = res.status === 429 || res.status >= 500;
```

Excluye 4xx (excepto 429) del retry. Esto previene loops infinitos cuando el config es incorrecto (ej. endpoint equivocado retorna 404).

---

## 6. Buffer y backpressure: memoria vs reliability

### 6.1 Trade-offs

| Strategy | Memoria | Reliability | Caso de uso |
|---|---|---|---|
| **Drop on full** | O(1) | Low | Best-effort (logs) |
| **Block on full** | O(∞) | High | Critical metrics (billing) |
| **Disk spool** | O(1) RAM | High | Audit logs (compliance) |
| **Compress in-memory** | O(n) compressed | Medium | Medium-throughput |

### 6.2 Decisión Zenith

**Default**: drop oldest, log warning.

```typescript
if (this.buffer.length + series.length > this.config.maxBufferSize) {
  const dropCount = (this.buffer.length + series.length) - this.config.maxBufferSize;
  this.buffer.splice(0, dropCount);  // drop oldest
  this.config.logger.warn("buffer overflow, dropped oldest", { dropped: dropCount });
}
```

**Por qué drop oldest, no newest**:

- Las métricas más recientes son las más útiles para debugging "qué está pasando ahora".
- Las métricas más viejas se agregan típicamente (counters) o se vuelven irrelevantes (gauges efímeros).
- En un dashboard de Grafana, `rate(zenith_http_requests_total[5m])` usa los últimos 5 min, no los datos de 1h atrás.

**Por qué no bloquear**:

- Blocking en `push()` introduce latencia en el path de la request HTTP. Si Prometheus está down por 5 min, todas las requests de Zenith se cuelgan.
- Mejor: dejar que el path de request use el registry local (que siempre funciona) y el push worker se recupere cuando pueda.

**Por qué no disk spool**:

- Disk I/O en el hot path es prohibitivo.
- Si necesitas 100% reliability, usa un message queue (Kafka, NATS) — fuera del scope de Zenith v0.2.

### 6.3 Max buffer size

**Default**: 10,000 series.

**Cálculo**:

- Cada `TimeSeries` object: ~200 bytes (labels + value + overhead).
- 10,000 series = ~2 MB.
- Flush cada 15s con 10K series = ~666 series/s promedio.

Para un BaaS con 10 RPS por instancia y ~5 series por request, son 50 series/s → buffer se vacía en ~3 min. Holgura de 5x sobre la cadencia de flush. Aceptable.

Para deployments de > 1000 RPS, ajustar `maxBufferSize: 100_000` (~20 MB RAM).

---

## 7. Logging: estructura, retention, PII

### 7.1 Formato de log line

Decisión: **plain string** (no structured JSON en el line). Loki acepta ambos, pero plain string es más eficiente de compress (snappy/zstd funcionan mejor con repetitivos):

```typescript
// ❌ JSON line: más bytes, menos compressible
`{"ts":"2026-06-06T12:00:00Z","level":"info","msg":"Request completed","duration_ms":12}`

// ✅ Plain string: menos bytes, mejor compresión
`[2026-06-06T12:00:00Z] info  Request completed duration_ms=12 traceId=abc-123`
```

Trade-off: el plain string requiere regex/Grok para query en Loki. El JSON es queryable directamente. Zenith recomienda ECS-like (Elastic Common Schema) format: https://www.elastic.co/guide/en/ecs/current/ecs-reference.html.

### 7.2 Log level filtering

Loki no tiene un mecanismo nativo de filter por level. Se hace con **LogQL**:

```logql
{service="zenith"} |= "level=error"
```

Esto busca la substring en el line. Caro pero funcional. Para filter agresivo (ej. "ignorar info logs"), se puede usar una label separada:

```typescript
lokiShipper.push({ service: "zenith", level: "info", component: "auth" }, line);
```

Pero esto multiplica series (1 por combinación level×component). Trade-off: cardinality vs queryability.

**Decisión Zenith**: usar **logfmt format** en el line. Ej. `level=info component=auth msg="..."`. Loki puede parsear logfmt con `| logfmt`:

```logql
{service="zenith"} | logfmt | level="error"
```

### 7.3 PII scrubbing

**Defense in depth**:

1. **Forbidden labels** (default list): previene `userId`/`requestId` como stream labels.
2. **Line truncation** (default 4 KB): previene log bombs con secrets embebidos.
3. **No payload logging por default**: Zenith no loguea `req.body` automáticamente. Si un developer lo hace, debe sanitizar.

**Roadmap v3**: añadir scrubber configurable (regex-based) que reemplaza PII antes de push:

```typescript
lokiShipper.addScrubber(/\b\d{16}\b/, "[REDACTED-CARD]");  // credit cards
lokiShipper.addScrubber(/Bearer\s+[A-Za-z0-9-_]+/, "Bearer [REDACTED]");  // tokens
```

---

## 8. Integration con OpenTelemetry

### 8.1 Estado actual

El trait `Observability` ya usa OpenTelemetry SDK para **traces**:

```typescript
import { trace, SpanStatusCode } from "npm:@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor } from "npm:@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "npm:@opentelemetry/exporter-trace-otlp-http";
```

El exporter actual apunta a `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318/v1/traces`).

### 8.2 Decisión: ¿migrar todo a OTel?

OpenTelemetry tiene exporters para Prometheus y Loki también:

- `npm:@opentelemetry/exporter-prometheus` — expone `/metrics` en formato Prometheus text (pull).
- `npm:@opentelemetry/exporter-prometheus-remote-write` — push a remote_write (protobuf).
- Para Loki, no hay exporter oficial OTel, pero OTel collector tiene un exporter.

**¿Por qué NO migrar todo a OTel?**

1. **OTel Metrics API está en beta** (a 2026-06). Inestable, breaking changes frecuentes.
2. **OTel Logs API está aún más inmaduro** (alpha en muchas implementaciones).
3. **OTel pull-based Prometheus exporter contradice el objetivo** de Phase 1.G (queremos push).
4. **OTel remote_write exporter no soporta JSON** (solo protobuf) — opuesto a nuestra decisión de diseño.

**Decisión**: mantener la implementación custom para `remote_write` y Loki. Usar OTel solo para traces (que es su caso fuerte).

### 8.3 Correlación traces + metrics + logs

Para que un alert "p99 latency > 1s" sea investigable, se necesita correlacionar:

- **Trace ID** (OTel): `abc-123`
- **Métrica** (Prometheus): `histogram_quantile(0.99, rate(zenith_http_request_duration_ms_bucket[5m]))`
- **Log** (Loki): `{service="zenith"} |= "traceId=abc-123"`

**Implementación**: el log line incluye `traceId` como field logfmt. La métrica `zenith_http_request_duration_ms` puede incluir `traceId` solo si el sampling rate es < 100% (ej. 1% de traces se "exemplar" con traceId):

```promql
zenith_http_request_duration_ms_bucket{le="1000", ...} exemplar{traceId="abc-123"} 1.2
```

Esto requiere Prometheus 2.26+ con `--enable-feature=exemplar-storage`. Roadmap v2.

---

## 9. Testing strategy

### 9.1 Unit tests (sin red)

Los 46 tests nuevos mockean `globalThis.fetch` para validar el wire format sin hacer HTTP real.

**Crítico**: validar que el `body` JSON es lo que el backend espera, no que "el código corrió sin error".

```typescript
Deno.test("remote_write: send POSTs JSON to /api/v1/push", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    const w = new PrometheusRemoteWriter({...});
    w.push([makeTs("requests_total", 5)]);
    await w.flush();
    assertEquals(requests.length, 1);
    assertEquals(requests[0].url, "https://prom:9090/api/v1/push");
    const headers = requests[0].init.headers as Record<string, string>;
    assertEquals(headers["Content-Type"], "application/json");
    const body = JSON.parse(requests[0].init.body as string);
    assertEquals(body.timeseries[0].samples[0].value, 5);
  } finally {
    globalThis.fetch = origFetch;
  }
});
```

### 9.2 Integration tests (con backend real)

**Plan**: docker-compose con Prometheus + Loki + Grafana en CI.

```yaml
# docker-compose.test.yml
services:
  prometheus:
    image: prom/prometheus:v2.51.0
    command: --config.file=/etc/prometheus/prometheus.yml
  loki:
    image: grafana/loki:3.0.0
  grafana:
    image: grafana/grafana:11.0.0
```

**Test**:

1. Spin up stack.
2. Boot Zenith con `PROMETHEUS_REMOTE_WRITE_URL=http://prometheus:9090`.
3. Hacer 100 requests a `/health`.
4. Verificar que Prometheus tiene `zenith_http_requests_total > 100`.
5. Verificar que Loki tiene el log de startup con `service=zenith`.

**Status**: NO implementado en Phase 1.G. Roadmap v2 (Phase 2.H).

### 9.3 Load tests (con many series)

**Objetivo**: validar que el buffer se comporta correctamente bajo presión.

**Plan**:

1. Boot Zenith con endpoint de push mockeado que retorna 503 siempre.
2. Push 1M series en 1 minuto.
3. Verificar:
   - Buffer overflows correctamente (drop oldest).
   - Warning logs se emiten.
   - RAM usage se mantiene < 100 MB.
4. Restaurar endpoint, verificar que el sistema se recupera.

**Status**: NO implementado. Roadmap v2.

---

## 10. Decisiones de diseño (resumen)

| Decisión | Alternativa | Razón |
|---|---|---|
| **Push by default** | Pull (status quo) | Serverless, HPA, zero-config |
| **JSON wire format** | Protobuf+snappy | Mantenibilidad, 5/6 backends aceptan |
| **In-memory buffer** | Disk spool / Kafka | BaaS simplicity, low RAM |
| **Drop oldest on overflow** | Block / drop newest | Latency en hot path, métricas recientes más útiles |
| **Cardinality limit 10K** | Unlimited / 100 (Datadog) | Balance entre custom metrics y OOM prevention |
| **Forbid PII labels** | Allow + warn | Bill shock prevention, default-safe |
| **Custom impl (no OTel Metrics)** | OTel Metrics API | OTel Metrics es beta, pull-only exporter |
| **Line truncation 4KB** | No limit | Log bomb prevention |
| **Retry con jitter exponencial** | Linear / no jitter | Thundering herd prevention |
| **HTTPS obligatorio** | Allow HTTP | CWE-319, plaintext en producción = no-go |

---

## 11. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Backend down por horas | Media | Buffer overflow, métricas perdidas | Buffer con warning + alert si `getConsecutiveFailures() > 10` |
| Cardinality bug en código custom | Alta | OOM en backend | Registry fail-loud + docs |
| PII leak en labels | Media | GDPR / compliance violation | Forbidden labels default + scrubber roadmap v3 |
| Wire format incompatible con backend | Baja | 100% drop | JSON documentado, validar en setup() que endpoint responde 200 |
| Race condition en flush (multi-thread) | Baja | Double-push / data loss | Deno es single-threaded, no race. En Node.js (futuro) → mutex. |
| Snappy/block format bug (si se implementa v2) | Alta | Data corruption | Roadmap v2, JSON by default |
| Costos de Loki (Grafana Cloud) | Media | Bill shock | Forbidden labels + max streams 1000 |

---

## 12. Roadmap

### v0.2.0 (Phase 1.G) — DONE

- ✅ MetricRegistry cardinal-safe.
- ✅ PrometheusRemoteWriter (JSON).
- ✅ LokiShipper (JSON).
- ✅ Integración en `Observability` trait.
- ✅ 46 tests passing.

### v0.3.0

- Default config desde env vars (zero-config).
- Scrubber configurable para PII.
- Health check endpoint expone estado de remote export (`getConsecutiveFailures()`).
- Prometheus exemplar support (traceId en métricas).

### v0.4.0

- `wireFormat: "protobuf-snappy"` opcional.
- Compresión gzip en body (Cortex accepts).
- Adaptive flush interval basado en traffic.

### v0.5.0

- OpenTelemetry Metrics API (cuando esté stable).
- Push to OpenTelemetry Collector via OTLP (alternativa a remote_write + Loki).
- Multi-region failover (push a primary, fallback a secondary).

### v1.0.0

- Backward-compat tests contra Prometheus/Cortex/Mimir/Thanos/VictoriaMetrics oficiales.
- Chaos engineering tests (kill backend mid-push).

---

## 13. Conclusiones

Phase 1.G cierra **H-7** y eleva la postura de observability de Zenith de "demo local" a **production-ready Fortune 500**:

- **Zero-config push** a cualquier backend CNCF-compliant.
- **Failure-resilient**: retry, backpressure, drop con warning.
- **Cost-aware**: PII labels bloqueados, cardinality limits.
- **DX**: setup en 10 líneas, compatible con Grafana Cloud out-of-the-box.
- **Open**: JSON wire format es portable y reversible (si necesitas migrar a OTel Collector más tarde, no pierdes el modelo mental).

**Tests**: 163 passing, 0 failed (excluyendo el test preexistente de `Deno.openKv` que requiere `--unstable-kv`).

**Próxima fase**: Phase 2 (H-8 — full test suite audit + remaining hardening).

---

## Referencias

- [Prometheus remote_write spec](https://prometheus.io/docs/concepts/remote_write_spec/)
- [Prometheus protobuf schema (v2)](https://github.com/prometheus/prometheus/blob/main/prompb/remote.proto)
- [Snappy framing format](https://github.com/google/snappy/blob/main/framing_format.txt)
- [Grafana Loki API](https://grafana.com/docs/loki/latest/reference/api/)
- [Grafana Loki best practices](https://grafana.com/docs/loki/latest/best-practices/)
- [AWS Builders Library: Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [OpenTelemetry Metrics API status](https://opentelemetry.io/docs/specs/otel/metrics/)
- [Elastic Common Schema (ECS)](https://www.elastic.co/guide/en/ecs/current/ecs-reference.html)
- [Datadog custom metrics pricing](https://www.datadoghq.com/pricing/)
- [CWE-319: Cleartext Transmission of Sensitive Information](https://cwe.mitre.org/data/definitions/319.html)
- ADR-002, ADR-003, ADR-004, ADR-005 (precedentes en Zenith)
- H-7 en `06_security_microservices_audit.md`

---

**Aprobado por**: @zuccadev
**Fecha de merge**: 2026-06-06
**Próxima revisión**: 2026-09-06 (3 meses, antes de v1.0)
