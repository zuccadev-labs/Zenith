// deno-lint-ignore-file no-unused-vars
/**
 * Multi-tenant management: tenant registry, RLS (row-level security) enforcement, isolation strategies (shared/schema/db-per-tenant), per-tenant feature flags, tenant-scoped API keys.
 *
 * @barrits-trait
 * @barrits-summary ZenithTenant
 * @barrits-provides tenant-routes, tenant, tenantManager
 * @barrits-consumes db
 * @barrits-state tenants
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

/** A tenant registered with the tenant trait and persisted in the `_Tenant` class. */
export interface TenantConfig {
  /** Unique id of the stored record (a random UUID). */
  objectId: string;
  /** Tenant identifier used to scope queries (`_tenantId`). */
  tenantId: string;
  /** Display name of the tenant. */
  name: string;
  /** Plan the tenant is subscribed to. */
  plan: string;
  /** Dedicated database connection string, for `database-per-tenant` isolation. */
  databaseURI?: string;
  /** How the tenant's data is isolated: shared collections, its own schema or its own database. */
  isolationStrategy: "shared" | "schema-per-tenant" | "database-per-tenant";
  /** Per-tenant feature switches. */
  features: Record<string, boolean>;
  /** Creation time as an ISO 8601 string. */
  createdAt: string;
  /** Arbitrary extra data attached to the tenant. */
  metadata?: Record<string, any>;
}

/**
 * Barrits trait providing `tenant` / `tenantManager` (create, get and list tenants, and scope
 * queries to a tenant by adding `_tenantId`) and `tenant-routes` (`POST /tenants`,
 * `GET /tenants`, `GET /tenants/:tenantId`). The registry is kept in memory and new tenants are
 * also written to the `_Tenant` class.
 */
export const TenantTrait = createTraitDescriptor({
  name: "ZenithTenant",
  provides: ["tenant-routes", "tenant", "tenantManager"],
  consumes: ["db"],
  state: ["tenants"],
  runtimes: ["deno"],
  summary:
    "Multi-tenant management: tenant registry, RLS (row-level security) enforcement, isolation strategies (shared/schema/db-per-tenant), per-tenant feature flags, tenant-scoped API keys.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    const traitApi: any = {
      tenants: new Map<string, TenantConfig>(),

      createTenant: async (
        tenantId: string,
        name: string,
        plan: string,
        options: {
          isolationStrategy?: TenantConfig["isolationStrategy"];
          features?: Record<string, boolean>;
          metadata?: Record<string, any>;
        } = {},
      ) => {
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
          const body = await req.json() as {
            tenantId: string;
            name: string;
            plan: string;
            isolationStrategy?: TenantConfig["isolationStrategy"];
            features?: Record<string, boolean>;
          };
          const tenant = await traitApi.createTenant(body.tenantId, body.name, body.plan, {
            isolationStrategy: body.isolationStrategy,
            features: body.features,
          });
          return new Response(JSON.stringify(tenant), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      },
      {
        method: "GET" as const,
        path: "/tenants",
        _openapi: { summary: "List all tenants" },
        handler: async () =>
          new Response(JSON.stringify({ tenants: traitApi.listTenants() }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
      {
        method: "GET" as const,
        path: "/tenants/:tenantId",
        _openapi: {
          summary: "Get a specific tenant",
          parameters: [{
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
        },
        handler: async (req: Request) => {
          const tenantId = new URL(req.url).pathname.split("/")[2];
          const tenant = traitApi.getTenant(tenantId);
          if (!tenant) {
            return new Response(JSON.stringify({ error: "tenant not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify(tenant), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
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
