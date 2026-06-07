import type { BillingAdapter } from "./types.ts";

/**
 * Stripe Billing Adapter (Mock)
 * Conecta Zenith con Stripe para pagos B2B, SaaS, y e-commerce.
 */
export function createStripeAdapter(_apiKey: string): BillingAdapter {
  return {
    init: async (_config: Record<string, any>): Promise<void> => {
      // No-op: la apiKey se inyecta en el closure al crear el adapter.
    },
    createCustomer: async (userId: string, _data?: { email?: string; name?: string }): Promise<string> => {
      console.log(`[StripeAdapter] Creating customer for userId: ${userId}`);
      return `cus_stripe_${userId.substring(0, 8)}`;
    },

    createSubscription: async (customerId: string, planId: string): Promise<any> => {
      console.log(`[StripeAdapter] Creating subscription for customer ${customerId} to plan ${planId}`);
      return {
        id: `sub_${Math.random().toString(36).substring(7)}`,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      };
    },

    reportUsage: async (customerId: string, metricName: string, quantity: number): Promise<void> => {
      console.log(`[StripeAdapter] Metered Usage -> Customer: ${customerId} | Metric: ${metricName} | Qty: ${quantity}`);
    },

    charge: async (customerId: string, amount: number, currency: string, _description?: string): Promise<string> => {
      console.log(`[StripeAdapter] Charging ${customerId} ${amount} ${currency}`);
      return `pi_${Math.random().toString(36).substring(7)}`;
    },

    verifyWebhookSignature: (_payload: string, signature: string): boolean => {
      return signature.length > 5;
    }
  };
}
