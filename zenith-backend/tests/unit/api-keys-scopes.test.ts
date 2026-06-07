/**
 * Tests para scopes.ts — jerarquía y verificación de scopes.
 *
 * Cubre:
 *   - hasScope: *, recurso:*, recurso:accion
 *   - hasAllScopes / hasAnyScope (AND / OR)
 *   - normalizeScopes: dedup, wildcard, sub-wildcard
 *   - DEFAULT_SCOPES y DEFAULT_RATE_LIMITS
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_RATE_LIMITS,
  DEFAULT_SCOPES,
  hasAllScopes,
  hasAnyScope,
  hasScope,
  normalizeScopes,
} from "../../src/security/api-keys/scopes.ts";

// ─── hasScope: exact match ──────────────────────────────────────────────────

Deno.test("hasScope - exact match returns true", () => {
  assertEquals(hasScope(["data:read"], "data:read"), true);
});

Deno.test("hasScope - no match returns false", () => {
  assertEquals(hasScope(["data:read"], "data:write"), false);
});

Deno.test("hasScope - empty granted returns false", () => {
  assertEquals(hasScope([], "data:read"), false);
});

// ─── hasScope: wildcard * ───────────────────────────────────────────────────

Deno.test("hasScope - * covers any required scope", () => {
  assertEquals(hasScope(["*"], "data:read"), true);
  assertEquals(hasScope(["*"], "admin:write"), true);
  assertEquals(hasScope(["*"], "admin:read"), true);
});

Deno.test("hasScope - * in middle of list still grants all", () => {
  assertEquals(hasScope(["data:read", "*", "users:write"], "files:read"), true);
});

// ─── hasScope: resource wildcard `recurso:*` ────────────────────────────────

Deno.test("hasScope - data:* covers data:read and data:write", () => {
  assertEquals(hasScope(["data:*"], "data:read"), true);
  assertEquals(hasScope(["data:*"], "data:write"), true);
  assertEquals(hasScope(["data:*"], "data:delete"), true);
});

Deno.test("hasScope - data:* does NOT cover users:read", () => {
  assertEquals(hasScope(["data:*"], "users:read"), false);
});

Deno.test("hasScope - data:* DOES cover the bare resource name 'data'", () => {
  // Implementation: resource:* matches both `resource:something` and bare `resource`.
  assertEquals(hasScope(["data:*"], "data" as any), true);
});

// ─── hasAllScopes (AND) ─────────────────────────────────────────────────────

Deno.test("hasAllScopes - requires all scopes", () => {
  assertEquals(hasAllScopes(["data:read", "data:write"], ["data:read", "data:write"]), true);
  assertEquals(hasAllScopes(["data:read"], ["data:read", "data:write"]), false);
  assertEquals(hasAllScopes([], ["data:read"]), false);
});

Deno.test("hasAllScopes - empty required always passes", () => {
  assertEquals(hasAllScopes([], []), true);
  assertEquals(hasAllScopes(["data:read"], []), true);
});

Deno.test("hasAllScopes - * satisfies multiple required", () => {
  assertEquals(hasAllScopes(["*"], ["data:read", "users:write", "files:delete"]), true);
});

// ─── hasAnyScope (OR) ───────────────────────────────────────────────────────

Deno.test("hasAnyScope - passes if any one is granted", () => {
  assertEquals(hasAnyScope(["data:read"], ["data:read", "data:write"]), true);
  assertEquals(hasAnyScope(["data:write"], ["data:read", "data:write"]), true);
  assertEquals(hasAnyScope(["admin:read"], ["data:read", "data:write"]), false);
});

Deno.test("hasAnyScope - empty required returns false (no required = no grant)", () => {
  // Array.some() on empty array is false, which means: no required scope = none granted.
  // This is fail-closed behavior; callers must pass at least one required scope.
  assertEquals(hasAnyScope([], []), false);
});

// ─── normalizeScopes ────────────────────────────────────────────────────────

Deno.test("normalizeScopes - deduplicates", () => {
  assertEquals(
    normalizeScopes(["data:read", "data:read", "data:write"]),
    ["data:read", "data:write"],
  );
});

Deno.test("normalizeScopes - * wins over specifics", () => {
  const result = normalizeScopes(["data:read", "data:write", "*", "users:read"]);
  assertEquals(result, ["*"]);
});

Deno.test("normalizeScopes - resource:* removes specific sub-scopes", () => {
  const result = normalizeScopes(["data:read", "data:write", "data:*"]);
  assertEquals(result, ["data:*"]);
});

Deno.test("normalizeScopes - resource:* does not affect other resources", () => {
  const result = normalizeScopes(["data:read", "users:write", "data:*"]);
  // data:read collapsed under data:*, users:write preserved
  assertEquals(result.includes("data:*"), true);
  assertEquals(result.includes("users:write"), true);
});

Deno.test("normalizeScopes - empty input", () => {
  assertEquals(normalizeScopes([]), []);
});

// ─── DEFAULT_SCOPES invariants ──────────────────────────────────────────────

Deno.test("DEFAULT_SCOPES - sk (server) has full data + users + files + functions", () => {
  const sk = DEFAULT_SCOPES.sk;
  assertEquals(sk.includes("data:read"), true);
  assertEquals(sk.includes("data:write"), true);
  assertEquals(sk.includes("users:read"), true);
  assertEquals(sk.includes("users:write"), true);
  assertEquals(sk.includes("files:read"), true);
  assertEquals(sk.includes("functions:invoke"), true);
});

Deno.test("DEFAULT_SCOPES - pk (publishable) is read-only", () => {
  const pk = DEFAULT_SCOPES.pk;
  assertEquals(pk.includes("data:read"), true);
  assertEquals(pk.includes("data:write"), false);
  assertEquals(pk.includes("users:write"), false);
  assertEquals(pk.includes("files:write"), false);
});

Deno.test("DEFAULT_SCOPES - rk (restricted) is single scope", () => {
  const rk = DEFAULT_SCOPES.rk;
  assertEquals(rk.length, 1);
  assertEquals(rk[0], "analytics:read");
});

Deno.test("DEFAULT_SCOPES - pk scopes are subset of sk scopes (least-privilege)", () => {
  for (const scope of DEFAULT_SCOPES.pk) {
    assertEquals(
      DEFAULT_SCOPES.sk.includes(scope),
      true,
      `pk scope '${scope}' must be in sk scopes`,
    );
  }
});

// ─── DEFAULT_RATE_LIMITS invariants ─────────────────────────────────────────

Deno.test("DEFAULT_RATE_LIMITS - pk > sk > rk (publishable has highest volume for read-only)", () => {
  // Publishable key (pk) is for public clients doing many read requests, so it
  // gets the highest rate limit. Server key (sk) is lower. Restricted (rk) is lowest.
  assertEquals(DEFAULT_RATE_LIMITS.pk > DEFAULT_RATE_LIMITS.sk, true);
  assertEquals(DEFAULT_RATE_LIMITS.sk > DEFAULT_RATE_LIMITS.rk, true);
});

Deno.test("DEFAULT_RATE_LIMITS - all positive", () => {
  assertEquals(DEFAULT_RATE_LIMITS.sk > 0, true);
  assertEquals(DEFAULT_RATE_LIMITS.pk > 0, true);
  assertEquals(DEFAULT_RATE_LIMITS.rk > 0, true);
});
