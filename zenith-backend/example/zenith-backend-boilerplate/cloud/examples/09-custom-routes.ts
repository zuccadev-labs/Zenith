import { Zen } from "@zuccadev-labs/zenith";

/**
 * 09 — Custom Routes & Webhooks
 *
 * Rutas HTTP personalizadas y webhooks para integraciones externas.
 * Usa Zen.API.defineRoute() para crear endpoints seguros y
 * Zen.Cloud.define() para lógica de negocio asociada.
 *
 * API usada:
 *   Zen.API.defineRoute()      — rutas HTTP custom con seguridad
 *   Zen.Cloud.define()         — funciones cloud
 *   Zen.Cloud.httpRequest()    — proxy HTTP
 *   Zen.DB.*                   — persistencia
 *   Zen.Config.get()           — configuración global
 *   Zen.Shell.exec()           — ejecución de comandos
 *   Zen.Logger                 — logging
 *   Zen.Plugins                — acceso a adaptadores
 */

// ─── Ruta: Health Check con métricas detalladas ───────────────────
Zen.API.defineRoute({
  method: "GET",
  path: "/_health",
  security: {},
  handler: async () => {
    const body = JSON.stringify({
      status: "ok",
      uptime: performance.now(),
      timestamp: new Date().toISOString(),
      version: "0.1.0",
      memory: {
        rss: Deno.memoryUsage().rss,
        heapUsed: Deno.memoryUsage().heapUsed,
      },
    });

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    });
  },
});

// ─── Ruta: Webhook de Stripe ──────────────────────────────────────
Zen.API.defineRoute({
  method: "POST",
  path: "/webhooks/stripe",
  security: {
    requireApiKey: Deno.env.get("STRIPE_WEBHOOK_SECRET") || "stripe_default_secret",
  },
  handler: async (req) => {
    const signature = req.headers.get("stripe-signature") || "";
    const payload = await req.text();

    Zen.Logger.info("Webhook de Stripe recibido", {
      signature: signature.slice(0, 16),
      bodySize: payload.length,
    });

    try {
      const event = JSON.parse(payload);

      switch (event.type) {
        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object;
          await Zen.DB.insert("PaymentEvent", {
            type: event.type,
            stripeId: paymentIntent.id,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            status: "succeeded",
            receivedAt: new Date().toISOString(),
          });
          break;
        }
        case "invoice.payment_failed": {
          const invoice = event.data.object;
          Zen.Logger.warn("Pago de factura fallido", {
            customer: invoice.customer,
            amount: invoice.amount_due,
          });
          // Notificar al usuario (email, push, etc.)
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const subs = await Zen.DB.find("Subscription", {
            where: { stripeCustomerId: sub.customer },
          });

          for (const s of subs) {
            await Zen.DB.update("Subscription", s.objectId, {
              status: "canceled",
              stripeDeletedAt: new Date().toISOString(),
            });
          }
          break;
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      Zen.Logger.error("Error procesando webhook Stripe", { error: (err as Error).message });
      return new Response(JSON.stringify({ error: "Invalid payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
});

// ─── Ruta: Webhook de GitHub ──────────────────────────────────────
Zen.API.defineRoute({
  method: "POST",
  path: "/webhooks/github",
  security: {
    requireApiKey: Deno.env.get("GITHUB_WEBHOOK_SECRET") || "github_default_secret",
  },
  handler: async (req) => {
    const event = req.headers.get("x-github-event") || "unknown";
    const deliveryId = req.headers.get("x-github-delivery") || "unknown";
    const body = await req.json().catch(() => ({}));

    Zen.Logger.info("Webhook de GitHub", {
      event,
      deliveryId,
      repo: body.repository?.full_name,
      action: body.action,
    });

    if (event === "push" && body.ref === "refs/heads/main") {
      await Zen.DB.insert("Deployment", {
        event: "github_push",
        repo: body.repository?.full_name,
        ref: body.ref,
        commit: body.head_commit?.id,
        committer: body.head_commit?.committer?.name,
        timestamp: new Date().toISOString(),
        processed: false,
      });
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});

// ─── Ruta: Proxy de búsqueda (segura) ─────────────────────────────
Zen.API.defineRoute({
  method: "GET",
  path: "/api/search",
  security: {
    requireRoles: ["user", "admin"],
  },
  handler: async (req, _ctx) => {
    const url = new URL(req.url);
    const q = url.searchParams.get("q");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);

    if (!q) {
      return new Response(JSON.stringify({ error: "Parámetro 'q' requerido" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const results = await Zen.DB.find("TodoItem", {
      where: {
        $or: [
          { title: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
        ],
        _deleted: { $ne: true },
      },
      limit,
    });

    return new Response(JSON.stringify({ query: q, results, count: results.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});

// ─── Ruta: Ping (para testing de conectividad) ────────────────────
Zen.Cloud.define("custom-routes:ping", async (req) => {
  return {
    pong: true,
    echo: req.params.message || "no message",
    user: req.user?.objectId || "anonymous",
    master: req.master,
    timestamp: new Date().toISOString(),
  };
});

// ─── Ruta: Desencadenar acción de Shell ───────────────────────────
Zen.Cloud.define("custom-routes:shell", async (req) => {
  const { command, args } = req.params;

  if (!req.master) {
    throw new Error("Solo master key puede ejecutar comandos shell");
  }

  try {
    const result = await Zen.Shell.exec(command as string, (args || []) as string[]);
    return {
      success: true,
      stdout: result.stdout.slice(0, 2000),
      stderr: result.stderr.slice(0, 1000),
      exitCode: result.code,
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
});

// ─── Ruta: Obtener metadatos de un archivo por URL pública ────────
Zen.API.defineRoute({
  method: "GET",
  path: "/api/resolve-meta",
  security: {},
  handler: async (req) => {
    const url = new URL(req.url);
    const target = url.searchParams.get("url");

    if (!target) {
      return new Response(JSON.stringify({ error: "Parámetro 'url' requerido" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const resp = await Zen.Cloud.httpRequest({
        url: target,
        method: "HEAD",
      });

      return new Response(
        JSON.stringify({
          url: target,
          status: resp.status,
          headers: resp.headers,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: (err as Error).message }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  },
});
