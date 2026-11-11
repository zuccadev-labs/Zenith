/**
 * Outbound webhook delivery with HMAC-SHA256 signing, retry policy, and signing-key rotation. Inbound endpoint accepts webhooks from external providers (Stripe, GitHub, etc.) with signature verification.
 *
 * @barrits-trait
 * @barrits-summary ZenithWebhook
 * @barrits-provides webhook-routes, webhook-manager
 * @barrits-consumes db
 * @barrits-state webhookKeys
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { randomHex } from "../../core/crypto.ts";
import { signWebhook, verifyWebhook, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TOLERANCE_SECONDS } from "../../security/webhook-signature.ts";

export const WebhookTrait = createTraitDescriptor({
  name: "ZenithWebhook",
  provides: ["webhook-routes", "webhook-manager"],
  consumes: ["db"],
  state: ["webhookKeys"],
  runtimes: ["deno"],
  summary: "Outbound webhook delivery with HMAC-SHA256 signing, retry policy, and signing-key rotation. Inbound endpoint accepts webhooks from external providers (Stripe, GitHub, etc.) with signature verification.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const traitApi: any = {
      webhookKeys: new Map<string, { secret: string; createdAt: number; rotatedAt: number | null }>(),

      initKeys: async () => {
        if (traitApi.webhookKeys.size > 0) return;
        const secret = randomHex(32);
        traitApi.webhookKeys.set("primary", { secret, createdAt: Date.now(), rotatedAt: null });
      },

      sign: async (keyId: string, payload: string): Promise<string> => {
        await traitApi.initKeys();
        const key = traitApi.webhookKeys.get(keyId) || traitApi.webhookKeys.get("primary");
        if (!key) throw new Error(`webhook key not found: ${keyId}`);
        return signWebhook(key.secret, payload);
      },

      /** Verifica con la clave actual y, durante una rotación, con la anterior. */
      verify: async (headerValue: string, payload: string, tolerance: number = WEBHOOK_TOLERANCE_SECONDS): Promise<boolean> => {
        await traitApi.initKeys();
        const secrets = ["primary", "legacy"].map((k) => traitApi.webhookKeys.get(k)?.secret).filter(Boolean) as string[];
        return verifyWebhook(headerValue, payload, secrets, { toleranceSeconds: tolerance });
      },

      deliver: async (url: string, payload: Record<string, any>, options: { maxRetries?: number; timeout?: number; headers?: Record<string, string> } = {}) => {
        const body = JSON.stringify(payload);
        const signature = await traitApi.sign("primary", body);
        const maxRetries = options.maxRetries ?? 3;
        const timeout = options.timeout ?? 10000;
        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", [WEBHOOK_SIGNATURE_HEADER]: signature, ...options.headers },
              body,
              signal: controller.signal,
            });
            clearTimeout(timer);
            if (res.ok) return { delivered: true, status: res.status, attempt };
            if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
              return { delivered: false, status: res.status, attempt, permanent: true };
            }
            lastError = new Error(`HTTP ${res.status}`);
          } catch (e) {
            clearTimeout(timer);
            lastError = e as Error;
          }
          if (attempt < maxRetries) {
            const backoff = Math.min(1000 * Math.pow(2, attempt), 30000);
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
        return { delivered: false, error: lastError?.message, attempts: maxRetries + 1 };
      },

      registerEndpoint: async (url: string, eventTypes: string[], secret?: string) => {
        await traitApi.initKeys();
        const ep = {
          objectId: crypto.randomUUID(),
          url,
          eventTypes,
          secret: secret || null,
          active: true,
          createdAt: new Date().toISOString(),
        };
        await db.create("WebhookEndpoint", ep);
        return ep;
      },

      listEndpoints: async () => db.find("WebhookEndpoint", { active: true }),

      rotateKey: async () => {
        const newSecret = randomHex(32);
        const oldKey = traitApi.webhookKeys.get("primary");
        if (oldKey) {
          traitApi.webhookKeys.set("legacy", { ...oldKey });
        }
        traitApi.webhookKeys.set("primary", { secret: newSecret, createdAt: Date.now(), rotatedAt: Date.now() });
        return { rotated: true, newKeyCreatedAt: new Date().toISOString() };
      },
    };

    const webhook_routes = [
      {
        method: "POST" as const,
        path: "/webhooks/endpoints",
        _openapi: { summary: "Register a new webhook endpoint" },
        handler: async (req: Request) => {
          const body = await req.json() as { url: string; eventTypes: string[]; secret?: string };
          const ep = await traitApi.registerEndpoint(body.url, body.eventTypes, body.secret);
          return new Response(JSON.stringify(ep), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/webhooks/endpoints",
        _openapi: { summary: "List active webhook endpoints" },
        handler: async () => {
          const eps = await traitApi.listEndpoints();
          return new Response(JSON.stringify({ results: eps }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/webhooks/rotate-key",
        _openapi: { summary: "Rotate webhook signing key" },
        handler: async () => {
          const result = await traitApi.rotateKey();
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/hooks/trigger",
        _openapi: {
          summary: "Manually trigger a webhook delivery (test)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" }, payload: { type: "object" } }, required: ["url", "payload"] } } } },
        },
        handler: async (req: Request) => {
          const body = await req.json() as { url: string; payload: Record<string, any> };
          const result = await traitApi.deliver(body.url, body.payload);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "webhook-routes": webhook_routes,
      "webhook-manager": traitApi,
    };
  },
});
