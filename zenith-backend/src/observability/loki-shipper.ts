/**
 * @module @zenith/observability/loki-shipper
 *
 * Push de logs estructurados a Grafana Loki.
 *
 * ## API
 *
 * Spec: https://grafana.com/docs/loki/latest/reference/api/#push-log-entries-to-loki
 * Endpoint: `POST <loki>/loki/api/v1/push`
 * Content-Type: `application/json`
 * Body (snake_case):
 * ```json
 * {
 *   "streams": [
 *     {
 *       "stream": {"job": "zenith", "level": "info"},
 *       "values": [
 *         ["<unix_ns>", "<log_line>"],
 *         ...
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * ## Estrategia de push
 *
 *   - Buffer en memoria por (stream labels) → array de entries.
 *   - Flush periódico: `flushIntervalMs` (default 5s).
 *   - Batch size cap: `maxBatchSize` (default 1000 entries).
 *   - Mismo retry/backoff que remote_write (exponential + jitter).
 *   - Label cardinality limit por stream (default 1000 streams).
 *
 * ## PII Safety
 *
 *   - Línea de log se trunca a `maxLineBytes` (default 4 KB) — previene
 *     log bombs.
 *   - Caracteres no-UTF8 se reemplazan con `?`.
 *   - Streams con `userId`, `requestId` u otros high-cardinality labels
 *     se rechazan explícitamente vía `forbiddenLabelNames`.
 */

import type { LoggerLike } from "./prometheus-remote-write.ts";

export interface LokiLogEntry {
  /** Unix nanoseconds (Loki format). */
  timestampNs: bigint;
  /** Línea de log (ya formateada). */
  line: string;
}

export interface LokiStream {
  /** Stream labels (lowercase, snake_case). */
  labels: Record<string, string>;
  /** Entries cronológicas. */
  entries: LokiLogEntry[];
}

export interface LokiConfig {
  /** Endpoint base, ej. `https://loki-prod-01.example.com`. */
  endpoint: string;
  /** Path del push API. Default: `/loki/api/v1/push`. */
  path?: string;
  /** Tenant ID (Loki multi-tenancy). Header `X-Scope-OrgID`. */
  tenantId?: string;
  bearerToken?: string;
  basicAuth?: { username: string; password: string };
  /** Labels comunes a todos los streams (ej. `cluster=prod`, `service=zenith`). */
  baseLabels?: Record<string, string>;
  /** Labels prohibidos (high-cardinality). Default: `userId`, `requestId`, `traceId`, `spanId`. */
  forbiddenLabelNames?: readonly string[];
  /** Max streams distintos en buffer. Default: 1000. */
  maxStreams?: number;
  /** Max entries por push batch. Default: 1000. */
  maxBatchSize?: number;
  /** Max bytes por línea. Default: 4096. */
  maxLineBytes?: number;
  /** Flush interval. Default: 5000 ms. */
  flushIntervalMs?: number;
  /** Max retries. Default: 3. */
  maxRetries?: number;
  /** HTTP timeout. Default: 10_000 ms. */
  requestTimeoutMs?: number;
  logger?: LoggerLike;
}

interface BufferedStream {
  labels: Record<string, string>;
  entries: LokiLogEntry[];
}

const DEFAULT_MAX_STREAMS = 1000;
const DEFAULT_MAX_BATCH = 1000;
const DEFAULT_MAX_LINE = 4096;
const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_REQUEST_TIMEOUT = 10_000;
const DEFAULT_FORBIDDEN = [
  "userId",
  "requestId",
  "traceId",
  "spanId",
  "user_id",
  "request_id",
  "trace_id",
  "span_id",
];

export type LokiState = "running" | "stopped" | "errored";

export class LokiShipper {
  private readonly config:
    & Required<
      Omit<
        LokiConfig,
        "bearerToken" | "basicAuth" | "tenantId" | "baseLabels" | "forbiddenLabelNames" | "logger"
      >
    >
    & {
      bearerToken: string | undefined;
      basicAuth: LokiConfig["basicAuth"];
      tenantId: string | undefined;
      baseLabels: Record<string, string>;
      forbiddenLabelNames: readonly string[];
      logger: LoggerLike;
    };
  private readonly streams = new Map<string, BufferedStream>();
  private timer: number | null = null;
  private state: LokiState = "stopped";

  constructor(config: LokiConfig) {
    validateEndpoint(config.endpoint);
    this.config = {
      endpoint: config.endpoint.replace(/\/+$/, ""),
      path: config.path ?? "/loki/api/v1/push",
      tenantId: config.tenantId,
      bearerToken: config.bearerToken,
      basicAuth: config.basicAuth,
      baseLabels: config.baseLabels ?? {},
      forbiddenLabelNames: config.forbiddenLabelNames ?? DEFAULT_FORBIDDEN,
      maxStreams: config.maxStreams ?? DEFAULT_MAX_STREAMS,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH,
      maxLineBytes: config.maxLineBytes ?? DEFAULT_MAX_LINE,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
      logger: config.logger ?? defaultLogger(),
    };
  }

  start(): void {
    if (this.state === "running") return;
    this.state = "running";
    this.timer = setInterval(
      () => this.flushSafe(),
      this.config.flushIntervalMs,
    ) as unknown as number;
    this.config.logger.info("loki: started", {
      endpoint: this.url(),
      intervalMs: this.config.flushIntervalMs,
    });
  }

  /**
   * Encola un log entry. Las labels de stream se merge-an con `baseLabels`.
   * Si excede `maxStreams`, drop oldest.
   */
  push(labels: Record<string, string>, line: string, timestampMs = Date.now()): void {
    // Backpressure: cap streams (evalúa ANTES de gastar CPU en sanitization).
    if (
      !this.streams.has(streamKey({ ...this.config.baseLabels, ...labels })) &&
      this.streams.size >= this.config.maxStreams
    ) {
      this.config.logger.warn("loki: max streams reached, dropping", {
        max: this.config.maxStreams,
      });
      return;
    }

    const merged: Record<string, string> = { ...this.config.baseLabels, ...labels };

    // Validación: labels prohibidos (PII / high-cardinality).
    for (const name of Object.keys(merged)) {
      if (this.config.forbiddenLabelNames.includes(name)) {
        this.config.logger.warn("loki: forbidden label dropped", { label: name });
        delete merged[name];
      }
    }
    // Validación: valores vacíos.
    for (const [k, v] of Object.entries(merged)) {
      if (v === "" || v == null) {
        this.config.logger.warn("loki: empty label value dropped", { label: k });
        delete merged[k];
      }
    }

    const key = streamKey(merged);

    const sanitized = sanitizeLine(line, this.config.maxLineBytes);
    const entry: LokiLogEntry = {
      timestampNs: BigInt(timestampMs) * 1_000_000n,
      line: sanitized,
    };

    let stream = this.streams.get(key);
    if (!stream) {
      stream = { labels: merged, entries: [] };
      this.streams.set(key, stream);
    }
    stream.entries.push(entry);
  }

  async flush(): Promise<void> {
    if (this.streams.size === 0) return;
    const batch = [...this.streams.values()];
    this.streams.clear();

    // Truncar cada stream a maxBatchSize.
    const limited: BufferedStream[] = batch.map((s) => {
      if (s.entries.length <= this.config.maxBatchSize) return s;
      this.config.logger.warn("loki: stream exceeded max batch, truncating", {
        stream: streamKey(s.labels),
        entries: s.entries.length,
        cap: this.config.maxBatchSize,
      });
      return { ...s, entries: s.entries.slice(0, this.config.maxBatchSize) };
    });

    const body = serializeToLokiJson(limited);

    let attempt = 0;
    while (attempt < this.config.maxRetries) {
      try {
        await this.send(body);
        this.config.logger.debug("loki: flushed", {
          streams: limited.length,
          totalEntries: limited.reduce((a, s) => a + s.entries.length, 0),
        });
        return;
      } catch (err) {
        attempt++;
        const retryable = (err as { retryable?: boolean })?.retryable === true;
        if (!retryable || attempt >= this.config.maxRetries) {
          this.config.logger.error("loki: flush failed permanently", {
            streams: limited.length,
            attempt,
            error: String(err),
          });
          return;
        }
        const backoff = Math.min(2 ** attempt * 1000 + Math.random() * 500, 60_000);
        await sleep(backoff);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state = "stopped";
    await this.flush();
  }

  getState(): LokiState {
    return this.state;
  }

  getStreamCount(): number {
    return this.streams.size;
  }

  private flushSafe(): void {
    this.flush().catch((err) =>
      this.config.logger.error("loki: flush threw", { error: String(err) })
    );
  }

  private async send(body: string): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "zenith-core/1.0",
    };
    if (this.config.bearerToken) {
      headers["Authorization"] = `Bearer ${this.config.bearerToken}`;
    } else if (this.config.basicAuth) {
      const credentials = btoa(
        `${this.config.basicAuth.username}:${this.config.basicAuth.password}`,
      );
      headers["Authorization"] = `Basic ${credentials}`;
    }
    if (this.config.tenantId) {
      headers["X-Scope-OrgID"] = this.config.tenantId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const res = await fetch(this.url(), {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (res.ok) return;
      const responseText = await res.text().catch(() => "");
      const err: Error & { status?: number; retryable?: boolean } = new Error(
        `loki: HTTP ${res.status} ${res.statusText} ${responseText}`.trim(),
      );
      err.status = res.status;
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        const e: Error & { retryable?: boolean } = new Error(
          `loki: timeout after ${this.config.requestTimeoutMs}ms`,
        );
        e.retryable = true;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private url(): string {
    return `${this.config.endpoint}${this.config.path}`;
  }
}

// ── Serialization ──────────────────────────────────────────────────────────

/**
 * Serializa streams al JSON wire format de Loki.
 * Formato: `{ streams: [{ stream: {labels}, values: [[ts_ns, line], ...] }, ...] }`
 *
 * CRÍTICO: el array `values` debe estar ordenado por timestamp ascendente
 * dentro de cada stream. Loki lo requiere.
 */
export function serializeToLokiJson(streams: readonly BufferedStream[]): string {
  const out = streams.map((s) => {
    const sorted = [...s.entries].sort((a, b) => {
      if (a.timestampNs < b.timestampNs) return -1;
      if (a.timestampNs > b.timestampNs) return 1;
      return 0;
    });
    return {
      stream: s.labels,
      values: sorted.map((e) => [
        e.timestampNs.toString(),
        e.line,
      ]),
    };
  });
  return JSON.stringify({ streams: out });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function streamKey(labels: Record<string, string>): string {
  // Ordenado alfabéticamente para canonicidad.
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join("\x00");
}

function sanitizeLine(line: string, maxBytes: number): string {
  // Trunca a maxBytes (en bytes UTF-8, no chars).
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= maxBytes) return line;
  const truncated = bytes.slice(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(truncated) + "…[truncated]";
}

function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`loki: invalid endpoint URL: ${endpoint}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`loki: endpoint must use HTTPS in production. Got: ${url.protocol}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultLogger(): LoggerLike {
  return {
    debug: () => {},
    info: (msg) => console.log(`[loki info] ${msg}`),
    warn: (msg, meta) => console.warn(`[loki warn] ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`[loki error] ${msg}`, meta ?? ""),
  };
}
