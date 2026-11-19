/**
 * Webhooks salientes de Zenith: cada evento del bus llega, firmado, a los endpoints suscritos.
 *
 * - **Formato:** Standard Webhooks 1.0. Cuerpo `{ type, timestamp, data }` y cabeceras `webhook-id`,
 *   `webhook-timestamp` y `webhook-signature` (`security/webhook-signature.ts`). Un receptor lo verifica
 *   con la biblioteca oficial de su lenguaje.
 * - **Entrega:** outbox en la base de datos, con reintentos durante unas 75 h y desactivación de los
 *   endpoints que fallan siempre (`webhook.delivery.ts`). Protección SSRF y 15 s por intento
 *   (`security/outbound-http.ts`).
 * - **Secretos:** uno por endpoint (`whsec_…`). Se cifran en reposo con `WEBHOOK_SECRETS_KEY` (AES-256-GCM)
 *   y solo se muestran al crear o rotar. La rotación mantiene el anterior durante el periodo de gracia y
 *   firma con los dos.
 * - **API** (solo master key, como `/hooks` en Parse Server y `/zen/api-keys`):
 *   - `/zen/webhooks`: CRUD;
 *   - `/pause`, `/resume`, `/test` y `/rotate-secret`;
 *   - mensajes, intentos, reentrega de un mensaje y recuperación de los fallidos desde una fecha.
 * - **Verificación de endpoints** (extensión de Standard Webhooks): un endpoint nuevo empieza
 *   `unverified` y no recibe nada hasta que `POST /zen/webhooks/:id/verify` le manda un desafío y responde
 *   con la clave derivada de su secreto. Así consta que quien opera la URL aceptó los webhooks y tiene el
 *   secreto correcto. Cambiar la URL lo devuelve a `unverified`. `ZENITH_WEBHOOKS_VERIFY=0` lo desactiva.
 * - **En caliente:** con la pieza `webhooks` apagada (`/zen/features`) no se encolan ni se entregan
 *   mensajes. Un endpoint pausado acumula los mensajes y los entrega al reanudarse; uno sin verificar
 *   no recibe eventos, porque todavía no consta su consentimiento.
 *
 * @barrits-trait
 * @barrits-summary ZenithWebhookManager
 * @barrits-provides webhook_mgmt_routes, webhookManager
 * @barrits-consumes db
 * @barrits-tags uses:events, uses:cloud, uses:runtime-features, uses:metric-registry
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithError, ZenithErrorCode, ZenithErrors } from "../../core/errors.ts";
import {
  errRes,
  jsonRes,
  NO_CONTENT,
  now,
  pathParams,
  sortResults,
} from "../../core/trait-utils.ts";
import { isSealed, randomBytes, seal, toBase64Url, unseal } from "../../core/crypto.ts";
import {
  generateChallenge,
  generateWebhookSecret,
  verifyEndpointVerificationResponse,
  WEBHOOK_CHALLENGE_HEADER,
  WEBHOOK_CHALLENGE_RESPONSE_HEADER,
  webhookHeaders,
} from "../../security/webhook-signature.ts";
import {
  checkOutboundUrl,
  OutboundBlockedError,
  type OutboundPolicy,
  safeFetch,
} from "../../security/outbound-http.ts";
import { sanitizePayload } from "../../security/sanitize.ts";
import {
  ATTEMPT_CLASS,
  deliverDue,
  type DeliveryDeps,
  ENDPOINT_CLASS,
  MESSAGE_CLASS,
} from "./webhook.delivery.ts";

const WEBHOOK_SCHEMA = {
  [ENDPOINT_CLASS]: {
    name: { type: "String", required: true },
    url: { type: "String", required: true },
    description: { type: "String" },
    events: { type: "Array", required: true }, // ["Contact.created", "Deal.*", "*"]
    status: { type: "String", defaultValue: "active" }, // unverified | active | paused | disabled
    verifiedAt: { type: "Date" },
    secrets: { type: "Array" }, // [{ value: cifrado, createdAt, expiresAt? }], el actual primero
    headers: { type: "Object", defaultValue: {} },
    exhaustedCount: { type: "Number", defaultValue: 0 },
    lastError: { type: "String" },
    disabledReason: { type: "String" },
    disabledAt: { type: "Date" },
  },
  [MESSAGE_CLASS]: {
    messageId: { type: "String", required: true }, // webhook-id: estable entre reintentos
    endpointId: { type: "String", required: true },
    type: { type: "String", required: true },
    body: { type: "String", required: true }, // los bytes exactos que se firman
    status: { type: "String", defaultValue: "pending" }, // pending | succeeded | failed
    attempts: { type: "Number", defaultValue: 0 },
    nextAttemptAt: { type: "Date" },
    leaseUntil: { type: "Date" },
    lastStatusCode: { type: "Number" },
    lastError: { type: "String" },
    deliveredAt: { type: "Date" },
  },
  [ATTEMPT_CLASS]: {
    messageId: { type: "String", required: true },
    endpointId: { type: "String", required: true },
    attempt: { type: "Number", required: true },
    statusCode: { type: "Number" },
    durationMs: { type: "Number" },
    error: { type: "String" },
    response: { type: "String" }, // primeros 512 caracteres
    at: { type: "Date" },
  },
} as const;

/** `Contact.created`, `Deal.*`, `*` (identificadores `[A-Za-z0-9_]`, separados por puntos). */
const EVENT_PATTERN = /^(\*|[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*(\.\*)?)$/;
/** Cabeceras que pone Zenith y no se pueden sustituir. */
const RESERVED_HEADERS = new Set([
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "content-type",
  "content-length",
  "host",
  "user-agent",
]);
const MAX_BODY_BYTES = 256 * 1024;
const ENDPOINT_CACHE_MS = 5_000;
const WORKER_INTERVAL_MS = 1_000;

// Shared with the Cloud Code Hooks (security/sanitize.ts); re-exported for existing callers.
export { sanitizePayload } from "../../security/sanitize.ts";

export function matchesEvent(patterns: readonly string[], type: string): boolean {
  return patterns.some((p) =>
    p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1)))
  );
}

const bad = (msg: string) => ZenithErrors.validationFailed(msg);
const newMessageId = () => `msg_${toBase64Url(randomBytes(16))}`;

export interface WebhookManagerOptions {
  /** Destinos http y privados permitidos (desarrollo). Por defecto, desde `ZENITH_WEBHOOKS_ALLOW_PRIVATE=1`. */
  readonly policy?: OutboundPolicy;
  /** Clave de cifrado de los secretos. Por defecto, `WEBHOOK_SECRETS_KEY`. */
  readonly secretsKey?: string;
  readonly fetcher?: DeliveryDeps["fetcher"];
  readonly now?: () => number;
  /** Endpoints start unverified until they answer a challenge. Default: on (`ZENITH_WEBHOOKS_VERIFY=0` turns it off). */
  readonly requireVerification?: boolean;
}

function envFlag(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Un trait de webhooks con opciones (pruebas, desarrollo). `WebhookManagerTrait` es el de producción. */
export function createWebhookManagerTrait(options: WebhookManagerOptions = {}): AnyTraitDescriptor {
  return createTraitDescriptor({
    name: "ZenithWebhookManager",
    provides: ["webhook_mgmt_routes", "webhookManager"],
    consumes: ["db"],
    tags: ["uses:events", "uses:cloud", "uses:runtime-features", "uses:metric-registry"],
    state: [],
    runtimes: ["deno"],
    summary:
      "Outgoing webhooks (Standard Webhooks): signed deliveries from a database outbox with ~75 h of retries, SSRF protection, secret rotation, message log, redelivery and recovery.",

    create: (deps: Record<string, any>) => {
      const db = deps.traits["db"];
      const events = deps.traits["events"];
      const features = deps.traits["runtime-features"];
      const metrics = deps.traits["metric-registry"];
      const clock = options.now ?? Date.now;
      const allowPrivate = envFlag("ZENITH_WEBHOOKS_ALLOW_PRIVATE") === "1";
      const policy: OutboundPolicy = options.policy ??
        (allowPrivate ? { allowHttp: true, allowPrivate: true } : {});
      const secretsKey = options.secretsKey ?? envFlag("WEBHOOK_SECRETS_KEY");
      const requireVerification = options.requireVerification ??
        envFlag("ZENITH_WEBHOOKS_VERIFY") !== "0";
      let warnedPlain = false;

      if (deps.traits["cloud"]?.defineSchema) {
        for (const [name, fields] of Object.entries(WEBHOOK_SCHEMA)) {
          deps.traits["cloud"].defineSchema(name, fields, {});
        }
      }

      const enabled = () => !features?.isEnabled || features.isEnabled("webhooks");

      // ── Secretos ───────────────────────────────────────────────────────────
      const protect = async (secret: string, endpointId: string) => {
        if (secretsKey) return await seal(secretsKey, secret, `webhook:${endpointId}`);
        if (!warnedPlain) {
          warnedPlain = true;
          console.warn(
            "[webhooks] WEBHOOK_SECRETS_KEY is not set: endpoint secrets are stored unencrypted.",
          );
        }
        return secret;
      };
      const reveal = async (value: string, endpointId: string) => {
        if (!isSealed(value)) return value;
        if (!secretsKey) {
          throw new Error("A webhook secret is encrypted but WEBHOOK_SECRETS_KEY is not set.");
        }
        return await unseal(secretsKey, value, `webhook:${endpointId}`);
      };
      const secretsOf = async (endpoint: any): Promise<string[]> => {
        const t = clock();
        const live = (endpoint.secrets ?? []).filter((s: any) =>
          !s.expiresAt || Date.parse(s.expiresAt) > t
        );
        return await Promise.all(live.map((s: any) => reveal(s.value, endpoint.objectId)));
      };

      const redact = (ep: any) => {
        if (!ep) return ep;
        const { secrets, ...rest } = ep;
        return { ...rest, secretCount: (secrets ?? []).length };
      };

      // ── Endpoints (con caché corta para el reparto de eventos) ─────────────
      let cache: { at: number; list: any[] } | null = null;
      const invalidate = () => {
        cache = null;
      };
      const subscribed = async () => {
        if (!cache || clock() - cache.at > ENDPOINT_CACHE_MS) {
          const list = (await db.find(ENDPOINT_CLASS, {})).filter((e: any) =>
            e.status === "active" || e.status === "paused"
          );
          cache = { at: clock(), list };
        }
        return cache.list;
      };

      const validate = async (data: Record<string, any>, partial: boolean) => {
        const out: Record<string, any> = {};
        if (!partial || data.name !== undefined) {
          if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 100) {
            throw bad("name: 1 to 100 characters.");
          }
          out.name = data.name.trim();
        }
        if (!partial || data.url !== undefined) {
          if (typeof data.url !== "string") throw bad("url is required.");
          try {
            await checkOutboundUrl(data.url, policy);
          } catch (e) {
            if (e instanceof OutboundBlockedError) throw bad(`url: ${e.message}`);
            throw e;
          }
          out.url = data.url;
        }
        if (!partial || data.events !== undefined) {
          const ev = data.events;
          if (
            !Array.isArray(ev) || ev.length === 0 || ev.length > 100 ||
            ev.some((p) => typeof p !== "string" || !EVENT_PATTERN.test(p))
          ) {
            throw bad(
              'events: a non-empty list of event types or patterns ("Contact.created", "Deal.*", "*").',
            );
          }
          out.events = [...new Set(ev)];
        }
        if (data.description !== undefined) {
          if (typeof data.description !== "string" || data.description.length > 500) {
            throw bad("description: up to 500 characters.");
          }
          out.description = data.description;
        }
        if (data.headers !== undefined) {
          const h = data.headers;
          if (
            typeof h !== "object" || h === null || Array.isArray(h) || Object.keys(h).length > 20
          ) throw bad("headers: an object with up to 20 entries.");
          for (const [k, v] of Object.entries(h)) {
            if (
              !/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 1000 ||
              /[\r\n]/.test(v)
            ) throw bad(`headers: invalid header "${k}".`);
            if (RESERVED_HEADERS.has(k.toLowerCase())) {
              throw bad(`headers: "${k}" is set by Zenith.`);
            }
          }
          out.headers = h;
        }
        return out;
      };

      const endpointOrThrow = async (id: string) => {
        const ep = await db.read(ENDPOINT_CLASS, id);
        if (!ep) throw ZenithErrors.notFound(ENDPOINT_CLASS, id);
        return ep;
      };

      // ── Mensajes ──────────────────────────────────────────────────────────
      const enqueueFor = async (endpoint: any, type: string, data: unknown, at = clock()) => {
        const body = JSON.stringify({
          type,
          timestamp: new Date(at).toISOString(),
          data: sanitizePayload(data ?? null),
        });
        const tooLarge = new TextEncoder().encode(body).length > MAX_BODY_BYTES;
        return await db.create(MESSAGE_CLASS, {
          messageId: newMessageId(),
          endpointId: endpoint.objectId,
          type,
          body: tooLarge
            ? JSON.stringify({ type, timestamp: new Date(at).toISOString(), data: null })
            : body,
          status: tooLarge ? "failed" : "pending",
          attempts: 0,
          leaseUntil: null,
          nextAttemptAt: new Date(at).toISOString(),
          ...(tooLarge ? { lastError: `Payload larger than ${MAX_BODY_BYTES} bytes.` } : {}),
        });
      };

      /** Reparte un evento entre los endpoints suscritos. Devuelve cuántos mensajes encoló. */
      const publish = async (type: string, data: unknown): Promise<number> => {
        if (!enabled() || typeof type !== "string" || !type) return 0;
        const targets = (await subscribed()).filter((e) => matchesEvent(e.events ?? [], type));
        for (const ep of targets) await enqueueFor(ep, type, data);
        if (targets.length) kick();
        return targets.length;
      };

      // ── Trabajador ────────────────────────────────────────────────────────
      const deliveryDeps: DeliveryDeps = {
        db,
        secretsOf,
        policy,
        emit: (event, payload) => {
          void events?.emit?.(event, payload);
        },
        now: clock,
        ...(metrics ? { metrics } : {}),
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      };
      /** Backlog gauges for dashboards and alerts (every 30 s with the worker). */
      const reportBacklog = async () => {
        if (!metrics) return;
        for (const status of ["pending", "failed"]) {
          metrics.gauge(
            "zenith_webhook_messages",
            (await db.find(MESSAGE_CLASS, { status })).length,
            { status },
          );
        }
        metrics.gauge(
          "zenith_webhook_endpoints_disabled",
          (await db.find(ENDPOINT_CLASS, { status: "disabled" })).length,
        );
      };
      let running: Promise<number> | null = null;
      const runOnce = (): Promise<number> => {
        if (!enabled()) return Promise.resolve(0);
        running ??= deliverDue(deliveryDeps).finally(() => {
          running = null;
        });
        return running;
      };
      let timer: ReturnType<typeof setInterval> | null = null;
      const kick = () => {
        if (timer !== null) void runOnce().catch(() => {});
      };

      if (events?.on) {
        // The bus hands wildcard subscribers the whole event ({ event, payload, timestamp }).
        events.on("*", (e: { event?: string; payload?: unknown }) => {
          if (!e?.event || e.event.startsWith("webhook.")) return; // no webhooks about webhook deliveries
          publish(e.event, e.payload).catch((err) =>
            console.warn(`[webhooks] could not enqueue ${e.event}: ${(err as Error).message}`)
          );
        });
      }

      const api = {
        publish,
        reportBacklog,
        /** Entrega lo vencido ahora (lo usa el trabajador; útil en pruebas). */
        deliverDue: runOnce,
        startBackground() {
          if (timer !== null) return;
          timer = setInterval(
            () =>
              void runOnce().catch((e) =>
                console.warn(`[webhooks] delivery loop: ${(e as Error).message}`)
              ),
            WORKER_INTERVAL_MS,
          );
          Deno.unrefTimer(timer);
          const gauges = setInterval(() => void reportBacklog().catch(() => {}), 30_000);
          Deno.unrefTimer(gauges);
        },
        stopBackground() {
          if (timer !== null) clearInterval(timer);
          timer = null;
        },

        async list() {
          return { results: (await db.find(ENDPOINT_CLASS, {})).map(redact) };
        },
        async get(id: string) {
          return redact(await endpointOrThrow(id));
        },
        async create(data: Record<string, any>) {
          const fields = await validate(data, false);
          const secret = generateWebhookSecret();
          const status = requireVerification ? "unverified" : "active";
          const ep = await db.create(ENDPOINT_CLASS, {
            ...fields,
            headers: fields.headers ?? {},
            status,
            exhaustedCount: 0,
            secrets: [],
          });
          await db.update(ENDPOINT_CLASS, { objectId: ep.objectId }, {
            secrets: [{ value: await protect(secret, ep.objectId), createdAt: now() }],
          });
          invalidate();
          return {
            ...redact({ ...ep, secrets: [1] }),
            secret,
            _secretWarning: "Store this secret now: it is not shown again.",
            ...(requireVerification
              ? {
                _verification:
                  `Configure the secret in the receiver, then POST /zen/webhooks/${ep.objectId}/verify.`,
              }
              : {}),
          };
        },
        async update(id: string, data: Record<string, any>) {
          const current = await endpointOrThrow(id);
          const fields = await validate(data, true);
          // A new URL may be operated by someone else: it must pass the check again.
          if (requireVerification && fields.url !== undefined && fields.url !== current.url) {
            Object.assign(fields, { status: "unverified", verifiedAt: null });
          }
          const updated = await db.update(ENDPOINT_CLASS, { objectId: id }, fields);
          invalidate();
          return redact(updated);
        },
        async setStatus(id: string, status: "active" | "paused") {
          const current = await endpointOrThrow(id);
          if (current.status === "unverified") {
            throw bad(`Endpoint ${id} is not verified: POST /zen/webhooks/${id}/verify first.`);
          }
          const patch = status === "active"
            ? { status, exhaustedCount: 0, disabledReason: null, disabledAt: null }
            : { status };
          const updated = await db.update(ENDPOINT_CLASS, { objectId: id }, patch);
          invalidate();
          if (status === "active") kick();
          return redact(updated);
        },
        async remove(id: string) {
          await endpointOrThrow(id);
          await db.delete(ENDPOINT_CLASS, { objectId: id });
          invalidate();
        },
        async rotateSecret(id: string, graceHours = 24) {
          if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 24 * 7) {
            throw bad("graceHours: 0 to 168.");
          }
          const ep = await endpointOrThrow(id);
          const secret = generateWebhookSecret();
          const until = new Date(clock() + graceHours * 3_600_000).toISOString();
          const previous = (ep.secrets ?? []).filter((s: any) =>
            !s.expiresAt || Date.parse(s.expiresAt) > clock()
          ).slice(0, 1);
          const secrets = [
            { value: await protect(secret, id), createdAt: now() },
            ...(graceHours > 0 ? previous.map((s: any) => ({ ...s, expiresAt: until })) : []),
          ];
          await db.update(ENDPOINT_CLASS, { objectId: id }, { secrets });
          invalidate();
          return {
            id,
            secret,
            previousValidUntil: graceHours > 0 && previous.length ? until : null,
          };
        },
        /**
         * Endpoint verification: a dedicated signed POST with `webhook-challenge` (never with a delivery).
         * The endpoint passes if it answers 2xx with the matching `webhook-challenge-response`.
         */
        async verify(id: string) {
          const ep = await endpointOrThrow(id);
          const secrets = await secretsOf(ep);
          const challenge = generateChallenge();
          const body = JSON.stringify({
            type: "webhook.endpoint.verification",
            timestamp: new Date(clock()).toISOString(),
            data: null,
          });
          let verified = false;
          let reason = "";
          try {
            const headers = {
              "content-type": "application/json",
              "user-agent": "Zenith-Webhooks/1.0",
              ...(await webhookHeaders(secrets, newMessageId(), body, clock())),
              [WEBHOOK_CHALLENGE_HEADER]: challenge,
            };
            const res = await (options.fetcher ?? safeFetch)(ep.url, {
              method: "POST",
              headers,
              body,
            }, policy);
            await res.body?.cancel();
            if (res.status < 200 || res.status >= 300) reason = `HTTP ${res.status}.`;
            else if (
              !(await verifyEndpointVerificationResponse(
                secrets,
                challenge,
                res.headers.get(WEBHOOK_CHALLENGE_RESPONSE_HEADER),
              ))
            ) {
              reason =
                `Missing or wrong ${WEBHOOK_CHALLENGE_RESPONSE_HEADER}: the receiver must answer the challenge with its secret.`;
            } else verified = true;
          } catch (e) {
            reason = (e as Error).name === "TimeoutError" ? "Timeout." : (e as Error).message;
          }
          if (!verified) return { id, verified: false, status: ep.status, reason };
          const patch = {
            verifiedAt: new Date(clock()).toISOString(),
            ...(ep.status === "unverified" ? { status: "active" } : {}),
          };
          await db.update(ENDPOINT_CLASS, { objectId: id }, patch);
          invalidate();
          kick();
          return { id, verified: true, status: ep.status === "unverified" ? "active" : ep.status };
        },
        async test(id: string) {
          const ep = await endpointOrThrow(id);
          const m = await enqueueFor(ep, "webhook.test", { message: "Test delivery from Zenith" });
          kick();
          return { messageId: m.messageId, status: "pending" };
        },
        async messages(id: string, status?: string) {
          await endpointOrThrow(id);
          const where: Record<string, unknown> = { endpointId: id };
          if (status) where.status = status;
          const results = sortResults(await db.find(MESSAGE_CLASS, where), "-createdAt").slice(
            0,
            100,
          );
          return { results: results.map(({ body: _b, leaseUntil: _l, ...m }: any) => m) };
        },
        async attempts(id: string, messageId: string) {
          await endpointOrThrow(id);
          const results = sortResults(
            await db.find(ATTEMPT_CLASS, { endpointId: id, messageId }),
            "attempt",
          );
          return { results };
        },
        async redeliver(id: string, messageId: string) {
          await endpointOrThrow(id);
          const [m] = await db.find(MESSAGE_CLASS, { endpointId: id, messageId });
          if (!m) throw ZenithErrors.notFound(MESSAGE_CLASS, messageId);
          if (m.status === "pending") return { messageId, status: "pending" };
          // Same webhook-id: the receiver can recognise it as a duplicate.
          await db.update(MESSAGE_CLASS, { objectId: m.objectId }, {
            status: "pending",
            attempts: 0,
            nextAttemptAt: new Date(clock()).toISOString(),
            leaseUntil: null,
          });
          kick();
          return { messageId, status: "pending" };
        },
        /** Vuelve a encolar los mensajes fallidos desde `since` (recuperación tras una caída del receptor). */
        async recover(id: string, since: string) {
          await endpointOrThrow(id);
          const from = Date.parse(since);
          if (!Number.isFinite(from)) throw bad("since: an ISO 8601 date.");
          const failed = (await db.find(MESSAGE_CLASS, { endpointId: id, status: "failed" }))
            .filter((m: any) => Date.parse(m.createdAt) >= from);
          for (const m of failed) {
            await db.update(MESSAGE_CLASS, { objectId: m.objectId }, {
              status: "pending",
              attempts: 0,
              nextAttemptAt: new Date(clock()).toISOString(),
              leaseUntil: null,
            });
          }
          kick();
          return { requeued: failed.length };
        },
      };

      const body = async (req: Request) => {
        try {
          return (await req.json()) ?? {};
        } catch {
          throw new ZenithError(ZenithErrorCode.INVALID_JSON, "Invalid JSON body.", 400);
        }
      };
      const route = (
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        summary: string,
        run: (req: Request, p: Record<string, string>) => Promise<Response>,
      ) => ({
        method,
        path,
        access: "master" as const,
        _openapi: { summary, tags: ["Webhooks"] },
        handler: async (req: Request) => {
          try {
            return await run(req, pathParams(path, req.url) ?? {});
          } catch (e) {
            return errRes(e);
          }
        },
      });

      const webhook_mgmt_routes = [
        route(
          "GET",
          "/zen/webhooks",
          "List webhook endpoints (secrets are never returned)",
          async () => jsonRes(await api.list()),
        ),
        route(
          "POST",
          "/zen/webhooks",
          "Create an endpoint. The signing secret is returned once",
          async (req) => jsonRes(await api.create(await body(req)), 201),
        ),
        route(
          "GET",
          "/zen/webhooks/:objectId",
          "Get an endpoint",
          async (_r, p) => jsonRes(await api.get(p.objectId)),
        ),
        route(
          "PUT",
          "/zen/webhooks/:objectId",
          "Update name, url, events, description or headers",
          async (req, p) => jsonRes(await api.update(p.objectId, await body(req))),
        ),
        route("DELETE", "/zen/webhooks/:objectId", "Delete an endpoint", async (_r, p) => {
          await api.remove(p.objectId);
          return NO_CONTENT;
        }),
        route(
          "POST",
          "/zen/webhooks/:objectId/pause",
          "Pause deliveries (messages wait until resume)",
          async (_r, p) => jsonRes(await api.setStatus(p.objectId, "paused")),
        ),
        route(
          "POST",
          "/zen/webhooks/:objectId/resume",
          "Resume, or re-enable a disabled endpoint",
          async (_r, p) => jsonRes(await api.setStatus(p.objectId, "active")),
        ),
        route(
          "POST",
          "/zen/webhooks/:objectId/test",
          "Send a webhook.test message",
          async (_r, p) => jsonRes(await api.test(p.objectId), 202),
        ),
        route(
          "POST",
          "/zen/webhooks/:objectId/verify",
          "Endpoint verification (Standard Webhooks): send a challenge; a correct answer activates an unverified endpoint",
          async (_r, p) => jsonRes(await api.verify(p.objectId)),
        ),
        route(
          "POST",
          "/zen/webhooks/:objectId/rotate-secret",
          "New secret, returned once. The previous one keeps signing for graceHours (default 24)",
          async (req, p) => {
            const b = await body(req);
            return jsonRes(
              await api.rotateSecret(
                p.objectId,
                b.graceHours === undefined ? 24 : Number(b.graceHours),
              ),
            );
          },
        ),
        route(
          "GET",
          "/zen/webhooks/:objectId/messages",
          "Latest messages of an endpoint (?status=pending|succeeded|failed)",
          async (req, p) =>
            jsonRes(
              await api.messages(
                p.objectId,
                new URL(req.url).searchParams.get("status") ?? undefined,
              ),
            ),
        ),
        route(
          "GET",
          "/zen/webhooks/:objectId/messages/:messageId/attempts",
          "Delivery attempts of a message",
          async (_r, p) => jsonRes(await api.attempts(p.objectId, p.messageId)),
        ),
        route(
          "POST",
          "/zen/webhooks/:objectId/messages/:messageId/redeliver",
          "Deliver a message again (same webhook-id)",
          async (_r, p) => jsonRes(await api.redeliver(p.objectId, p.messageId), 202),
        ),
        route(
          "POST",
          "/zen/webhooks/:objectId/recover",
          "Requeue the failed messages created since a date ({ since })",
          async (req, p) =>
            jsonRes(await api.recover(p.objectId, String((await body(req)).since ?? "")), 202),
        ),
      ];

      return { webhook_mgmt_routes, webhookManager: api };
    },
  });
}

/**
 * Webhook manager trait: endpoints subscribed to bus events receive them signed (Standard
 * Webhooks), through a database outbox with retries; managed under `/zen/webhooks`.
 */
export const WebhookManagerTrait: AnyTraitDescriptor = createWebhookManagerTrait();
