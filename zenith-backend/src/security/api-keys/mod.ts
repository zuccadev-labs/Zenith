/**
 * @module @zenith/security/api-keys
 *
 * Sistema de API Keys estilo Stripe.
 *
 * Exports:
 *   - Types:    ApiKeyRecord, ApiKeyCreateOptions, etc.
 *   - Scopes:   hasScope, hasAllScopes, DEFAULT_SCOPES, DEFAULT_RATE_LIMITS
 *   - Manager:  ApiKeyManager, hashSecret, verifySecret, parseKey, buildKey
 *   - Store:    InMemoryStore, MongoDBStore (stub)
 *   - Audit:    audit.created, audit.verified, audit.rejected, ...
 *   - MW:       extractAndVerifyKey, requireScope, PerKeyRateLimiter
 *
 * @example
 * ```ts
 * import { ApiKeyManager, InMemoryStore, DEFAULT_SCOPES } from "@zenith/security/api-keys";
 *
 * const manager = new ApiKeyManager(new InMemoryStore());
 * const { record, plaintext } = await manager.create({
 *   appId: "myAppId1",
 *   prefix: "sk",
 *   env: "live",
 *   scopes: DEFAULT_SCOPES.sk,
 *   name: "Production server #1",
 *   createdBy: "admin:zucca",
 *   expiresIn: "90d",
 * });
 *
 * console.log("Save this key — it will NOT be shown again:");
 * console.log(plaintext);
 * ```
 */

export * from "./types.ts";
export * from "./scopes.ts";
export * from "./manager.ts";
export * from "./store.ts";
export * from "./audit.ts";
export * from "./middleware.ts";
export * from "./bootstrap.ts";
