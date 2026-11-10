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

/** Longest life of an unrestricted key. Rotation (`zen api-keys rotate`) issues the next one. */
export const UNRESTRICTED_MAX_LIFETIME_DAYS = 90;

/** Whether `scopes` make a key equivalent to the master key. */
export function isUnrestricted(scopes: readonly string[]): boolean {
  return scopes.includes("*");
}

type Parsed = { v: 4 | 6; bits: bigint };

function parseIPv4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255 || (p.length > 1 && p.startsWith("0"))) return null;
    n = (n << 8n) | BigInt(Number(p));
  }
  return n;
}

function parseIPv6(input: string): bigint | null {
  let s = input;
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.split("::").length > 2) return null;
  // An embedded IPv4 tail (::ffff:192.0.2.1) is the last two groups.
  const tail: number[] = [];
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":");
    const v4 = parseIPv4(s.slice(cut + 1));
    if (v4 === null) return null;
    tail.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
    s = s.slice(0, cut + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const compressed = s.includes("::");
  const [head, rest = ""] = compressed ? s.split("::") : [s];
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const h = groups(head), r = groups(rest);
  if ([...h, ...r].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const known = h.length + r.length + tail.length;
  if (compressed ? known > 7 : known !== 8) return null;
  const all = [...h.map((g) => parseInt(g, 16)), ...Array<number>(8 - known).fill(0), ...r.map((g) => parseInt(g, 16)), ...tail];
  return all.reduce((n, g) => (n << 16n) | BigInt(g), 0n);
}

/** An address as a number; IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as IPv4. */
function parseIp(s: string): Parsed | null {
  const v4 = parseIPv4(s);
  if (v4 !== null) return { v: 4, bits: v4 };
  const v6 = parseIPv6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v: 4, bits: v6 & 0xffffffffn };
  return { v: 6, bits: v6 };
}

/** `203.0.113.7`, `198.51.100.0/24`, `2001:db8::/32`… → network and prefix length; null if invalid. */
export function parseCidr(entry: string): { v: 4 | 6; network: bigint; prefix: number } | null {
  const [addr, len, extra] = entry.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  const prefix = len === undefined ? width : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return null;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix);
  return { v: ip.v, network: ip.bits & mask, prefix };
}

/** Whether `ip` falls in any entry of `allowlist`. An unparseable `ip` never matches. */
export function ipAllowed(ip: string | undefined, allowlist: readonly string[]): boolean {
  const parsed = ip ? parseIp(ip) : null;
  if (!parsed) return false;
  for (const entry of allowlist) {
    const net = parseCidr(entry);
    if (!net || net.v !== parsed.v) continue;
    const width = net.v === 4 ? 32 : 128;
    const mask = net.prefix === 0 ? 0n : ((1n << BigInt(net.prefix)) - 1n) << BigInt(width - net.prefix);
    if ((parsed.bits & mask) === net.network) return true;
  }
  return false;
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
