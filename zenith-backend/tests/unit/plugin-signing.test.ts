/**
 * Tests del sistema de plugin signing (Ed25519 + JCS + TrustStore).
 *
 * Cobertura:
 *   - keys.ts: keygen, fingerprint, sign+verify roundtrip, invalid sizes
 *   - canonical.ts: key ordering, escape, edge cases
 *   - manifest.ts: build, sign, parse, validate
 *   - trust-store.ts: add, find, revoke, save/load roundtrip
 *   - verifier.ts: end-to-end happy path + todas las failure modes
 */

import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildKeyId,
  buildPluginArtifact,
  canonicalJson,
  emptyTrustStore,
  fingerprint,
  fingerprintShort,
  generateKeyPair,
  importPrivateRaw,
  importPublicRaw,
  loadTrustStore,
  parseManifest,
  removeKey,
  revokeKey,
  saveTrustStore,
  sign,
  signPlugin,
  validateManifest,
  validatePublicKey,
  verify,
  verifyPlugin,
  verifyPluginSignature,
  type SignedPluginManifest,
  type TrustStore,
  addKey,
} from "../../src/security/plugin-signing/mod.ts";

// ── helpers ────────────────────────────────────────────────────────────────

async function tmpDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "zenith-pluginsig-" });
}

async function newKeyPair() {
  return await generateKeyPair();
}

Deno.test("keys.ts: generateKeyPair produces SPKI/PKCS8 base64 keys", async () => {
  const kp = await newKeyPair();
  // SPKI Ed25519 = 44 bytes raw → 60 chars base64
  // PKCS8 Ed25519 = 48 bytes raw → 64 chars base64
  assertEquals(kp.publicKey.length, 60);
  assertEquals(kp.privateKey.length, 64);
});

Deno.test("keys.ts: fingerprint is stable and prefixed with ed25519:", async () => {
  const kp = await newKeyPair();
  const fp1 = fingerprint(kp.publicKey);
  const fp2 = fingerprint(kp.publicKey);
  assertEquals(fp1, fp2);
  assertStringIncludes(fp1, "ed25519:");
  // 4 hex pairs separated by colons = "ed25519:" + 4*2 + 3 colons = 8+8+3 = 19
  assertEquals(fp1.length, 19);
});

Deno.test("keys.ts: fingerprintShort returns 8 uppercase hex chars", async () => {
  const kp = await newKeyPair();
  const short = fingerprintShort(kp.publicKey);
  assertEquals(short.length, 8);
  assertEquals(short, short.toUpperCase());
  assertEquals(short, /^[A-F0-9]{8}$/.test(short) ? short : "");
});

Deno.test("keys.ts: buildKeyId follows `<author>-ed25519-<8hex>`", async () => {
  const kp = await newKeyPair();
  const id = buildKeyId("acme-corp", kp.publicKey);
  assertStringIncludes(id, "acme-corp-ed25519-");
  assertEquals(id.length, "acme-corp-ed25519-".length + 8);
});

Deno.test("keys.ts: sign+verify roundtrip succeeds", async () => {
  const kp = await newKeyPair();
  const msg = new TextEncoder().encode("hello world");
  const sig = await sign(await importPrivateRaw(kp.privateKey), msg);
  assertEquals(sig.length, 88); // 64 bytes base64
  const ok = await verify(await importPublicRaw(kp.publicKey), msg, sig);
  assertEquals(ok, true);
});

Deno.test("keys.ts: verify rejects tampered message", async () => {
  const kp = await newKeyPair();
  const msg = new TextEncoder().encode("hello");
  const sig = await sign(await importPrivateRaw(kp.privateKey), msg);
  const tampered = new TextEncoder().encode("hellp"); // typo
  const ok = await verify(await importPublicRaw(kp.publicKey), tampered, sig);
  assertEquals(ok, false);
});

Deno.test("keys.ts: sign with key A does not verify with key B", async () => {
  const a = await newKeyPair();
  const b = await newKeyPair();
  const msg = new TextEncoder().encode("data");
  const sig = await sign(await importPrivateRaw(a.privateKey), msg);
  const ok = await verify(await importPublicRaw(b.publicKey), msg, sig);
  assertEquals(ok, false);
});

Deno.test("keys.ts: importing malformed public key throws", async () => {
  const bad = btoa("not-a-valid-spki-structure");
  await assertRejects(
    async () => importPublicRaw(bad),
    Error,
  );
});

Deno.test("keys.ts: verify rejects wrong-size signature", async () => {
  const kp = await newKeyPair();
  const msg = new TextEncoder().encode("x");
  const badSig = btoa("x".repeat(63)); // 63 bytes
  await assertRejects(
    async () => verify(await importPublicRaw(kp.publicKey), msg, badSig),
    Error,
  );
});

Deno.test("canonical.ts: object keys are sorted lexicographically", () => {
  const a = canonicalJson({ b: 1, a: 2, c: 3 });
  const b = canonicalJson({ c: 3, a: 2, b: 1 });
  assertEquals(a, b);
  assertEquals(a, `{"a":2,"b":1,"c":3}`);
});

Deno.test("canonical.ts: no whitespace in output", () => {
  const out = canonicalJson({ a: 1, b: [1, 2, 3], c: "x" });
  assertEquals(out.includes(" "), false);
  assertEquals(out.includes("\n"), false);
  assertEquals(out.includes("\t"), false);
});

Deno.test("canonical.ts: escapes special chars in strings", () => {
  const out = canonicalJson("a\"b\nc\td");
  assertEquals(out, `"a\\"b\\nc\\td"`);
});

Deno.test("canonical.ts: arrays preserve order", () => {
  const a = canonicalJson([3, 1, 2]);
  const b = canonicalJson([1, 2, 3]);
  assertEquals(a, "[3,1,2]");
  assertEquals(b, "[1,2,3]");
  assertEquals(a !== b, true);
});

Deno.test("manifest.ts: buildPluginArtifact validates inputs", () => {
  const valid = buildPluginArtifact({
    name: "crm.plugin.ts",
    version: "1.2.3",
    sha256: "a".repeat(64),
    size: 100,
    permissions: ["data:read"],
    author: { id: "acme", keyId: "acme-ed25519-DEADBEEF" },
  });
  assertEquals(valid.name, "crm.plugin.ts");
  assertEquals(valid.permissions[0], "data:read");

  // Invalid name
  let threw = false;
  try {
    buildPluginArtifact({ ...valid, name: "../etc/passwd" });
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "Invalid plugin name");
  }
  assertEquals(threw, true);

  // Invalid semver
  threw = false;
  try {
    buildPluginArtifact({ ...valid, version: "not-semver" });
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "Invalid semver");
  }
  assertEquals(threw, true);

  // Invalid SHA
  threw = false;
  try {
    buildPluginArtifact({ ...valid, sha256: "tooshort" });
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "Invalid SHA-256");
  }
  assertEquals(threw, true);
});

Deno.test("manifest.ts: signPlugin + verifyPluginSignature roundtrip", async () => {
  const kp = await newKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);
  const artifact = buildPluginArtifact({
    name: "test.plugin.ts",
    version: "0.1.0",
    sha256: "b".repeat(64),
    size: 200,
    permissions: ["data:read", "data:write"],
    author: { id: "acme", keyId },
  });
  const manifest = await signPlugin({
    artifact,
    privateKeyB64: kp.privateKey,
    authorId: "acme",
    keyId,
  });
  assertEquals(manifest.manifestVersion, "1.0");
  assertEquals(manifest.signature.alg, "Ed25519");
  assertEquals(manifest.signature.keyId, keyId);

  const ok = await verifyPluginSignature({
    manifest,
    publicKeyB64: kp.publicKey,
  });
  assertEquals(ok, true);
});

Deno.test("manifest.ts: signPlugin throws on keyId mismatch", async () => {
  const kp = await newKeyPair();
  const correctKeyId = buildKeyId("acme", kp.publicKey);
  const wrongKeyId = "acme-ed25519-00000000";
  const artifact = buildPluginArtifact({
    name: "x.ts",
    version: "1.0.0",
    sha256: "c".repeat(64),
    size: 1,
    permissions: [],
    author: { id: "acme", keyId: wrongKeyId },
  });
  let threw = false;
  try {
    await signPlugin({
      artifact,
      privateKeyB64: kp.privateKey,
      authorId: "acme",
      keyId: correctKeyId,
    });
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "keyId mismatch");
  }
  assertEquals(threw, true);
});

Deno.test("manifest.ts: parseManifest validates and parses valid JSON", async () => {
  const kp = await newKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);
  const artifact = buildPluginArtifact({
    name: "p.ts",
    version: "1.0.0",
    sha256: "d".repeat(64),
    size: 5,
    permissions: [],
    author: { id: "acme", keyId },
  });
  const manifest = await signPlugin({
    artifact,
    privateKeyB64: kp.privateKey,
    authorId: "acme",
    keyId,
  });
  const json = JSON.stringify(manifest);
  const parsed = parseManifest(json);
  assertEquals(parsed.plugin.name, "p.ts");
});

Deno.test("manifest.ts: parseManifest rejects bad manifestVersion", () => {
  let threw = false;
  try {
    parseManifest(JSON.stringify({
      manifestVersion: "2.0",
      plugin: {},
      signature: {},
    }));
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "manifestVersion");
  }
  assertEquals(threw, true);
});

Deno.test("manifest.ts: validateManifest rejects mismatched keyId in sig vs author", () => {
  let threw = false;
  try {
    validateManifest({
      manifestVersion: "1.0",
      plugin: {
        name: "x.ts",
        version: "1.0.0",
        sha256: "e".repeat(64),
        size: 1,
        permissions: [],
        author: { id: "a", keyId: "a-ed25519-00000000" },
      },
      signature: {
        alg: "Ed25519",
        keyId: "a-ed25519-11111111",
        value: "x",
        signedAt: "2024-01-01T00:00:00Z",
      },
    });
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "keyId");
  }
  assertEquals(threw, true);
});

Deno.test("trust-store.ts: addKey + findKey", () => {
  const store = emptyTrustStore();
  const kp = { keyId: "acme-ed25519-12345678", publicKey: "x", alg: "Ed25519" as const, addedAt: "2024", addedBy: "user" as const };
  const updated = addKey(store, kp);
  const found = updated.keys.find((x) => x.keyId === kp.keyId);
  assertExists(found);
});

Deno.test("trust-store.ts: addKey throws on duplicate", () => {
  const store = emptyTrustStore();
  const k = { keyId: "a-ed25519-00000000", publicKey: "x", alg: "Ed25519" as const, addedAt: "t", addedBy: "user" as const };
  const added = addKey(store, k);
  let threw = false;
  try {
    addKey(added, k);
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "already trusted");
  }
  assertEquals(threw, true);
});

Deno.test("trust-store.ts: revokeKey marks revokedAt", () => {
  const store = emptyTrustStore();
  const k = { keyId: "a-ed25519-00000000", publicKey: "x", alg: "Ed25519" as const, addedAt: "t", addedBy: "user" as const };
  const added = addKey(store, k);
  const revoked = revokeKey(added, k.keyId, "compromised");
  const found = revoked.keys.find((x) => x.keyId === k.keyId);
  assertExists(found?.revokedAt);
  assertEquals(found?.revokedReason, "compromised");
});

Deno.test("trust-store.ts: removeKey removes completely", () => {
  const store = emptyTrustStore();
  const k = { keyId: "a-ed25519-00000000", publicKey: "x", alg: "Ed25519" as const, addedAt: "t", addedBy: "user" as const };
  const added = addKey(store, k);
  const removed = removeKey(added, k.keyId);
  assertEquals(removed.keys.length, 0);
});

Deno.test("trust-store.ts: saveTrustStore + loadTrustStore roundtrip", async () => {
  const dir = await tmpDir();
  const path = join(dir, "sub", "store.json");
  const k = { keyId: "a-ed25519-00000000", publicKey: "abc", alg: "Ed25519" as const, addedAt: "2024", addedBy: "user" as const };
  const store = addKey(emptyTrustStore(), k);
  await saveTrustStore(path, store);

  const loaded = await loadTrustStore(path);
  assertEquals(loaded.keys.length, 1);
  assertEquals(loaded.keys[0].keyId, k.keyId);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("trust-store.ts: loadTrustStore returns empty for missing file", async () => {
  const loaded = await loadTrustStore("/tmp/zenith-nonexistent-" + crypto.randomUUID() + ".json");
  assertEquals(loaded.keys.length, 0);
});

Deno.test("verifier.ts: happy path — valid signed plugin passes", async () => {
  const kp = await newKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);

  // Crear archivo de plugin
  const dir = await tmpDir();
  const pluginPath = join(dir, "test.plugin.ts");
  const content = new TextEncoder().encode("// plugin code\nconst x = 1;\n");
  await Deno.writeFile(pluginPath, content);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(content).digest("hex");

  const artifact = buildPluginArtifact({
    name: "test.plugin.ts",
    version: "1.0.0",
    sha256: sha,
    size: content.byteLength,
    permissions: ["data:read"],
    author: { id: "acme", keyId },
  });
  const manifest = await signPlugin({
    artifact,
    privateKeyB64: kp.privateKey,
    authorId: "acme",
    keyId,
  });

  const trust = addKey(emptyTrustStore(), {
    keyId,
    publicKey: kp.publicKey,
    alg: "Ed25519",
    addedAt: new Date().toISOString(),
    addedBy: "user",
  });

  const result = await verifyPlugin({ pluginPath, manifest, trust });
  if (!result.ok) console.error("DEBUG result:", JSON.stringify(result, null, 2));
  assertEquals(result.ok, true);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("verifier.ts: rejects plugin_name_mismatch", async () => {
  const kp = await newKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);
  const dir = await tmpDir();
  const pluginPath = join(dir, "real.ts");
  await Deno.writeFile(pluginPath, new TextEncoder().encode("x"));
  const sha = "f".repeat(64);
  const artifact = buildPluginArtifact({
    name: "fake.ts", // mismatch
    version: "1.0.0",
    sha256: sha,
    size: 1,
    permissions: [],
    author: { id: "acme", keyId },
  });
  const manifest = await signPlugin({
    artifact,
    privateKeyB64: kp.privateKey,
    authorId: "acme",
    keyId,
  });
  const trust = addKey(emptyTrustStore(), {
    keyId, publicKey: kp.publicKey, alg: "Ed25519",
    addedAt: new Date().toISOString(), addedBy: "user",
  });

  const result = await verifyPlugin({ pluginPath, manifest, trust });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "plugin_name_mismatch");

  await Deno.remove(dir, { recursive: true });
});

Deno.test("verifier.ts: rejects key_not_trusted", async () => {
  const kp = await newKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);
  const dir = await tmpDir();
  const pluginPath = join(dir, "x.ts");
  await Deno.writeFile(pluginPath, new TextEncoder().encode("y"));
  const sha = "1".repeat(64);
  const artifact = buildPluginArtifact({
    name: "x.ts",
    version: "1.0.0",
    sha256: sha,
    size: 1,
    permissions: [],
    author: { id: "acme", keyId },
  });
  const manifest = await signPlugin({
    artifact,
    privateKeyB64: kp.privateKey,
    authorId: "acme",
    keyId,
  });
  // Trust store NO contiene esta key
  const result = await verifyPlugin({
    pluginPath, manifest, trust: emptyTrustStore(),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "key_not_trusted");

  await Deno.remove(dir, { recursive: true });
});

Deno.test("verifier.ts: rejects key_revoked by default", async () => {
  const kp = await newKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);
  const dir = await tmpDir();
  const pluginPath = join(dir, "x.ts");
  const content = new TextEncoder().encode("y");
  await Deno.writeFile(pluginPath, content);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(content).digest("hex");
  const artifact = buildPluginArtifact({
    name: "x.ts", version: "1.0.0", sha256: sha, size: content.byteLength,
    permissions: [], author: { id: "acme", keyId },
  });
  const manifest = await signPlugin({
    artifact, privateKeyB64: kp.privateKey, authorId: "acme", keyId,
  });
  const trust = revokeKey(addKey(emptyTrustStore(), {
    keyId, publicKey: kp.publicKey, alg: "Ed25519",
    addedAt: new Date().toISOString(), addedBy: "user",
  }), keyId, "compromised");

  const result = await verifyPlugin({ pluginPath, manifest, trust });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "key_revoked");

  // Con allowRevoked=true, pasa
  const result2 = await verifyPlugin({ pluginPath, manifest, trust, allowRevoked: true });
  assertEquals(result2.ok, true);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("verifier.ts: rejects signature_invalid (wrong key in trust store)", async () => {
  const kpA = await newKeyPair();
  const kpB = await newKeyPair();
  const keyIdA = buildKeyId("acme", kpA.publicKey);
  const dir = await tmpDir();
  const pluginPath = join(dir, "x.ts");
  const content = new TextEncoder().encode("y");
  await Deno.writeFile(pluginPath, content);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(content).digest("hex");
  // Manifest firmado con A
  const artifact = buildPluginArtifact({
    name: "x.ts", version: "1.0.0", sha256: sha, size: content.byteLength,
    permissions: [], author: { id: "acme", keyId: keyIdA },
  });
  const manifest = await signPlugin({
    artifact, privateKeyB64: kpA.privateKey, authorId: "acme", keyId: keyIdA,
  });
  // Trust store tiene keyIdA pero apunta a la clave de B
  const trust = addKey(emptyTrustStore(), {
    keyId: keyIdA,
    publicKey: kpB.publicKey, // ← wrong
    alg: "Ed25519",
    addedAt: new Date().toISOString(),
    addedBy: "user",
  });
  const result = await verifyPlugin({ pluginPath, manifest, trust });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "signature_invalid");

  await Deno.remove(dir, { recursive: true });
});

Deno.test("verifier.ts: rejects plugin_sha256_mismatch (tampered file)", async () => {
  const kp = await newKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);
  const dir = await tmpDir();
  const pluginPath = join(dir, "x.ts");
  // Firmamos con un hash
  const claimedSha = "0".repeat(64);
  const artifact = buildPluginArtifact({
    name: "x.ts", version: "1.0.0", sha256: claimedSha, size: 100,
    permissions: [], author: { id: "acme", keyId },
  });
  const manifest = await signPlugin({
    artifact, privateKeyB64: kp.privateKey, authorId: "acme", keyId,
  });
  // Pero escribimos un archivo con contenido diferente
  const content = new TextEncoder().encode("malicious code");
  await Deno.writeFile(pluginPath, content);
  const trust = addKey(emptyTrustStore(), {
    keyId, publicKey: kp.publicKey, alg: "Ed25519",
    addedAt: new Date().toISOString(), addedBy: "user",
  });
  const result = await verifyPlugin({ pluginPath, manifest, trust });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "plugin_sha256_mismatch");

  await Deno.remove(dir, { recursive: true });
});

Deno.test("verifier.ts: rejects manifest_malformed", async () => {
  const kp = await newKeyPair();
  const keyId = buildKeyId("acme", kp.publicKey);
  const dir = await tmpDir();
  const pluginPath = join(dir, "x.ts");
  await Deno.writeFile(pluginPath, new TextEncoder().encode("y"));
  const broken = {
    manifestVersion: "1.0",
    plugin: null, // ← invalid
    signature: { alg: "Ed25519", keyId, value: "x", signedAt: "2024" },
  } as unknown as SignedPluginManifest;
  const result = await verifyPlugin({
    pluginPath, manifest: broken, trust: emptyTrustStore(),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "manifest_malformed");

  await Deno.remove(dir, { recursive: true });
});

Deno.test("verifier.ts: validatePublicKey accepts valid, rejects invalid", async () => {
  const kp = await newKeyPair();
  assertEquals(await validatePublicKey(kp.publicKey), true);
  assertEquals(await validatePublicKey("not-base64-or-wrong-size"), false);
});

Deno.test("integration: full lifecycle (keygen → sign → trust → verify → revoke → reject)", async () => {
  // 1. Author genera claves
  const author = await generateKeyPair();
  const keyId = buildKeyId("acme-corp", author.publicKey);

  // 2. Author crea plugin y lo firma
  const dir = await tmpDir();
  const pluginPath = join(dir, "crm.plugin.ts");
  const code = new TextEncoder().encode("export default function(){}");
  await Deno.writeFile(pluginPath, code);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(code).digest("hex");

  const artifact = buildPluginArtifact({
    name: "crm.plugin.ts",
    version: "2.0.0",
    sha256: sha,
    size: code.byteLength,
    permissions: ["data:read", "data:write"],
    author: { id: "acme-corp", keyId, contact: "ops@acme.example" },
  });
  const manifest = await signPlugin({
    artifact,
    privateKeyB64: author.privateKey,
    authorId: "acme-corp",
    keyId,
  });
  await Deno.writeTextFile(
    join(dir, "crm.plugin.ts.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  // 3. Operator aprueba la key (TOFU workflow)
  const trustPath = join(dir, "trusted-keys.json");
  let trust: TrustStore = emptyTrustStore();
  trust = addKey(trust, {
    keyId,
    publicKey: author.publicKey,
    alg: "Ed25519",
    addedAt: new Date().toISOString(),
    addedBy: "user",
    label: "acme-corp prod",
  });
  await saveTrustStore(trustPath, trust);

  // 4. Verificar — debe pasar
  const loadedManifest = parseManifest(
    await Deno.readTextFile(join(dir, "crm.plugin.ts.manifest.json")),
  );
  const trustLoaded = await loadTrustStore(trustPath);
  const r1 = await verifyPlugin({
    pluginPath,
    manifest: loadedManifest,
    trust: trustLoaded,
  });
  assertEquals(r1.ok, true);

  // 5. Operator revoca la key (compromiso)
  const revoked = revokeKey(trustLoaded, keyId, "key compromised via phishing");
  await saveTrustStore(trustPath, revoked);
  const trustRevoked = await loadTrustStore(trustPath);

  // 6. Verificar de nuevo — ahora FALLA
  const r2 = await verifyPlugin({
    pluginPath,
    manifest: loadedManifest,
    trust: trustRevoked,
  });
  assertEquals(r2.ok, false);
  if (!r2.ok) assertEquals(r2.reason, "key_revoked");

  await Deno.remove(dir, { recursive: true });
});
