/**
 * @module @zenith/traits/webhooks/delivery
 *
 * Entrega de webhooks con una outbox en la base de datos: cada mensaje es un registro
 * (`ZenithWebhookMessage`) con su próximo intento. Sobrevive a reinicios, y varias instancias reparten el
 * trabajo sin duplicarlo, con el mecanismo de reclamo compartido con la cola de trabajos
 * (`core/outbox.ts`).
 *
 * Reglas (Standard Webhooks, § Operational considerations):
 * - **Reintentos:** inmediato, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h y 24 h, con ±10 % de
 *   jitter (unas 75 h en total).
 * - **Respuestas:**
 *   - 2xx es éxito;
 *   - 3xx es fallo (las redirecciones no se siguen);
 *   - 410 Gone desactiva el endpoint;
 *   - 429, 502 y 504 respetan `retry-after`;
 *   - cualquier otra es fallo y se reintenta.
 * - **Agotado:** el mensaje queda `failed`. Tras `DISABLE_AFTER_EXHAUSTED` mensajes agotados seguidos,
 *   el endpoint se desactiva y se avisa con el evento `webhook.endpoint.disabled`.
 * - **Tiempo por intento:** 15 s. La protección SSRF está en `security/outbound-http.ts`.
 */
import { safeFetch, type OutboundPolicy } from "../../security/outbound-http.ts";
import { webhookHeaders } from "../../security/webhook-signature.ts";
import { claimDue } from "../../core/outbox.ts";

export const MESSAGE_CLASS = "ZenithWebhookMessage";
export const ATTEMPT_CLASS = "ZenithWebhookAttempt";
export const ENDPOINT_CLASS = "ZenithWebhook";

/** Espera antes de cada intento (ms). El primero es inmediato. */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  0, 5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 50_400_000, 72_000_000, 86_400_000,
];
/** Mensajes agotados seguidos tras los que se desactiva un endpoint. */
export const DISABLE_AFTER_EXHAUSTED = 5;
/** Lo que se guarda de la respuesta del receptor en el registro de intentos. */
const RESPONSE_SNIPPET = 512;

export type Outcome =
  | { kind: "success" }
  | { kind: "gone" }
  | { kind: "retry"; notBeforeMs?: number };

/** Qué hacer con una respuesta HTTP. */
export function classify(status: number, retryAfter: string | null, nowMs: number): Outcome {
  if (status >= 200 && status < 300) return { kind: "success" };
  if (status === 410) return { kind: "gone" };
  if (retryAfter && [429, 502, 503, 504].includes(status)) {
    const seconds = Number(retryAfter);
    const at = Number.isFinite(seconds) ? nowMs + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(at)) return { kind: "retry", notBeforeMs: Math.min(at, nowMs + 86_400_000) };
  }
  return { kind: "retry" };
}

/** Cuándo toca el intento número `attempt` (1-based) tras uno fallido en `nowMs`; `null` si se agotaron. */
export function nextAttemptAt(attempt: number, nowMs: number, random: () => number = Math.random): number | null {
  const base = RETRY_SCHEDULE_MS[attempt];
  if (base === undefined) return null;
  const jitter = base * 0.1 * (random() * 2 - 1);
  return nowMs + Math.round(base + jitter);
}

export interface DeliveryDeps {
  readonly db: any;
  /** Secretos activos del endpoint, en claro (el actual primero). */
  readonly secretsOf: (endpoint: any) => Promise<string[]>;
  readonly policy: OutboundPolicy;
  readonly emit?: (event: string, payload: unknown) => void;
  readonly now?: () => number;
  readonly fetcher?: typeof safeFetch;
  /** The observability registry (`metric-registry`), when the piece is loaded. */
  readonly metrics?: MetricSink;
}

/** The part of the metric registry the delivery uses. */
export interface MetricSink {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Intenta entregar un mensaje que ya está reclamado. Registra el intento, programa el siguiente o lo
 * cierra, y actualiza el estado del endpoint.
 */
export async function attemptDelivery(deps: DeliveryDeps, message: any, endpoint: any): Promise<"succeeded" | "pending" | "failed"> {
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetcher ?? safeFetch;
  const attempt = (message.attempts ?? 0) + 1;
  const started = now();
  let status = 0;
  let error: string | undefined;
  let snippet: string | undefined;
  let outcome: Outcome;
  try {
    const secrets = await deps.secretsOf(endpoint);
    const headers = {
      "content-type": "application/json",
      "user-agent": "Zenith-Webhooks/1.0",
      ...(endpoint.headers ?? {}),
      ...(await webhookHeaders(secrets, message.messageId, message.body, started)),
    };
    const res = await fetcher(endpoint.url, { method: "POST", headers, body: message.body }, deps.policy);
    status = res.status;
    snippet = (await res.text().catch(() => "")).slice(0, RESPONSE_SNIPPET);
    outcome = classify(status, res.headers.get("retry-after"), now());
    if (outcome.kind !== "success") error = `HTTP ${status}`;
  } catch (e) {
    error = (e as Error).name === "TimeoutError" ? "Timeout" : (e as Error).message;
    outcome = { kind: "retry" };
  }
  const durationMs = now() - started;
  const result = outcome.kind === "success" ? "success" : outcome.kind === "gone" ? "gone" : status === 0 ? "error" : "retry";
  deps.metrics?.increment("zenith_webhook_attempts_total", { result });
  deps.metrics?.histogram("zenith_webhook_attempt_duration_ms", durationMs, { result });
  await deps.db.create(ATTEMPT_CLASS, {
    messageId: message.messageId, endpointId: endpoint.objectId, attempt, statusCode: status, durationMs,
    ...(error ? { error } : {}), ...(snippet ? { response: snippet } : {}), at: iso(started),
  }).catch(() => {});

  if (outcome.kind === "success") {
    await deps.db.update(MESSAGE_CLASS, { objectId: message.objectId }, {
      status: "succeeded", attempts: attempt, lastStatusCode: status, lastError: null, deliveredAt: iso(now()), nextAttemptAt: null, leaseUntil: null,
    });
    if (endpoint.exhaustedCount || endpoint.lastError) {
      await deps.db.update(ENDPOINT_CLASS, { objectId: endpoint.objectId }, { exhaustedCount: 0, lastError: null });
    }
    return "succeeded";
  }

  const gone = outcome.kind === "gone";
  let next = gone ? null : nextAttemptAt(attempt, now());
  if (next !== null && outcome.kind === "retry" && outcome.notBeforeMs) next = Math.max(next, outcome.notBeforeMs);
  if (next !== null) {
    await deps.db.update(MESSAGE_CLASS, { objectId: message.objectId }, {
      status: "pending", attempts: attempt, lastStatusCode: status, lastError: error, nextAttemptAt: iso(next), leaseUntil: null,
    });
    return "pending";
  }

  await deps.db.update(MESSAGE_CLASS, { objectId: message.objectId }, {
    status: "failed", attempts: attempt, lastStatusCode: status, lastError: error, nextAttemptAt: null, leaseUntil: null,
  });
  deps.metrics?.increment("zenith_webhook_messages_failed_total");
  const exhausted = (endpoint.exhaustedCount ?? 0) + 1;
  const disable = gone || exhausted >= DISABLE_AFTER_EXHAUSTED;
  const reason = gone ? "The endpoint answered 410 Gone." : `${exhausted} messages in a row failed after every retry.`;
  await deps.db.update(ENDPOINT_CLASS, { objectId: endpoint.objectId }, {
    exhaustedCount: exhausted, lastError: error ?? null,
    ...(disable ? { status: "disabled", disabledReason: reason, disabledAt: iso(now()) } : {}),
  });
  if (disable) {
    deps.metrics?.increment("zenith_webhook_endpoints_disabled_total");
    console.warn(`[webhooks] endpoint ${endpoint.objectId} (${endpoint.url}) disabled: ${reason}`);
    deps.emit?.("webhook.endpoint.disabled", { endpointId: endpoint.objectId, url: endpoint.url, reason, owner: endpoint.owner ?? null });
  }
  return "failed";
}

/**
 * Reclama (`core/outbox.ts`) y entrega los mensajes vencidos de endpoints activos. Devuelve cuántos
 * procesó. Los de un endpoint pausado o desactivado esperan; los de uno borrado se cierran.
 */
export async function deliverDue(deps: DeliveryDeps & { limit?: number; leaseMs?: number }): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const endpoints = new Map<string, any>();
  const endpointOf = async (id: string) => {
    if (!endpoints.has(id)) endpoints.set(id, await deps.db.read(ENDPOINT_CLASS, id));
    return endpoints.get(id);
  };
  const claimed = await claimDue<any>(deps.db, MESSAGE_CLASS, {
    now,
    limit: deps.limit ?? 20,
    leaseMs: deps.leaseMs ?? 60_000,
    accept: async (m) => {
      const ep = await endpointOf(m.endpointId);
      if (!ep) {
        await deps.db.update(MESSAGE_CLASS, { objectId: m.objectId }, { status: "failed", lastError: "Endpoint deleted.", nextAttemptAt: null });
        return false;
      }
      return ep.status === "active"; // paused or disabled: the message waits
    },
  });
  await Promise.all(claimed.map(async (m) => attemptDelivery(deps, m, await endpointOf(m.endpointId))));
  return claimed.length;
}
