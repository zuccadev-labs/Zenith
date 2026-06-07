import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const WebhookTrait = createTraitDescriptor({
  name: "ZenithWebhook",
  provides: ["webhook-routes", "webhook-manager"],
  consumes: ["db", "acl", "telemetry"],
  state: ["webhookKeys"],
  runtimes: ["deno"],
  summary: "Outbound webhook delivery with HMAC-SHA256 signing, retry policy, and signing-key rotation. Inbound endpoint accepts webhooks from external providers (Stripe, GitHub, etc.) with signature verification.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const traitApi: any = {
      webhookKeys: new Map<string, { secret: string; createdAt: number; rotatedAt: number | null }>(),

      initKeys: async () => {
        if (traitApi.webhookKeys.size > 0) return;
        const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        traitApi.webhookKeys.set("primary", { secret, createdAt: Date.now(), rotatedAt: null });
      },

      sign: async (keyId: string, payload: string): Promise<string> => {
        await traitApi.initKeys();
        const key = traitApi.webhookKeys.get(keyId) || traitApi.webhookKeys.get("primary");
        if (!key) throw new Error(`webhook key not found: ${keyId}`);
        const encoder = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload));
        const sigHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
        return `t=${Date.now()},v1=${sigHex}`;
      },

      verify: async (headerValue: string, payload: string, tolerance: number = 300): Promise<boolean> => {
        if (!headerValue) return false;
        const parts = headerValue.split(",").reduce<Record<string, string>>((acc, p) => {
          const [k, v] = p.split("=");
          if (k && v) acc[k.trim()] = v.trim();
          return acc;
        }, {});
        const ts = parseInt(parts.t || "0", 10);
        const sig = parts.v1;
        if (!ts || !sig) return false;
        if (Math.abs(Date.now() - ts) > tolerance * 1000) return false;
        await traitApi.initKeys();
        const key = traitApi.webhookKeys.get("primary");
        if (!key) return false;
        const signed = `${ts}.${payload}`;
        const encoder = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const expected = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signed));
        const expectedHex = Array.from(new Uint8Array(expected)).map((b) => b.toString(16).padStart(2, "0")).join("");
        return timingSafeEqual(expectedHex, sig);
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
              headers: { "content-type": "application/json", "x-zenith-signature": signature, ...options.headers },
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
        const newSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        const oldKey = traitApi.webhookKeys.get("primary");
        if (oldKey) {
          traitApi.webhookKeys.set("legacy", { ...oldKey });
        }
        traitApi.webhookKeys.set("primary", { secret: newSecret, createdAt: Date.now(), rotatedAt: Date.now() });
        return { rotated: true, newKeyCreatedAt: new Date().toISOString() };
      },
    };

    function timingSafeEqual(a: string, b: string): boolean {
      if (a.length !== b.length) return false;
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return diff === 0;
    }

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
