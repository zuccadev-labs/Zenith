import { Zen } from "@zuccadev-labs/zenith";

/**
 * 08 — Billing & Metering
 *
 * Facturación, planes, suscripciones y medidores de uso.
 * Integración con Stripe (o proveedor configurable) para
 * gestión de pagos y suscripciones.
 *
 * API usada:
 *   Zen.Cloud.define()
 *   Zen.DB.*
 *   Zen.Cloud.httpRequest()      — proxy a Stripe API
 *   Zen.Config.get() / save()    — plan limits configurables
 *   Zen.Shell.exec()             — comando externo (lux-db, grafana)
 *   Zen.Logger
 *   Zen.Plugins                  — acceso a adaptadores (Stripe)
 */

const SUBSCRIPTION_CLASS = "Subscription";
const INVOICE_CLASS = "Invoice";
const METERING_CLASS = "UsageMeter";

// ─── Crear suscripción ────────────────────────────────────────────
Zen.Cloud.define("billing:create-subscription", async (req) => {
  const { plan, interval = "monthly", paymentMethodId } = req.params;
  const userId = req.user?.objectId;

  if (!userId) throw new Error("Usuario no autenticado");
  if (!plan) throw new Error("plan es requerido");

  const plans = await Zen.Config.get("plans") as Record<string, unknown> || {};
  const planConfig = plans[plan as string] as Record<string, unknown> | undefined;

  if (!planConfig) throw new Error(`Plan '${plan}' no encontrado`);

  // Buscar suscripción activa existente
  const existing = await Zen.DB.find(SUBSCRIPTION_CLASS, {
    where: { userId, status: { $in: ["active", "trialing"] } },
  });

  if (existing.length > 0) {
    throw new Error("Ya tienes una suscripción activa");
  }

  // Llamar a Stripe (vía HTTP proxy) si hay API key configurada
  const stripeKey = Deno.env.get("STRIPE_API_KEY");
  let stripeCustomerId: string | null = null;

  if (stripeKey && paymentMethodId) {
    try {
      const customer = await Zen.Cloud.httpRequest({
        url: "https://api.stripe.com/v1/customers",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `payment_method=${paymentMethodId}&email=${req.user?.username}&metadata[userId]=${userId}`,
      });

      stripeCustomerId = customer.data?.id || null;

      if (planConfig.stripePriceId) {
        await Zen.Cloud.httpRequest({
          url: "https://api.stripe.com/v1/subscriptions",
          method: "POST",
          headers: {
            "Authorization": `Bearer ${stripeKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `customer=${stripeCustomerId}&items[0][price]=${planConfig.stripePriceId}`,
        });
      }
    } catch (err) {
      Zen.Logger.warn("Error creando customer en Stripe", { error: (err as Error).message });
    }
  }

  const subscription = await Zen.DB.insert(SUBSCRIPTION_CLASS, {
    userId,
    plan,
    interval,
    status: stripeCustomerId ? "active" : "trialing",
    stripeCustomerId,
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: new Date(
      Date.now() + (interval === "monthly" ? 30 : 365) * 24 * 60 * 60 * 1000,
    ).toISOString(),
    trialEnd: !stripeCustomerId
      ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      : undefined,
    metadata: planConfig,
  });

  Zen.Logger.info("Suscripción creada", {
    userId,
    plan,
    subscriptionId: subscription.objectId,
  });

  return subscription;
});

// ─── Cancelar suscripción ─────────────────────────────────────────
Zen.Cloud.define("billing:cancel-subscription", async (req) => {
  const { subscriptionId, immediate = false } = req.params;
  const userId = req.user?.objectId;

  if (!subscriptionId) throw new Error("subscriptionId requerido");

  const subs = await Zen.DB.findOne(SUBSCRIPTION_CLASS, {
    where: { objectId: subscriptionId },
  });

  if (!subs) throw new Error("Suscripción no encontrada");
  if (subs.userId !== userId && !req.master) {
    throw new Error("No tienes permiso para cancelar esta suscripción");
  }

  // Cancelar en Stripe si aplica
  if (subs.stripeCustomerId) {
    const stripeKey = Deno.env.get("STRIPE_API_KEY");
    if (stripeKey) {
      try {
        const subscriptions = await Zen.Cloud.httpRequest({
          url: `https://api.stripe.com/v1/customers/${subs.stripeCustomerId}/subscriptions`,
          headers: { "Authorization": `Bearer ${stripeKey}` },
        });

        const stripeSubscriptions = subscriptions.data?.data || [];
        for (const sub of stripeSubscriptions as Array<{ id: string }>) {
          await Zen.Cloud.httpRequest({
            url: `https://api.stripe.com/v1/subscriptions/${sub.id}`,
            method: "DELETE",
            headers: { "Authorization": `Bearer ${stripeKey}` },
          });
        }
      } catch (err) {
        Zen.Logger.warn("Error cancelando en Stripe", { error: (err as Error).message });
      }
    }
  }

  const newStatus = immediate ? "canceled" : "canceled_at_period_end";
  await Zen.DB.update(SUBSCRIPTION_CLASS, subscriptionId as string, {
    status: newStatus,
    canceledAt: new Date().toISOString(),
    canceledBy: userId || "system",
  });

  Zen.Logger.info("Suscripción cancelada", { subscriptionId, status: newStatus });

  return { canceled: true, subscriptionId, status: newStatus };
});

// ─── Reportar uso (metering) ──────────────────────────────────────
Zen.Cloud.define("billing:report-usage", async (req) => {
  const { metric, value = 1, metadata } = req.params;
  const userId = req.user?.objectId || "anonymous";

  if (!metric) throw new Error("metric es requerido");

  const record = await Zen.DB.insert(METERING_CLASS, {
    userId,
    metric: metric as string,
    value: value as number,
    timestamp: new Date().toISOString(),
    metadata: metadata || {},
    source: req.headers["x-forwarded-for"] || req.ip || "unknown",
  });

  return { recorded: true, recordId: record.objectId };
});

// ─── Obtener uso actual ───────────────────────────────────────────
Zen.Cloud.define("billing:current-usage", async (req) => {
  const userId = req.user?.objectId;
  if (!userId) throw new Error("Usuario no autenticado");

  const periodStart = new Date();
  periodStart.setDate(1);
  periodStart.setHours(0, 0, 0, 0);

  const usage = await Zen.DB.find(METERING_CLASS, {
    where: {
      userId,
      timestamp: { $gte: periodStart.toISOString() },
    },
  });

  // Agrupar por métrica
  const grouped: Record<string, number> = {};
  for (const r of usage as Array<{ metric: string; value: number }>) {
    grouped[r.metric] = (grouped[r.metric] || 0) + r.value;
  }

  const plan = await Zen.DB.findOne(SUBSCRIPTION_CLASS, {
    where: { userId, status: { $in: ["active", "trialing"] } },
  });

  const limits = plan ? await Zen.Config.get(`plans.${plan.plan}.limits`) : {};

  return {
    userId,
    period: {
      start: periodStart.toISOString(),
      end: new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 0).toISOString(),
    },
    usage: grouped,
    limits: limits || {},
    plan: plan?.plan || "free",
  };
});

// ─── Listar facturas ──────────────────────────────────────────────
Zen.Cloud.define("billing:invoices", async (req) => {
  const userId = req.user?.objectId;
  if (!userId) throw new Error("Usuario no autenticado");

  const invoices = await Zen.DB.find(INVOICE_CLASS, {
    where: { userId },
    order: "-createdAt",
    limit: 12,
  });

  return invoices.map((inv: Record<string, unknown>) => ({
    id: inv.objectId,
    amount: inv.amount,
    currency: inv.currency,
    status: inv.status,
    paidAt: inv.paidAt,
    dueDate: inv.dueDate,
    items: inv.items,
    pdf: inv.pdfUrl,
  }));
});

// ─── Planes disponibles ───────────────────────────────────────────
Zen.Cloud.define("billing:plans", async () => {
  const config = await Zen.Config.get("plans");

  return config || {
    free: {
      name: "Free",
      price: 0,
      features: ["100 requests/day", "1 GB storage", "Community support"],
      limits: { apiCalls: 100, storage: 1_000_000_000 },
    },
    pro: {
      name: "Pro",
      price: 29,
      stripePriceId: "price_pro_monthly",
      features: ["10,000 requests/day", "50 GB storage", "Email support", "Custom domain"],
      limits: { apiCalls: 10_000, storage: 50_000_000_000 },
    },
    enterprise: {
      name: "Enterprise",
      price: 199,
      features: ["Unlimited requests", "1 TB storage", "Priority support", "SLA", "SSO"],
      limits: { apiCalls: -1, storage: 1_000_000_000_000 },
    },
  };
});
