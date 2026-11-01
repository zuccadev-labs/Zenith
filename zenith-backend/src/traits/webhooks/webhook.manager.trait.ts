// deno-lint-ignore-file no-unused-vars
/**
 * Webhook Manager Trait — CRUD de webhooks gestionados por el usuario.
 *
 * Extiende la lógica de firma del WebhookTrait existente añadiendo
 * los endpoints de gestión que permiten a los usuarios crear, editar,
 * pausar y eliminar sus propios webhooks vía API o CLI.
 *
 * Integración: usa `webhook-manager` del WebhookTrait para la entrega.
 * zen webhook create --url https://myapp.com/hook --events "Contact.*"
 *
 * @barrits-trait
 * @barrits-summary ZenithWebhookManager
 * @barrits-provides webhook_mgmt_routes, webhookManager
 * @barrits-consumes db, acl, webhook-manager, events
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { jsonRes, errRes, NO_CONTENT, pathParams, queryParams, parsePage, sortResults, ptr, now } from "../../core/trait-utils.ts";

const WEBHOOK_SCHEMA = {
  ZenithWebhook: {
    name:        { type: "String", required: true },
    url:         { type: "String", required: true },
    events:      { type: "Array",  required: true },  // ["Contact.created","Deal.*","*"]
    secret:      { type: "String" },                   // HMAC secret (generado si no se provee)
    status:      { type: "String", defaultValue: "active" }, // active|paused|failed
    owner:       { type: "Pointer", targetClass: "_User" },
    workspaceId: { type: "String" },
    lastTriggeredAt: { type: "Date" },
    failureCount:    { type: "Number", defaultValue: 0 },
    lastError:       { type: "String" },
    headers:         { type: "Object", defaultValue: {} }, // Headers adicionales custom
    retryPolicy:     { type: "Object", defaultValue: { maxRetries: 3, backoffMs: 1000 } },
  },
  ZenithWebhookDelivery: {
    webhook:     { type: "Pointer", targetClass: "ZenithWebhook", required: true },
    event:       { type: "String", required: true },
    payload:     { type: "Object" },
    statusCode:  { type: "Number" },
    success:     { type: "Boolean", defaultValue: false },
    attempt:     { type: "Number", defaultValue: 1 },
    duration:    { type: "Number" }, // ms
    error:       { type: "String" },
    deliveredAt: { type: "Date" },
  },
} as const;

/** Genera un secret HMAC aleatorio para el webhook */
async function generateSecret(): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  return `whsec_${Array.from(raw).map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Firma el payload con el secret del webhook */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `t=${Date.now()},v1=${hex}`;
}

export const WebhookManagerTrait = createTraitDescriptor({
  name: "ZenithWebhookManager",
  provides: ["webhook_mgmt_routes", "webhookManager"],
  consumes: ["db", "acl", "webhook-manager", "events"],
  state: [],
  runtimes: ["deno"],
  summary: "User-managed Webhook CRUD: create, list, update, pause, delete. HMAC-SHA256 signing, delivery logs, retry policy. Integrates with CLI `zen webhook`.",

  create: (deps: Record<string, any>) => {
    const db     = deps["db"];
    const events = deps["events"];

    if (deps["cloud"]?.defineSchema) {
      for (const [name, fields] of Object.entries(WEBHOOK_SCHEMA)) {
        deps["cloud"].defineSchema(name, fields, {});
      }
    }

    // Entrega efectiva del webhook con retry
    async function deliverWebhook(webhook: any, event: string, payload: unknown): Promise<void> {
      const body = JSON.stringify({ event, data: payload, timestamp: now(), webhookId: webhook.objectId });
      const signature = webhook.secret ? await signPayload(body, webhook.secret) : "";
      let attempt = 0, success = false, lastError = "";
      const maxRetries = webhook.retryPolicy?.maxRetries ?? 3;

      while (attempt < maxRetries && !success) {
        attempt++;
        const start = Date.now();
        try {
          const res = await fetch(webhook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-zenith-signature": signature,
              "x-zenith-event": event,
              ...(webhook.headers ?? {}),
            },
            body,
          });
          success = res.ok;
          lastError = success ? "" : `HTTP ${res.status}`;
          await db.create("ZenithWebhookDelivery", {
            webhook: ptr("ZenithWebhook", webhook.objectId),
            event, payload, statusCode: res.status, success,
            attempt, duration: Date.now() - start,
            error: lastError || undefined, deliveredAt: now(), createdAt: now(),
          }).catch(() => {});
          if (success) break;
        } catch(e: any) {
          lastError = e.message;
          await db.create("ZenithWebhookDelivery", {
            webhook: ptr("ZenithWebhook", webhook.objectId),
            event, payload, statusCode: 0, success: false,
            attempt, duration: Date.now() - start,
            error: lastError, deliveredAt: now(), createdAt: now(),
          }).catch(() => {});
        }
        if (!success && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, (webhook.retryPolicy?.backoffMs ?? 1000) * attempt));
        }
      }

      // Actualizar estado del webhook
      const failureCount = success ? 0 : (webhook.failureCount ?? 0) + 1;
      const status = failureCount >= 10 ? "failed" : (success ? "active" : webhook.status);
      await db.update("ZenithWebhook", { objectId: webhook.objectId }, {
        lastTriggeredAt: now(), failureCount,
        status, lastError: lastError || null, updatedAt: now(),
      }).catch(() => {});
    }

    // Suscribirse a todos los eventos para entregarlos a webhooks activos
    if (events) {
      const originalEmit = events.emit?.bind(events);
      if (originalEmit) {
        events.emit = async (eventName: string, data: unknown) => {
          originalEmit(eventName, data);
          // Buscar webhooks que escuchen este evento
          try {
            const active = await db.find("ZenithWebhook", { status: "active" });
            for (const wh of active) {
              const matches = (wh.events ?? []).some((pattern: string) => {
                if (pattern === "*") return true;
                if (pattern.endsWith(".*")) {
                  return eventName.startsWith(pattern.slice(0, -2));
                }
                return pattern === eventName;
              });
              if (matches) deliverWebhook(wh, eventName, data).catch(() => {});
            }
          } catch { /* no bloquear el flujo principal */ }
        };
      }
    }

    const api = {
      async list(ctx: any) {
        const where: Record<string, any> = {};
        if (!ctx.master && ctx.user) where["owner.objectId"] = ctx.user.objectId;
        const results = await db.find("ZenithWebhook", where);
        // Redactar el secret en las respuestas
        return { results: results.map((w: any) => ({ ...w, secret: w.secret ? "whsec_***" : null })) };
      },

      async get(objectId: string, ctx: any) {
        const wh = await db.read("ZenithWebhook", objectId);
        if (!wh) throw ZenithErrors.notFound("ZenithWebhook", objectId);
        if (!ctx.master && wh.owner?.objectId !== ctx.user?.objectId) throw ZenithErrors.forbidden();
        return { ...wh, secret: "whsec_***" };
      },

      async create(data: Record<string, any>, ctx: any) {
        if (!data.url) throw ZenithErrors.validationFailed("url es obligatorio.");
        if (!data.events?.length) throw ZenithErrors.validationFailed("events debe ser un array no vacío.");
        // Validar URL
        try { new URL(data.url); } catch { throw ZenithErrors.validationFailed("url no es una URL válida."); }
        const secret = data.secret ?? await generateSecret();
        const wh = await db.create("ZenithWebhook", {
          ...data, secret,
          owner: ctx.user ? ptr("_User", ctx.user.objectId) : null,
          status: "active", failureCount: 0,
          createdAt: now(), updatedAt: now(),
        });
        // Retornar secret completo SOLO en la creación
        return { ...wh, _secretWarning: "Guarda este secret. No se mostrará de nuevo." };
      },

      async update(objectId: string, data: Record<string, any>, ctx: any) {
        const wh = await db.read("ZenithWebhook", objectId);
        if (!wh) throw ZenithErrors.notFound("ZenithWebhook", objectId);
        if (!ctx.master && wh.owner?.objectId !== ctx.user?.objectId) throw ZenithErrors.forbidden();
        const allowed = ["name", "url", "events", "headers", "retryPolicy", "status"];
        const patch = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));
        return db.update("ZenithWebhook", { objectId }, { ...patch, updatedAt: now() });
      },

      async pause(objectId: string, ctx: any) {
        return api.update(objectId, { status: "paused" }, ctx);
      },

      async resume(objectId: string, ctx: any) {
        const wh = await db.read("ZenithWebhook", objectId);
        if (!wh) throw ZenithErrors.notFound("ZenithWebhook", objectId);
        return api.update(objectId, { status: "active", failureCount: 0 }, ctx);
      },

      async delete(objectId: string, ctx: any) {
        const wh = await db.read("ZenithWebhook", objectId);
        if (!wh) throw ZenithErrors.notFound("ZenithWebhook", objectId);
        if (!ctx.master && wh.owner?.objectId !== ctx.user?.objectId) throw ZenithErrors.forbidden();
        await db.delete("ZenithWebhook", { objectId });
        return { success: true };
      },

      async deliveries(webhookId: string, ctx: any) {
        const wh = await db.read("ZenithWebhook", webhookId);
        if (!wh) throw ZenithErrors.notFound("ZenithWebhook", webhookId);
        if (!ctx.master && wh.owner?.objectId !== ctx.user?.objectId) throw ZenithErrors.forbidden();
        const results = await db.find("ZenithWebhookDelivery", { "webhook.objectId": webhookId });
        return { results: sortResults(results, "-createdAt").slice(0, 50) };
      },

      async testDelivery(objectId: string, ctx: any) {
        const wh = await db.read("ZenithWebhook", objectId);
        if (!wh) throw ZenithErrors.notFound("ZenithWebhook", objectId);
        if (!ctx.master && wh.owner?.objectId !== ctx.user?.objectId) throw ZenithErrors.forbidden();
        await deliverWebhook(wh, "webhook.test", { message: "Test delivery from Zenith", timestamp: now() });
        return { success: true, message: "Test delivery enviado." };
      },
    };

    const webhook_mgmt_routes = [
      { method: "GET"    as const, path: "/zen/webhooks",                           _openapi: { summary: "Listar webhooks del usuario",            tags: ["Webhooks"] }, handler: async (_req: Request, ctx: any) => { try { return jsonRes(await api.list(ctx)); } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/webhooks/:objectId",                 _openapi: { summary: "Obtener webhook por ID",                 tags: ["Webhooks"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/webhooks/:objectId", req.url)!; return jsonRes(await api.get(p.objectId, ctx)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/webhooks",                           _openapi: { summary: "Crear webhook (secret solo visible al crear)", tags: ["Webhooks"] }, handler: async (req: Request, ctx: any) => { try { return jsonRes(await api.create(await req.json(), ctx), 201); } catch(e) { return errRes(e); } } },
      { method: "PUT"    as const, path: "/zen/webhooks/:objectId",                 _openapi: { summary: "Actualizar webhook",                     tags: ["Webhooks"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/webhooks/:objectId", req.url)!; return jsonRes(await api.update(p.objectId, await req.json(), ctx)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/webhooks/:objectId/pause",           _openapi: { summary: "Pausar webhook",                         tags: ["Webhooks"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/webhooks/:objectId/pause", req.url)!; return jsonRes(await api.pause(p.objectId, ctx)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/webhooks/:objectId/resume",          _openapi: { summary: "Reactivar webhook",                      tags: ["Webhooks"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/webhooks/:objectId/resume", req.url)!; return jsonRes(await api.resume(p.objectId, ctx)); } catch(e) { return errRes(e); } } },
      { method: "POST"   as const, path: "/zen/webhooks/:objectId/test",            _openapi: { summary: "Enviar entrega de prueba",               tags: ["Webhooks"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/webhooks/:objectId/test", req.url)!; return jsonRes(await api.testDelivery(p.objectId, ctx)); } catch(e) { return errRes(e); } } },
      { method: "GET"    as const, path: "/zen/webhooks/:objectId/deliveries",      _openapi: { summary: "Historial de entregas (últimas 50)",     tags: ["Webhooks"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/webhooks/:objectId/deliveries", req.url)!; return jsonRes(await api.deliveries(p.objectId, ctx)); } catch(e) { return errRes(e); } } },
      { method: "DELETE" as const, path: "/zen/webhooks/:objectId",                 _openapi: { summary: "Eliminar webhook",                       tags: ["Webhooks"] }, handler: async (req: Request, ctx: any) => { try { const p = pathParams("/zen/webhooks/:objectId", req.url)!; await api.delete(p.objectId, ctx); return NO_CONTENT; } catch(e) { return errRes(e); } } },
    ];

    return { webhook_mgmt_routes, webhookManager: api };
  },
});
