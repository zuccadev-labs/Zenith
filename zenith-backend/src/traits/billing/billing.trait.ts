/**
 * SaaS billing facade (Stripe adapter by default): subscriptions, customers, invoices, webhooks. Plan tier enforcement, metered usage, dunning.
 *
 * @barrits-trait
 * @barrits-summary ZenithBilling
 * @barrits-provides billing-routes, billing, billingManager
 * @barrits-consumes db, acl, webhook, telemetry
 * @barrits-state stripeAdapter
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const BillingTrait = createTraitDescriptor({
  name: "ZenithBilling",
  provides: ["billing-routes", "billing", "billingManager"],
  consumes: ["db", "acl", "webhook", "telemetry"],
  state: ["stripeAdapter"],
  runtimes: ["deno"],
  summary: "SaaS billing facade (Stripe adapter by default): subscriptions, customers, invoices, webhooks. Plan tier enforcement, metered usage, dunning.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const webhook = deps["webhook"];

    const traitApi: any = {
      stripeAdapter: null as any,

      init: async (config: { stripeSecretKey: string; webhookSecret: string }) => {
        const stripeModule = await import("stripe");
        traitApi.stripeAdapter = new (stripeModule as any).default(config.stripeSecretKey, { apiVersion: "2025-09-30.clover" });
        return { initialized: true };
      },

      createCustomer: async (userId: string, email: string, metadata: Record<string, any> = {}) => {
        if (!traitApi.stripeAdapter) throw new Error("billing not initialized");
        const customer = await traitApi.stripeAdapter.customers.create({ email, metadata: { ...metadata, zenithUserId: userId } });
        await db.create("_BillingCustomer", { userId, stripeCustomerId: customer.id, email, createdAt: new Date().toISOString() });
        return customer;
      },

      createSubscription: async (customerId: string, priceId: string, options: { trialDays?: number } = {}) => {
        if (!traitApi.stripeAdapter) throw new Error("billing not initialized");
        return await traitApi.stripeAdapter.subscriptions.create({
          customer: customerId,
          items: [{ price: priceId }],
          trial_period_days: options.trialDays,
        });
      },

      recordUsage: async (subscriptionItemId: string, quantity: number, timestamp: number = Date.now()) => {
        if (!traitApi.stripeAdapter) throw new Error("billing not initialized");
        return await traitApi.stripeAdapter.subscriptionItems.createUsageRecord(subscriptionItemId, { quantity, timestamp, action: "increment" });
      },

      listInvoices: async (customerId: string) => {
        if (!traitApi.stripeAdapter) throw new Error("billing not initialized");
        return await traitApi.stripeAdapter.invoices.list({ customer: customerId });
      },
    };

    const billing_routes = [
      {
        method: "POST" as const,
        path: "/billing/customers",
        _openapi: { summary: "Create a Stripe customer" },
        handler: async (req: Request) => {
          const body = await req.json() as { userId: string; email: string };
          const customer = await traitApi.createCustomer(body.userId, body.email);
          return new Response(JSON.stringify(customer), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/billing/subscriptions",
        _openapi: { summary: "Create a subscription" },
        handler: async (req: Request) => {
          const body = await req.json() as { customerId: string; priceId: string; trialDays?: number };
          const sub = await traitApi.createSubscription(body.customerId, body.priceId, { trialDays: body.trialDays });
          return new Response(JSON.stringify(sub), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/billing/webhook",
        _openapi: { summary: "Receive Stripe webhook events" },
        handler: async (req: Request) => {
          const body = await req.text();
          if (webhook) {
            const sig = req.headers.get("stripe-signature") || "";
            const valid = await webhook.verify(sig, body);
            if (!valid) return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401, headers: { "content-type": "application/json" } });
          }
          return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "billing-routes": billing_routes,
      "billing": traitApi,
      "billingManager": traitApi,
    };
  },
});
