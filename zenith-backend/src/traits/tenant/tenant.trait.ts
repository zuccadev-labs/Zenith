// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export interface TenantConfig {
  objectId: string;
  tenantId: string;
  name: string;
  plan: string;
  databaseURI?: string;
  isolationStrategy: "shared" | "schema-per-tenant" | "database-per-tenant";
  features: Record<string, boolean>;
  createdAt: string;
  metadata?: Record<string, any>;
}

export const TenantTrait = createTraitDescriptor({
  name: "ZenithTenant",
  provides: ["tenant-routes", "tenant", "tenantManager"],
  consumes: ["db", "acl", "featureflags", "telemetry"],
  state: ["tenants"],
  runtimes: ["deno"],
  summary: "Multi-tenant management: tenant registry, RLS (row-level security) enforcement, isolation strategies (shared/schema/db-per-tenant), per-tenant feature flags, tenant-scoped API keys.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];

    const traitApi: any = {
      tenants: new Map<string, TenantConfig>(),

      createTenant: async (tenantId: string, name: string, plan: string, options: { isolationStrategy?: TenantConfig["isolationStrategy"]; features?: Record<string, boolean>; metadata?: Record<string, any> } = {}) => {
        const tenant: TenantConfig = {
          objectId: crypto.randomUUID(),
          tenantId,
          name,
          plan,
          isolationStrategy: options.isolationStrategy || "shared",
          features: options.features || {},
          createdAt: new Date().toISOString(),
          metadata: options.metadata,
        };
        traitApi.tenants.set(tenantId, tenant);
        await db.create("_Tenant", tenant);
        return tenant;
      },

      getTenant: (tenantId: string) => traitApi.tenants.get(tenantId),

      setTenantContext: (query: Record<string, any>, tenantId: string): Record<string, any> => {
        return { ...query, _tenantId: tenantId };
      },

      enforceRLS: async (className: string, query: Record<string, any>, tenantId: string) => {
        return { ...query, _tenantId: tenantId };
      },

      listTenants: () => Array.from(traitApi.tenants.values()),
    };

    const tenant_routes = [
      {
        method: "POST" as const,
        path: "/tenants",
        _openapi: { summary: "Create a new tenant" },
        handler: async (req: Request) => {
          const body = await req.json() as { tenantId: string; name: string; plan: string; isolationStrategy?: TenantConfig["isolationStrategy"]; features?: Record<string, boolean> };
          const tenant = await traitApi.createTenant(body.tenantId, body.name, body.plan, { isolationStrategy: body.isolationStrategy, features: body.features });
          return new Response(JSON.stringify(tenant), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/tenants",
        _openapi: { summary: "List all tenants" },
        handler: async () => new Response(JSON.stringify({ tenants: traitApi.listTenants() }), { status: 200, headers: { "content-type": "application/json" } }),
      },
      {
        method: "GET" as const,
        path: "/tenants/:tenantId",
        _openapi: { summary: "Get a specific tenant", parameters: [{ name: "tenantId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const tenantId = new URL(req.url).pathname.split("/")[2];
          const tenant = traitApi.getTenant(tenantId);
          if (!tenant) return new Response(JSON.stringify({ error: "tenant not found" }), { status: 404, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify(tenant), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "tenant-routes": tenant_routes,
      "tenant": traitApi,
      "tenantManager": traitApi,
    };
  },
});
