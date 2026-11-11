/**
 * @module @zenith/security/api-keys/policy
 *
 * Access policies for API keys (ADR-015), after Stripe's model: least privilege first, and keys
 * that can do anything are locked to known networks.
 *
 * - `allowedIps`: IPv4/IPv6 addresses or CIDR ranges. Any key may have one; outside it the key is
 *   rejected (`ip_not_allowed`) and the attempt is audited. Stripe: "access policies so keys can
 *   only be used from your known servers" (docs.stripe.com/keys#access-policies).
 * - **Unrestricted keys** (scope `*`, which the router treats as the master key) must:
 *   - be secret keys (`sk_`): a publishable or restricted key is never full access;
 *   - carry an IP allowlist that is not "everywhere" (no `0.0.0.0/0`, `::/0`);
 *   - expire within {@link UNRESTRICTED_MAX_LIFETIME_DAYS} days, so they are rotated (Stripe: "rotate
 *     secret API keys periodically", docs.stripe.com/keys-best-practices);
 *   An unrestricted key stored without an allowlist (older data) is refused (`policy_missing`):
 *   the check fails closed.
 * - Managing keys needs the master key itself: no API key, not even `*`, can mint or revoke keys,
 *   so a stolen key cannot make itself permanent (routes.ts).
 *
 * The client address is the socket's, or the first X-Forwarded-For hop only when the socket is a
 * configured trusted proxy (core/pipeline.ts), so a client cannot choose it.
 */
import type { ApiKeyPrefix, ApiKeyScope } from "./types.ts";
import { parseCidr } from "../../core/net.ts";

// Shared with the rest of the engine (core/net.ts); still exported from here for existing callers.
export { ipAllowed, parseCidr } from "../../core/net.ts";

/** Longest life of an unrestricted key. Rotation (`zen api-keys rotate`) issues the next one. */
export const UNRESTRICTED_MAX_LIFETIME_DAYS = 90;

/** Whether `scopes` make a key equivalent to the master key. */
export function isUnrestricted(scopes: readonly string[]): boolean {
  return scopes.includes("*");
}

/** Thrown when a key would break the policy; its message is safe to return to the operator. */
export class ApiKeyPolicyError extends Error {
  override name = "ApiKeyPolicyError";
}

/**
 * Checks a key before it is created. `expiresAt` is the computed expiry (undefined = never).
 * Returns the normalized allowlist.
 */
export function checkKeyPolicy(opts: {
  prefix: ApiKeyPrefix;
  scopes: readonly ApiKeyScope[];
  allowedIps?: readonly string[];
  expiresAt?: string;
  now?: Date;
}): string[] {
  const allowedIps = [...new Set((opts.allowedIps ?? []).map((e) => e.trim()).filter(Boolean))];
  if (allowedIps.length > 100) throw new ApiKeyPolicyError("allowedIps: at most 100 entries.");
  for (const e of allowedIps) {
    if (!parseCidr(e)) throw new ApiKeyPolicyError(`allowedIps: "${e}" is not an IPv4/IPv6 address or CIDR range.`);
  }
  if (!isUnrestricted(opts.scopes)) return allowedIps;

  if (opts.prefix !== "sk") throw new ApiKeyPolicyError("Scope * is only for secret keys (sk). Give pk/rk keys explicit scopes.");
  if (allowedIps.length === 0) {
    throw new ApiKeyPolicyError("A key with scope * acts as the master key: it needs allowedIps (the addresses of your servers).");
  }
  if (allowedIps.some((e) => parseCidr(e)!.prefix === 0)) {
    throw new ApiKeyPolicyError("allowedIps for scope *: 0.0.0.0/0 and ::/0 allow everywhere; list your servers.");
  }
  const now = opts.now ?? new Date();
  const maxMs = UNRESTRICTED_MAX_LIFETIME_DAYS * 86_400_000;
  if (!opts.expiresAt || new Date(opts.expiresAt).getTime() - now.getTime() > maxMs) {
    throw new ApiKeyPolicyError(`A key with scope * must expire within ${UNRESTRICTED_MAX_LIFETIME_DAYS} days (expiresIn, e.g. "30d").`);
  }
  return allowedIps;
}
