/**
 * Tests para trust-store.ts — registro de claves de autor confiables.
 *
 * Cubre:
 *   - emptyTrustStore: shape vacío
 *   - findKey / findKeysByAuthor
 *   - addKey (lanzar si duplicado, mantener sort)
 *   - revokeKey (preserva key, agrega revokedAt)
 *   - removeKey (filtra)
 *   - validateTrustStore (errores de schema)
 *   - loadTrustStore / saveTrustStore (filesystem)
 */

import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import {
  addKey,
  emptyTrustStore,
  findKey,
  findKeysByAuthor,
  globalTrustPath,
  loadTrustStore,
  projectTrustPath,
  removeKey,
  revokeKey,
  saveTrustStore,
  validateTrustStore,
} from "../../src/security/plugin-signing/trust-store.ts";
import type { TrustedAuthorKey } from "../../src/security/plugin-signing/types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeKey(overrides: Partial<TrustedAuthorKey> = {}): TrustedAuthorKey {
  return {
    keyId: "acme-ed25519-AB12CD34",
    publicKey: "MCowBQYDK2VwAyEAR0dAcB7Cj8K0eV5mY2tD5hI5uV5c=",
    alg: "Ed25519",
    addedAt: "2026-01-01T00:00:00.000Z",
    addedBy: "user",
    ...overrides,
  } as TrustedAuthorKey;
}

// ─── Path helpers ───────────────────────────────────────────────────────────

Deno.test("trust-store - globalTrustPath uses HOME or USERPROFILE", () => {
  const path = globalTrustPath();
  assertEquals(path.includes(".zenith/trusted-keys.json"), true);
});

Deno.test("trust-store - projectTrustPath defaults to cwd", () => {
  const path = projectTrustPath();
  assertEquals(path.endsWith(".zenith/trusted-keys.json"), true);
});

Deno.test("trust-store - projectTrustPath accepts custom root", () => {
  const path = projectTrustPath("/tmp/myapp");
  assertEquals(path, "/tmp/myapp/.zenith/trusted-keys.json");
});

// ─── emptyTrustStore ────────────────────────────────────────────────────────

Deno.test("emptyTrustStore - returns version 1.0 with empty keys", () => {
  const store = emptyTrustStore();
  assertEquals(store.version, "1.0");
  assertEquals(store.keys, []);
});

// ─── findKey / findKeysByAuthor ─────────────────────────────────────────────

Deno.test("findKey - returns key by keyId", () => {
  const store = emptyTrustStore();
  const key = makeKey();
  const updated = addKey(store, key);
  const found = findKey(updated, key.keyId);
  assertEquals(found?.keyId, key.keyId);
});

Deno.test("findKey - returns undefined for unknown keyId", () => {
  const store = emptyTrustStore();
  const found = findKey(store, "unknown-ed25519-AB12CD34");
  assertEquals(found, undefined);
});

Deno.test("findKeysByAuthor - returns all keys for an author", () => {
  let store = emptyTrustStore();
  store = addKey(store, makeKey({ keyId: "acme-ed25519-AB12CD34" }));
  store = addKey(store, makeKey({ keyId: "acme-ed25519-12345678" }));
  store = addKey(store, makeKey({ keyId: "other-ed25519-AB12CD34" }));
  const acmeKeys = findKeysByAuthor(store, "acme");
  assertEquals(acmeKeys.length, 2);
  for (const k of acmeKeys) {
    assertEquals(k.keyId.startsWith("acme-"), true);
  }
});

// ─── addKey ─────────────────────────────────────────────────────────────────

Deno.test("addKey - adds key to empty store", () => {
  const store = emptyTrustStore();
  const updated = addKey(store, makeKey());
  assertEquals(updated.keys.length, 1);
});

Deno.test("addKey - keeps keys sorted by keyId", () => {
  let store = emptyTrustStore();
  store = addKey(store, makeKey({ keyId: "zebra-ed25519-AAAAAAAA" }));
  store = addKey(store, makeKey({ keyId: "alpha-ed25519-BBBBBBBB" }));
  store = addKey(store, makeKey({ keyId: "mike-ed25519-CCCCCCCC" }));
  assertEquals(store.keys[0].keyId, "alpha-ed25519-BBBBBBBB");
  assertEquals(store.keys[1].keyId, "mike-ed25519-CCCCCCCC");
  assertEquals(store.keys[2].keyId, "zebra-ed25519-AAAAAAAA");
});

Deno.test("addKey - throws on duplicate keyId", () => {
  let store = emptyTrustStore();
  const key = makeKey();
  store = addKey(store, key);
  assertThrows(() => addKey(store, key), Error, "already trusted");
});

Deno.test("addKey - does not mutate input store", () => {
  const store = emptyTrustStore();
  const key = makeKey();
  const updated = addKey(store, key);
  assertEquals(store.keys.length, 0);
  assertEquals(updated.keys.length, 1);
});

// ─── revokeKey ──────────────────────────────────────────────────────────────

Deno.test("revokeKey - adds revokedAt and revokedReason", () => {
  let store = emptyTrustStore();
  store = addKey(store, makeKey());
  const updated = revokeKey(store, "acme-ed25519-AB12CD34", "compromise");
  const key = findKey(updated, "acme-ed25519-AB12CD34");
  assertExists(key?.revokedAt);
  assertEquals(key?.revokedReason, "compromise");
});

Deno.test("revokeKey - does not remove key (only marks)", () => {
  let store = emptyTrustStore();
  store = addKey(store, makeKey());
  const updated = revokeKey(store, "acme-ed25519-AB12CD34", "test");
  assertEquals(updated.keys.length, 1);
});

// ─── removeKey ──────────────────────────────────────────────────────────────

Deno.test("removeKey - removes key by keyId", () => {
  let store = emptyTrustStore();
  store = addKey(store, makeKey());
  const updated = removeKey(store, "acme-ed25519-AB12CD34");
  assertEquals(updated.keys.length, 0);
});

Deno.test("removeKey - no-op if keyId not found", () => {
  let store = emptyTrustStore();
  store = addKey(store, makeKey());
  const updated = removeKey(store, "nonexistent-ed25519-00000000");
  assertEquals(updated.keys.length, 1);
});

// ─── validateTrustStore ─────────────────────────────────────────────────────

Deno.test("validateTrustStore - accepts empty store", () => {
  const result = validateTrustStore({ version: "1.0", keys: [] });
  assertEquals(result.version, "1.0");
  assertEquals(result.keys, []);
});

Deno.test("validateTrustStore - accepts well-formed store", () => {
  const result = validateTrustStore({
    version: "1.0",
    keys: [{
      keyId: "acme-ed25519-AB12CD34",
      publicKey: "MCowBQYDK2VwAyE...",
      alg: "Ed25519",
      addedAt: "2026-01-01T00:00:00Z",
      addedBy: "user",
    }],
  });
  assertEquals(result.keys.length, 1);
});

Deno.test("validateTrustStore - rejects non-1.0 version", () => {
  assertThrows(
    () => validateTrustStore({ version: "2.0", keys: [] }),
    Error,
    "Unsupported trust store version",
  );
});

Deno.test("validateTrustStore - rejects missing keys array", () => {
  assertThrows(
    () => validateTrustStore({ version: "1.0" }),
    Error,
    "keys must be an array",
  );
});

Deno.test("validateTrustStore - rejects duplicate keyId", () => {
  const k = {
    keyId: "acme-ed25519-AB12CD34",
    publicKey: "x",
    alg: "Ed25519",
    addedAt: "2026-01-01T00:00:00Z",
    addedBy: "user",
  };
  assertThrows(
    () => validateTrustStore({ version: "1.0", keys: [k, k] }),
    Error,
    "Duplicate keyId",
  );
});

Deno.test("validateTrustStore - rejects non-Ed25519 alg", () => {
  const k = {
    keyId: "acme-ed25519-AB12CD34",
    publicKey: "x",
    alg: "RSA",
    addedAt: "2026-01-01T00:00:00Z",
    addedBy: "user",
  };
  assertThrows(
    () => validateTrustStore({ version: "1.0", keys: [k] }),
    Error,
    "Unsupported alg",
  );
});

Deno.test("validateTrustStore - rejects invalid addedBy", () => {
  const k = {
    keyId: "acme-ed25519-AB12CD34",
    publicKey: "x",
    alg: "Ed25519",
    addedAt: "2026-01-01T00:00:00Z",
    addedBy: "anonymous",
  };
  assertThrows(
    () => validateTrustStore({ version: "1.0", keys: [k] }),
    Error,
    "addedBy must be",
  );
});

Deno.test("validateTrustStore - accepts all valid addedBy values", () => {
  for (const addedBy of ["user", "root", "tofu"]) {
    const k = {
      keyId: `acme-ed25519-${addedBy.toUpperCase().padEnd(8, "0").slice(0, 8)}`,
      publicKey: "x",
      alg: "Ed25519",
      addedAt: "2026-01-01T00:00:00Z",
      addedBy,
    };
    const result = validateTrustStore({ version: "1.0", keys: [k] });
    assertEquals(result.keys.length, 1);
  }
});

// ─── Persistence: load/save ─────────────────────────────────────────────────

Deno.test("saveTrustStore + loadTrustStore roundtrip", async () => {
  const tmp = await Deno.makeTempDir();
  const path = `${tmp}/trusted-keys.json`;
  try {
    const original = addKey(emptyTrustStore(), makeKey());
    await saveTrustStore(path, original);
    const loaded = await loadTrustStore(path);
    assertEquals(loaded.keys.length, 1);
    assertEquals(loaded.keys[0].keyId, original.keys[0].keyId);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("loadTrustStore - returns empty store if file does not exist", async () => {
  const result = await loadTrustStore("/nonexistent/path/trusted-keys.json");
  assertEquals(result.keys.length, 0);
});

Deno.test("loadTrustStore - rejects invalid JSON schema", async () => {
  const tmp = await Deno.makeTempDir();
  const path = `${tmp}/bad.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify({ version: "2.0", keys: [] }));
    await assertRejects(
      () => loadTrustStore(path),
      Error,
      "Unsupported trust store version",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("saveTrustStore - creates parent directory if missing", async () => {
  const tmp = await Deno.makeTempDir();
  const path = `${tmp}/.zenith/trusted-keys.json`;
  try {
    await saveTrustStore(path, emptyTrustStore());
    const exists = await Deno.stat(path).then(() => true).catch(() => false);
    assertEquals(exists, true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
