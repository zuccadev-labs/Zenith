/**
 * Users, sessions and request authentication, Parse Server-compatible, delegated to engine-auth.
 *
 * @barrits-trait
 * @barrits-summary ZenithUserManagement
 * @barrits-provides user-routes, user-manager, authentication
 * @barrits-consumes database-crud
 * @barrits-state engineAuth
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { type AuthCrud, EngineAuthFacade, type EngineAuthConfig, type FacadeOptions, userRoutes } from "./engine-auth.ts";

export type { EngineAuthConfig } from "./engine-auth.ts";

const NOT_CONFIGURED = "Authentication is not configured (engineAuth).";

/**
 * `user-manager.configure(config.engineAuth)` runs once after composition (the database adapter is
 * injected after composition too). Until then every route answers 503 and every token is
 * anonymous: nothing is accepted without engine-auth.
 */
export const UserManagementTrait = createTraitDescriptor({
  name: "ZenithUserManagement",
  provides: ["user-routes", "user-manager", "authentication"],
  consumes: ["database-crud"],
  state: ["engineAuth"],
  runtimes: ["deno"],
  summary: "Users, sessions and request authentication (Parse Server-compatible), delegated to engine-auth.",
  create: (deps: Record<string, any>) => {
    // Barrits hands the composed capabilities under `traits`.
    const caps = (deps.traits ?? deps) as Record<string, unknown>;
    let facade: EngineAuthFacade | null = null;

    const current = (): EngineAuthFacade => {
      if (!facade) throw new Error(NOT_CONFIGURED);
      return facade;
    };

    const manager = {
      /** Wires engine-auth. Throws on a bad configuration so the server never starts half-secure. */
      configure: (cfg: EngineAuthConfig, opts: FacadeOptions = {}) => {
        facade = new EngineAuthFacade(cfg, caps["database-crud"] as AuthCrud, opts);
      },
      isConfigured: () => facade !== null,
      signUp: (body: Record<string, unknown>, ip: string) => current().signUp(body, ip),
      logIn: (body: Record<string, unknown>, ip: string) => current().logIn(body, ip),
      logOut: (sessionToken: string) => current().logOut(sessionToken),
      getCurrentUser: (sessionToken: string) => current().me(sessionToken),
    };

    const authentication = {
      /** Pipeline hook: identity for a session token or an access token, `null` if not proven. */
      verifySession: async (token: string) => (facade ? await facade.verifySession(token) : null),
    };

    const routes = userRoutes(current).map((r) => ({
      ...r,
      handler: (req: Request, ctx: any) =>
        facade
          ? r.handler(req, ctx)
          : Promise.resolve(new Response(JSON.stringify({ code: 1, error: NOT_CONFIGURED }), { status: 503, headers: { "content-type": "application/json" } })),
    }));

    return {
      "user-routes": routes,
      "user-manager": manager,
      authentication,
    };
  },
});
