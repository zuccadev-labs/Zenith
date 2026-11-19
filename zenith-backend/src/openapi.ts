/**
 * The OpenAPI 3.1 spec of a Zenith project without starting it: the traits its configuration
 * selects are composed (no database, no network) and the spec is generated from the routes the
 * router would mount (`core/route-collection.ts`). `/openapi.json` on a running server is the same
 * spec plus the project's cloud functions and jobs.
 *
 * Used by `zen generate openapi`.
 *
 * @example
 * ```ts
 * import { generateProjectOpenApi } from "@zuccadev-labs/zenith/openapi";
 *
 * const spec = generateProjectOpenApi({ appId: "my-app", features: { crm: true } });
 * await Deno.writeTextFile("openapi.json", JSON.stringify(spec, null, 2));
 * ```
 *
 * @module
 */
import { selectTraits } from "./mod.ts";
import { composeZenith } from "./core/compose.ts";
import { generateOpenApiSchema, type OpenApiOptions } from "./core/openapi.ts";
import type { ZenithConfig } from "./core/types.ts";

export type { OpenApiOptions, ZenithConfig };

/** The parts of a project configuration that decide which routes exist. */
export interface ProjectRoutesConfig {
  /** App id written into the spec (default: `options.appId`, then `zenith`). */
  appId?: string;
  /** Feature flags of the project, as in {@link ZenithConfig}. */
  features?: ZenithConfig["features"];
  /** Node topology of the project, as in {@link ZenithConfig}; default `["http"]`. */
  topology?: ZenithConfig["topology"];
}

/** Spec of the project described by `config`. Throws if no route would be mounted. */
export function generateProjectOpenApi(
  config: ProjectRoutesConfig = {},
  options: OpenApiOptions = {},
): Record<string, unknown> {
  const appId = config.appId ?? options.appId ?? "zenith";
  const traits = selectTraits({
    appId,
    masterKey: "spec-only",
    databaseURI: "",
    features: config.features ?? {},
    ...(config.topology ? { topology: config.topology } : {}),
  } as ZenithConfig);
  const engine = composeZenith(traits).traits as Record<string, unknown>;
  const spec = generateOpenApiSchema(engine, { ...options, appId });
  const paths = Object.keys((spec.paths as Record<string, unknown>) ?? {});
  if (paths.length === 0) throw new Error("OpenAPI: the composed engine exposes no routes.");
  return spec;
}

export { generateOpenApiSchema };
