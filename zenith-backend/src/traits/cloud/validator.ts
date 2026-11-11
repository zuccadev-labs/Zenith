/**
 * Cloud Code validators (Parse Server's `Parse.Cloud.define(name, fn, validator)`), for functions and triggers.
 *
 * Before this module, `CloudValidator` existed and the OpenAPI said it ran, but nothing applied it: a
 * `beforeSave("X", fn, { requireUser: true })` protected nothing.
 *
 * Semantics (Parse Server's `builtInTriggerValidator`):
 * - With the master key nothing is checked, unless `validateMasterKey: true` (`skipWithMasterKey` is the
 *   older name of the default and is accepted).
 * - `requireMaster`, `requireUser`, `requireAnyUserRoles`, `requireAllUserRoles`.
 * - `fields`: on a function, its params; on a trigger, the object. Each with `required`, `type`, `default`, `options`
 *   (a list or a predicate), `constant` (on an update the original value is kept, as Parse does) and `error`.
 * - A failure throws code 142 (VALIDATION_ERROR) with "Validation failed. …".
 *
 * Who may call a function at all (`functionAccess`) is Zenith's (ADR-013): without a validator that opens it, a
 * function is master-only.
 */
import type { CloudValidator } from "../../core/cloud.ts";
import type { RouteAccess } from "../../core/route-collection.ts";
import { ZenithError, ZenithErrorCode } from "../../core/errors.ts";

/** Parse Server's VALIDATION_ERROR. */
export const VALIDATION_ERROR = 142;

/** A validator refusal: a ZenithError, so the server answers 400 with code 142 like Parse Server. */
export class CloudValidationError extends ZenithError {
  constructor(detail: string) {
    super(ZenithErrorCode.VALIDATION_ERROR, `Validation failed. ${detail}`, 400);
    this.name = "CloudValidationError";
  }
}

/**
 * What a client sees when a trigger throws (Parse Server): a ZenithError keeps its code; anything else
 * (`throw new Error("title is required")`, or a string) becomes 142 with its message. Before, it was a 500 and the
 * developer's message was lost.
 */
export function triggerFailure(e: unknown): ZenithError {
  if (e instanceof ZenithError) return e;
  const message = typeof e === "string" ? e : (e as Error)?.message || "Cloud trigger failed.";
  return new ZenithError(ZenithErrorCode.VALIDATION_ERROR, message, 400);
}

/**
 * Who may call a function: `master` by default (fail closed); `user` with `requireUser` or a role requirement;
 * `public` only when the validator says `public: true`. A validator with only `fields` keeps the function
 * master-only: opening it is a decision, not a side effect.
 */
export function functionAccess(v?: CloudValidator): RouteAccess {
  if (!v || v.requireMaster) return "master";
  if (v.requireUser || v.requireAnyUserRoles?.length || v.requireAllUserRoles?.length) {
    return "user";
  }
  return v.public ? "public" : "master";
}

/** The caller as validators see it. `apiKey`: the request came with an API key and no user. */
export interface ValidatedCaller {
  master: boolean;
  user?: { objectId: string; roles?: readonly string[] };
  apiKey?: boolean;
}

const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/**
 * Checks `caller` and `data` against `v`. `data` is changed in place: defaults are set and, with `original`
 * (an update), constant fields go back to their original value. Throws CloudValidationError.
 */
export async function checkValidator(
  v: CloudValidator | undefined,
  caller: ValidatedCaller,
  data: Record<string, unknown>,
  original?: Record<string, unknown>,
): Promise<void> {
  if (!v) return;
  if (caller.master && !v.validateMasterKey) return;
  if (v.requireMaster && !caller.master) {
    throw new CloudValidationError("Master key is required to complete this request.");
  }
  const roles = new Set((caller.user?.roles ?? []).map(String));
  if (
    (v.requireUser || v.requireAnyUserRoles?.length || v.requireAllUserRoles?.length) &&
    !caller.user
  ) {
    // An API key stands for a service, not a user: it passes `requireUser` (Zenith; Parse has no API keys) but
    // never a role requirement.
    if (
      !(caller.apiKey && v.requireUser && !v.requireAnyUserRoles?.length &&
        !v.requireAllUserRoles?.length)
    ) {
      throw new CloudValidationError("Please login to continue.");
    }
  }
  if (v.requireAnyUserRoles?.length && !v.requireAnyUserRoles.some((r) => roles.has(r))) {
    throw new CloudValidationError("User does not match the required roles.");
  }
  if (v.requireAllUserRoles?.length && !v.requireAllUserRoles.every((r) => roles.has(r))) {
    throw new CloudValidationError("User does not match all the required roles.");
  }
  for (const [key, opt] of Object.entries(v.fields ?? {})) {
    if (opt.constant && original && key in original && data[key] !== original[key]) {
      data[key] = original[key];
    }
    if (data[key] === undefined && opt.default !== undefined) {
      data[key] = typeof opt.default === "function"
        ? (opt.default as () => unknown)()
        : opt.default;
    }
    const value = data[key];
    if (value === undefined || value === null) {
      if (opt.required) {
        throw new CloudValidationError(opt.error ?? `Please specify data for ${key}.`);
      }
      continue;
    }
    if (opt.type && typeOf(value) !== opt.type.toLowerCase()) {
      throw new CloudValidationError(
        opt.error ?? `Invalid type for ${key}. Expected: ${opt.type.toLowerCase()}`,
      );
    }
    if (opt.options !== undefined) {
      const ok = typeof opt.options === "function"
        ? await opt.options(value)
        : (opt.options as unknown[]).includes(value);
      if (!ok) throw new CloudValidationError(opt.error ?? `Invalid option for ${key}.`);
    }
  }
}
