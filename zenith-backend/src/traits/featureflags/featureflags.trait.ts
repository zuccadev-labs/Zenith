// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export type Plan = "free" | "starter" | "pro" | "enterprise";

export interface PlanLimits {
  requestsPerDay: number;
  storageMb: number;
  pushNotificationsPerMonth: number;
  cloudFunctions: number;
  databaseOpsPerSecond: number;
  customDomains: number;
  seats: number;
  features: Record<string, boolean>;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { requestsPerDay: 10000, storageMb: 100, pushNotificationsPerMonth: 1000, cloudFunctions: 5, databaseOpsPerSecond: 50, customDomains: 0, seats: 1, features: { graphql: false, vault: false, mfa: true, audit: false } },
  starter: { requestsPerDay: 100000, storageMb: 1024, pushNotificationsPerMonth: 10000, cloudFunctions: 20, databaseOpsPerSecond: 200, customDomains: 1, seats: 5, features: { graphql: true, vault: false, mfa: true, audit: false } },
  pro: { requestsPerDay: 1000000, storageMb: 10240, pushNotificationsPerMonth: 100000, cloudFunctions: 100, databaseOpsPerSecond: 1000, customDomains: 5, seats: 25, features: { graphql: true, vault: true, mfa: true, audit: true } },
  enterprise: { requestsPerDay: 100000000, storageMb: 1048576, pushNotificationsPerMonth: 10000000, cloudFunctions: 10000, databaseOpsPerSecond: 10000, customDomains: 100, seats: -1, features: { graphql: true, vault: true, mfa: true, audit: true, mTLS: true, sso: true, sla: true } },
};

export const FEATURE_FLAGS: Record<string, { enabled: boolean; rolloutPercentage: number; allowedPlans: Plan[]; description: string }> = {
  saas_billing: { enabled: true, rolloutPercentage: 100, allowedPlans: ["starter", "pro", "enterprise"], description: "Enable SaaS billing layer (Stripe integration)" },
  ecommerce_search: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable e-commerce search (OpenSearch integration)" },
  gdpr_segmentation: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable GDPR/LGPD segmentation layer" },
  edge_wasm: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable WASM edge computing" },
  event_streaming: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable Kafka event streaming" },
  web3_ipfs: { enabled: true, rolloutPercentage: 100, allowedPlans: ["enterprise"], description: "Enable Web3 + IPFS storage" },
  federation_multi_region: { enabled: true, rolloutPercentage: 100, allowedPlans: ["enterprise"], description: "Enable multi-region federation (CRDT)" },
  e2ee_media: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable end-to-end encrypted media" },
  vectordb: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable Vector DB for RAG/semantic search" },
  iot: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable IoT layer (MQTT + device registry + SenML)" },
  agents: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable agent orchestrator (ReAct loop + tools)" },
  timeseries: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable TimeSeries (ScyllaDB + Grafana)" },
  workflow: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable workflow engine (iPaaS)" },
  multi_tenant: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable multi-tenant RLS" },
  compliance: { enabled: true, rolloutPercentage: 100, allowedPlans: ["pro", "enterprise"], description: "Enable compliance (GDPR/SOC2 + audit trail)" },
};

export const FeatureFlagsTrait = createTraitDescriptor({
  name: "ZenithFeatureFlags",
  provides: ["featureflags", "featureFlagManager"],
  consumes: ["db"],
  state: ["overrides"],
  runtimes: ["deno"],
  summary: "Feature flag engine: per-plan gating, percentage rollouts, A/B testing, user-level overrides, runtime toggling without restart.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];

    const traitApi: any = {
      overrides: new Map<string, boolean>(),

      isEnabled: (flag: string, context: { userId?: string; plan?: Plan } = {}): boolean => {
        if (traitApi.overrides.has(flag)) return traitApi.overrides.get(flag)!;
        const def = FEATURE_FLAGS[flag];
        if (!def) return false;
        if (!def.enabled) return false;
        if (context.plan && !def.allowedPlans.includes(context.plan)) return false;
        if (def.rolloutPercentage < 100 && context.userId) {
          const hash = simpleHash(context.userId + flag);
          if (hash % 100 >= def.rolloutPercentage) return false;
        }
        return true;
      },

      setOverride: (flag: string, enabled: boolean) => {
        traitApi.overrides.set(flag, enabled);
      },

      clearOverride: (flag: string) => {
        traitApi.overrides.delete(flag);
      },

      getLimits: (plan: Plan) => PLAN_LIMITS[plan],

      checkLimit: (plan: Plan, metric: keyof PlanLimits, currentValue: number): boolean => {
        const limits = PLAN_LIMITS[plan];
        const limit = limits[metric];
        if (typeof limit === "number") return limit === -1 || currentValue < limit;
        return true;
      },
    };

    function simpleHash(s: string): number {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
      return Math.abs(h);
    }

    return {
      "featureflags": traitApi,
      "featureFlagManager": traitApi,
    };
  },
});
