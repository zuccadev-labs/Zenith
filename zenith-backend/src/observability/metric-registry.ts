/**
 * @module @zenith/observability/metric-registry
 *
 * In-memory registry de métricas con retención y exportación Prometheus-compatible.
 *
 * Características:
 *   - Counter, Gauge, Histogram (estándar Prometheus).
 *   - Labels con cardinalidad limitada (fail-loud si excede).
 *   - Thread-safe single-writer (asume single-threaded Deno).
 *   - Export a text format (legacy /metrics endpoint) y a
 *     TimeSeries[] (para remote_write).
 *
 * Cardinalidad: el límite `maxCardinality` previene el bug clásico de
 * Prometheus de "label explosion" donde un label con valores únicos
 * (ej. `userId`) genera millones de series. Default: 10,000 series
 * por métrica. Configurable.
 */

export type MetricType = "counter" | "gauge" | "histogram";

export interface Label {
  readonly name: string;
  readonly value: string;
}

export interface MetricSample {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly unit?: string;
  readonly labels: readonly Label[];
  /** Counter/gauge: single value. Histogram: buckets + sum + count. */
  readonly value: number;
  /** Solo histogram. */
  readonly buckets?: HistogramBucket[];
  /** Solo histogram. */
  readonly sum?: number;
  /** Solo histogram. */
  readonly count?: number;
}

export interface HistogramBucket {
  /** Upper bound inclusivo (le). `+Inf` se representa como `Number.POSITIVE_INFINITY`. */
  readonly le: number;
  /** Count acumulado de samples con value <= le. */
  readonly count: number;
}

/** Una métrica registrada. */
interface MetricDescriptor {
  name: string;
  type: MetricType;
  help: string;
  unit?: string;
  /** Key: label values joined con `\x00`. Value: Sample state. */
  series: Map<string, SeriesState>;
}

interface SeriesState {
  labels: readonly Label[];
  /** Counter/gauge: number. Histogram: { sum, count, buckets: Map<le, count> }. */
  state: number | HistogramState;
}

interface HistogramState {
  sum: number;
  count: number;
  /** Map de `le` (como string para que +Inf sea distinguible) → count. */
  buckets: Map<string, number>;
}

export interface RegistryOptions {
  /** Max series por métrica. Default: 10000. */
  maxCardinality?: number;
  /** Buckets default para histogramas (en ms). */
  defaultHistogramBuckets?: readonly number[];
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const RESERVED_LABEL_NAMES = new Set([
  "__name__", // Prometheus internal
  "job",
  "instance",
]);

/** Registry principal. */
export class MetricRegistry {
  private readonly metrics = new Map<string, MetricDescriptor>();
  private readonly maxCardinality: number;
  private readonly defaultBuckets: readonly number[];

  constructor(options: RegistryOptions = {}) {
    this.maxCardinality = options.maxCardinality ?? 10_000;
    this.defaultBuckets = options.defaultHistogramBuckets ?? DEFAULT_BUCKETS;
  }

  /** Registra una métrica nueva. Lanza si ya existe. */
  register(
    name: string,
    type: MetricType,
    help: string,
    options: { unit?: string } = {},
  ): void {
    if (this.metrics.has(name)) {
      throw new Error(`Metric already registered: ${name}`);
    }
    validateMetricName(name);
    this.metrics.set(name, {
      name,
      type,
      help,
      unit: options.unit,
      series: new Map(),
    });
  }

  /** Counter: incrementa en `value` (default 1). No permite decrement. */
  incCounter(name: string, labels: readonly Label[] = [], value = 1): void {
    const m = this.getOrThrow(name, "counter");
    const key = labelKey(labels);
    const existing = m.series.get(key);
    if (existing) {
      (existing.state as number) += value;
    } else {
      this.assertCardinality(m);
      m.series.set(key, { labels, state: value });
    }
  }

  /** Gauge: setea valor absoluto. */
  setGauge(name: string, value: number, labels: readonly Label[] = []): void {
    const m = this.getOrThrow(name, "gauge");
    const key = labelKey(labels);
    const existing = m.series.get(key);
    if (existing) {
      (existing.state as number) = value;
    } else {
      this.assertCardinality(m);
      m.series.set(key, { labels, state: value });
    }
  }

  /** Gauge: incrementa (puede ser negativo). */
  incGauge(name: string, value: number, labels: readonly Label[] = []): void {
    const m = this.getOrThrow(name, "gauge");
    const key = labelKey(labels);
    const existing = m.series.get(key);
    if (existing) {
      (existing.state as number) += value;
    } else {
      this.assertCardinality(m);
      m.series.set(key, { labels, state: value });
    }
  }

  /** Histogram: observa un value. Default buckets del registry. */
  observeHistogram(
    name: string,
    value: number,
    labels: readonly Label[] = [],
    buckets?: readonly number[],
  ): void {
    const m = this.getOrThrow(name, "histogram");
    const key = labelKey(labels);
    const useBuckets = buckets ?? this.defaultBuckets;
    let state: HistogramState;
    const existing = m.series.get(key);
    if (existing) {
      state = existing.state as HistogramState;
    } else {
      this.assertCardinality(m);
      state = {
        sum: 0,
        count: 0,
        buckets: new Map(useBuckets.map((le) => [String(le), 0] as const)),
      };
      m.series.set(key, { labels, state });
    }
    state.sum += value;
    state.count += 1;
    for (const le of useBuckets) {
      if (value <= le) {
        const k = String(le);
        state.buckets.set(k, (state.buckets.get(k) ?? 0) + 1);
      }
    }
  }

  /** Export todas las samples en formato Prometheus text (legacy /metrics). */
  toPrometheusText(): string {
    const out: string[] = [];
    for (const m of this.metrics.values()) {
      out.push(`# HELP ${m.name} ${m.help}`);
      out.push(`# TYPE ${m.name} ${m.type}`);
      if (m.unit) out.push(`# UNIT ${m.name} ${m.unit}`);
      for (const series of m.series.values()) {
        const labelStr = formatLabels(series.labels);
        if (m.type === "histogram") {
          const s = series.state as HistogramState;
          for (const [leStr, count] of s.buckets) {
            const le = leStr === "Infinity" ? "+Inf" : leStr;
            out.push(`${m.name}_bucket{${labelStr}le="${le}"} ${count}`);
          }
          out.push(`${m.name}_bucket{${labelStr}le="+Inf"} ${s.count}`);
          out.push(`${m.name}_sum{${labelStr}} ${s.sum}`);
          out.push(`${m.name}_count{${labelStr}} ${s.count}`);
        } else {
          out.push(`${m.name}{${labelStr}} ${series.state}`);
        }
      }
    }
    return out.join("\n") + "\n";
  }

  /** Export todas las samples como array de TimeSeries (para remote_write). */
  toTimeSeries(globalLabels: readonly Label[] = []): TimeSeries[] {
    const result: TimeSeries[] = [];
    for (const m of this.metrics.values()) {
      if (m.type === "histogram") {
        for (const series of m.series.values()) {
          const s = series.state as HistogramState;
          for (const [leStr, count] of s.buckets) {
            const le = leStr === "Infinity" ? Number.POSITIVE_INFINITY : Number(leStr);
            result.push({
              labels: [{ name: "__name__", value: `${m.name}_bucket` }, ...globalLabels, ...series.labels, { name: "le", value: formatLe(le) }],
              value: count,
            });
          }
          result.push({
            labels: [{ name: "__name__", value: `${m.name}_bucket` }, ...globalLabels, ...series.labels, { name: "le", value: "+Inf" }],
            value: s.count,
          });
          result.push({
            labels: [{ name: "__name__", value: `${m.name}_sum` }, ...globalLabels, ...series.labels],
            value: s.sum,
          });
          result.push({
            labels: [{ name: "__name__", value: `${m.name}_count` }, ...globalLabels, ...series.labels],
            value: s.count,
          });
        }
      } else {
        for (const series of m.series.values()) {
          result.push({
            labels: [{ name: "__name__", value: m.name }, ...globalLabels, ...series.labels],
            value: series.state as number,
          });
        }
      }
    }
    return result;
  }

  /** Resetea todos los valores (útil para tests). */
  reset(): void {
    for (const m of this.metrics.values()) {
      m.series.clear();
    }
  }

  /** Lista de métricas registradas. */
  list(): Array<{ name: string; type: MetricType; help: string; seriesCount: number }> {
    return [...this.metrics.values()].map((m) => ({
      name: m.name,
      type: m.type,
      help: m.help,
      seriesCount: m.series.size,
    }));
  }

  private getOrThrow(name: string, expected: MetricType): MetricDescriptor {
    const m = this.metrics.get(name);
    if (!m) {
      throw new Error(`Metric not registered: ${name}. Call register() first.`);
    }
    if (m.type !== expected) {
      throw new Error(`Metric ${name} is type ${m.type}, expected ${expected}`);
    }
    return m;
  }

  private assertCardinality(m: MetricDescriptor): void {
    if (m.series.size >= this.maxCardinality) {
      throw new Error(
        `Metric ${m.name} exceeded max cardinality (${this.maxCardinality}). ` +
          `Likely cause: a label with high-cardinality values (e.g. userId, requestId).`,
      );
    }
  }
}

// ── TimeSeries shape (compatible con Prometheus remote_write protobuf) ──

export interface TimeSeries {
  labels: readonly Label[];
  value: number;
  /** Unix ms. Default: Date.now() en el exporter. */
  timestamp?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function validateMetricName(name: string): void {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
    throw new Error(`Invalid metric name: ${name}. Use [a-zA-Z_:][a-zA-Z0-9_:]*.`);
  }
}

function validateLabelName(name: string): void {
  if (RESERVED_LABEL_NAMES.has(name)) {
    throw new Error(`Reserved label name: ${name}`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid label name: ${name}. Use [a-zA-Z_][a-zA-Z0-9_]*.`);
  }
}

export function labelKey(labels: readonly Label[]): string {
  return labels.map((l) => `${l.name}=${l.value}`).join("\x00");
}

function formatLabels(labels: readonly Label[]): string {
  if (labels.length === 0) return "";
  return labels.map((l) => `${l.name}="${escapeLabelValue(l.value)}"`).join(",") + ",";
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLe(le: number): string {
  if (le === Number.POSITIVE_INFINITY) return "+Inf";
  if (Number.isInteger(le)) return String(le);
  return String(le);
}

export { validateLabelName };
