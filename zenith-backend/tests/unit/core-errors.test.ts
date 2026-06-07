/**
 * Tests para core/errors.ts — ZenithError hierarchy and factory methods.
 *
 * Cubre:
 *   - ZenithErrorCode: enum coverage y valores numéricos estables
 *   - ZenithError: shape, httpStatus, toJSON, toResponse
 *   - ZenithErrors: cada factory method (código, status, mensaje)
 *   - Parse Server parity: códigos 100-160, 200-212
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { ZenithError, ZenithErrorCode, ZenithErrors } from "../../src/core/errors.ts";

// ─── ZenithErrorCode: Parse Server parity ────────────────────────────────────

Deno.test("ZenithErrorCode - Parse Server 100-series codes", () => {
  assertEquals(ZenithErrorCode.CONNECTION_FAILED, 100);
  assertEquals(ZenithErrorCode.OBJECT_NOT_FOUND, 101);
  assertEquals(ZenithErrorCode.INVALID_QUERY, 102);
  assertEquals(ZenithErrorCode.VALIDATION_ERROR, 142);
  assertEquals(ZenithErrorCode.REQUEST_LIMIT_EXCEEDED, 155);
});

Deno.test("ZenithErrorCode - Parse Server 200-series auth codes", () => {
  assertEquals(ZenithErrorCode.USERNAME_MISSING, 200);
  assertEquals(ZenithErrorCode.UNAUTHORIZED, 212);
});

Deno.test("ZenithErrorCode - Zenith extensions exist", () => {
  assertExists(ZenithErrorCode.LIVEQUERY_SOCKET_CLOSED);
  assertExists(ZenithErrorCode.STREAM_NOT_FOUND);
  assertExists(ZenithErrorCode.LDAP_CONNECTION_FAILED);
  assertExists(ZenithErrorCode.TRAIT_CONTRACT_VIOLATION);
  assertExists(ZenithErrorCode.SHELL_COMMAND_NOT_ALLOWED);
});

// ─── ZenithError class ───────────────────────────────────────────────────────

Deno.test("ZenithError - extends Error and has correct shape", () => {
  const err = new ZenithError(ZenithErrorCode.OBJECT_NOT_FOUND, "Object X not found", 404);
  assertEquals(err instanceof Error, true);
  assertEquals(err.name, "ZenithError");
  assertEquals(err.code, ZenithErrorCode.OBJECT_NOT_FOUND);
  assertEquals(err.httpStatus, 404);
  assertEquals(err.message, "Object X not found");
});

Deno.test("ZenithError - default httpStatus is 400", () => {
  const err = new ZenithError(ZenithErrorCode.INVALID_QUERY, "bad query");
  assertEquals(err.httpStatus, 400);
});

Deno.test("ZenithError - toJSON returns code + error", () => {
  const err = new ZenithError(ZenithErrorCode.OBJECT_NOT_FOUND, "missing", 404);
  const json = err.toJSON();
  assertEquals(json.code, 101);
  assertEquals(json.error, "missing");
});

Deno.test("ZenithError - toResponse returns JSON with status", async () => {
  const err = new ZenithError(ZenithErrorCode.OBJECT_NOT_FOUND, "no item", 404);
  const res = err.toResponse();
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  const body = await res.json();
  assertEquals(body.code, 101);
  assertEquals(body.error, "no item");
});

// ─── ZenithErrors factory: notFound ──────────────────────────────────────────

Deno.test("ZenithErrors.notFound - with objectId", () => {
  const err = ZenithErrors.notFound("Post", "abc123");
  assertEquals(err.code, ZenithErrorCode.OBJECT_NOT_FOUND);
  assertEquals(err.httpStatus, 404);
  assertStringIncludes(err.message, "Post");
  assertStringIncludes(err.message, "abc123");
});

Deno.test("ZenithErrors.notFound - without objectId", () => {
  const err = ZenithErrors.notFound("Post");
  assertEquals(err.httpStatus, 404);
  assertStringIncludes(err.message, "Post");
});

// ─── ZenithErrors factory: unauthorized / forbidden ──────────────────────────

Deno.test("ZenithErrors.unauthorized - default message", () => {
  const err = ZenithErrors.unauthorized();
  assertEquals(err.code, ZenithErrorCode.UNAUTHORIZED);
  assertEquals(err.httpStatus, 401);
});

Deno.test("ZenithErrors.unauthorized - custom reason", () => {
  const err = ZenithErrors.unauthorized("Token expired");
  assertStringIncludes(err.message, "Token expired");
});

Deno.test("ZenithErrors.forbidden - returns 403", () => {
  const err = ZenithErrors.forbidden("Cannot delete other users' posts");
  assertEquals(err.code, ZenithErrorCode.OPERATION_FORBIDDEN);
  assertEquals(err.httpStatus, 403);
});

// ─── ZenithErrors factory: rateLimited ───────────────────────────────────────

Deno.test("ZenithErrors.rateLimited - 429 status", () => {
  const err = ZenithErrors.rateLimited();
  assertEquals(err.code, ZenithErrorCode.REQUEST_LIMIT_EXCEEDED);
  assertEquals(err.httpStatus, 429);
});

// ─── ZenithErrors factory: traitContractViolation ───────────────────────────

Deno.test("ZenithErrors.traitContractViolation - mentions provider and consumer", () => {
  const err = ZenithErrors.traitContractViolation("mongo", "auth");
  assertEquals(err.httpStatus, 500);
  assertStringIncludes(err.message, "mongo");
  assertStringIncludes(err.message, "auth");
});

// ─── ZenithErrors factory: domain-specific ───────────────────────────────────

Deno.test("ZenithErrors.streamNotFound - 404", () => {
  const err = ZenithErrors.streamNotFound("stream-xyz");
  assertEquals(err.code, ZenithErrorCode.STREAM_NOT_FOUND);
  assertEquals(err.httpStatus, 404);
  assertStringIncludes(err.message, "stream-xyz");
});

Deno.test("ZenithErrors.ldapConnectionFailed - 503", () => {
  const err = ZenithErrors.ldapConnectionFailed("ldap.corp.local");
  assertEquals(err.code, ZenithErrorCode.LDAP_CONNECTION_FAILED);
  assertEquals(err.httpStatus, 503);
  assertStringIncludes(err.message, "ldap.corp.local");
});

Deno.test("ZenithErrors.liveQueryUnauthorized - 403", () => {
  const err = ZenithErrors.liveQueryUnauthorized("no subscription");
  assertEquals(err.code, ZenithErrorCode.LIVEQUERY_UNAUTHORIZED);
  assertEquals(err.httpStatus, 403);
});

// ─── ZenithErrors factory: validation ────────────────────────────────────────

Deno.test("ZenithErrors.validationFailed - 400", () => {
  const err = ZenithErrors.validationFailed("email is required");
  assertEquals(err.code, ZenithErrorCode.VALIDATION_ERROR);
  assertEquals(err.httpStatus, 400);
});

Deno.test("ZenithErrors.invalidQuery - 400", () => {
  const err = ZenithErrors.invalidQuery("bad where clause");
  assertEquals(err.code, ZenithErrorCode.INVALID_QUERY);
  assertEquals(err.httpStatus, 400);
});

// ─── ZenithErrors factory: api key + duplicate ───────────────────────────────

Deno.test("ZenithErrors.apiKeyInvalid - 401", () => {
  const err = ZenithErrors.apiKeyInvalid();
  assertEquals(err.code, ZenithErrorCode.UNAUTHORIZED);
  assertEquals(err.httpStatus, 401);
});

Deno.test("ZenithErrors.duplicate - with value (409)", () => {
  const err = ZenithErrors.duplicate("email", "alice@example.com");
  assertEquals(err.code, ZenithErrorCode.DUPLICATE_VALUE);
  assertEquals(err.httpStatus, 409);
  assertStringIncludes(err.message, "alice@example.com");
});

Deno.test("ZenithErrors.duplicate - without value (409)", () => {
  const err = ZenithErrors.duplicate("username");
  assertEquals(err.httpStatus, 409);
  assertStringIncludes(err.message, "username");
});

// ─── ZenithErrors factory: internal / invalidSession ─────────────────────────

Deno.test("ZenithErrors.internal - 500 default", () => {
  const err = ZenithErrors.internal();
  assertEquals(err.code, ZenithErrorCode.INTERNAL_SERVER_ERROR);
  assertEquals(err.httpStatus, 500);
});

Deno.test("ZenithErrors.invalidSession - 401", () => {
  const err = ZenithErrors.invalidSession();
  assertEquals(err.httpStatus, 401);
});
