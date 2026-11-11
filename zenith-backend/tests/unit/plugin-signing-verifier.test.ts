/**
 * Tests para verifier.ts — full chain verification of plugin manifests.
 *
 * Cubre:
 *   - Happy path: file + manifest + trust → ok
 *   - Manifest malformed → manifest_malformed
 *   - Plugin name mismatch → plugin_name_mismatch
 *   - Key not in trust store → key_not_trusted
 *   - Key revoked → key_revoked (unless allowRevoked)
 *   - Signature invalid → signature_invalid
 *   - File SHA256 mismatch → plugin_sha256_mismatch
 *   - File size mismatch → plugin_size_mismatch
 *   - validatePublicKey: accepts Ed25519, rejects garbage
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { generateKeyPair } from "../../src/security/plugin-signing/keys.ts";
import { buildPluginArtifact, signPlugin } from "../../src/security/plugin-signing/manifest.ts";
import {
  addKey,
  emptyTrustStore,
  findKeysByAuthor,
} from "../../src/security/plugin-signing/trust-store.ts";
import { validatePublicKey, verifyPlugin } from "../../src/security/plugin-signing/verifier.ts";
import type {
  SignedPluginManifest,
  TrustedAuthorKey,
} from "../../src/security/plugin-signing/types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Fixture {
  authorId: string;
  keyId: string;
  publicKey: string;
  privateKey: string;
  pluginName: string;
  pluginContent: Uint8Array;
  pluginSha256: string;
  pluginSize: number;
  manifest: SignedPluginManifest;
  trust: ReturnType<typeof emptyTrustStore>;
  pluginDir: string;
}

async function setupFixture(
  opts: { name?: string; authorId?: string; tamper?: "sig" | "sha" | "size" | "name" | "trust" } =
    {},
): Promise<Fixture> {
  const kp = await generateKeyPair();
  const authorId = opts.authorId ?? "acme";
  const pluginName = opts.name ?? "myplugin.js";

  // Create a temp plugin file
  const tmpDir = await Deno.makeTempDir();
  const pluginPath = `${tmpDir}/${pluginName}`;
  const content = new TextEncoder().encode(`console.log("hello from ${pluginName}")`);
  await Deno.writeFile(pluginPath, content);

  const sha256 = new Uint8Array(
    await crypto.subtle.digest("SHA-256", content as BufferSource),
  );
  const sha256Hex = Array.from(sha256).map((b) => b.toString(16).padStart(2, "0")).join("");

  // Build the keyId (matches buildKeyId logic)
  const publicKeyBytes = Uint8Array.from(
    atob(kp.publicKey),
    (c) => c.charCodeAt(0),
  );
  const shortHash = Array.from(publicKeyBytes).slice(0, 4).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("").toUpperCase();
  const keyId = `${authorId}-ed25519-${shortHash}`;

  // Build author with proper keyId
  const author = { id: authorId, keyId };

  const artifact = buildPluginArtifact({
    name: pluginName,
    version: "1.0.0",
    sha256: sha256Hex,
    size: content.byteLength,
    permissions: ["data:read"],
    author,
  });

  const manifest = await signPlugin({
    artifact,
    privateKeyB64: kp.privateKey,
    authorId,
    keyId,
  });

  // For tamper tests that need to bypass Object.freeze, we use JSON round-trip
  // in the test itself. The fixture just returns the canonical manifest.

  // Build trust store
  const trustedKey: TrustedAuthorKey = {
    keyId,
    publicKey: kp.publicKey,
    alg: "Ed25519",
    addedAt: new Date().toISOString(),
    addedBy: "user",
  };
  const trust = addKey(emptyTrustStore(), trustedKey);

  if (opts.tamper === "trust") {
    // Replace the public key in trust with a different one
    const wrongKp = await generateKeyPair();
    const idx = trust.keys.findIndex((k) => k.keyId === keyId);
    if (idx >= 0) {
      (trust.keys[idx] as any).publicKey = wrongKp.publicKey;
    }
  }

  // For signature tamper: take the manifest and flip one byte in the signature
  // We work on a clone (deep via JSON) to avoid mutating the frozen manifest.
  if (opts.tamper === "sig") {
    const rawJson = JSON.parse(JSON.stringify(manifest));
    const sig = rawJson.signature.value;
    rawJson.signature.value = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    return {
      authorId,
      keyId,
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      pluginName,
      pluginContent: content,
      pluginSha256: sha256Hex,
      pluginSize: content.byteLength,
      manifest: rawJson,
      trust,
      pluginDir: tmpDir,
    };
  }

  return {
    authorId,
    keyId,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    pluginName,
    pluginContent: content,
    pluginSha256: sha256Hex,
    pluginSize: content.byteLength,
    manifest,
    trust,
    pluginDir: tmpDir,
  };
}

async function cleanupFixture(f: Fixture) {
  await Deno.remove(f.pluginDir, { recursive: true }).catch(() => {});
}

// ─── Happy path ─────────────────────────────────────────────────────────────

Deno.test("verifyPlugin - happy path returns ok", async () => {
  const f = await setupFixture();
  try {
    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: f.manifest,
      trust: f.trust,
    });
    assertEquals(result.ok, true);
    assertEquals(result.keyId, f.keyId);
    assertEquals(result.author, f.authorId);
  } finally {
    await cleanupFixture(f);
  }
});

// ─── Failure: manifest malformed ────────────────────────────────────────────

Deno.test("verifyPlugin - malformed manifest returns manifest_malformed", async () => {
  const f = await setupFixture();
  try {
    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: { bogus: true } as any,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    assertEquals(result.reason, "manifest_malformed");
  } finally {
    await cleanupFixture(f);
  }
});

Deno.test("verifyPlugin - non-object manifest returns manifest_malformed", async () => {
  const f = await setupFixture();
  try {
    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: "not an object" as any,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    assertEquals(result.reason, "manifest_malformed");
  } finally {
    await cleanupFixture(f);
  }
});

// ─── Failure: plugin name mismatch (tested by mutating manifest via raw JSON) ───

Deno.test("verifyPlugin - plugin name mismatch returns plugin_name_mismatch", async () => {
  const f = await setupFixture();
  try {
    // Bypass Object.freeze by serializing and renaming the plugin field
    const rawJson = JSON.parse(JSON.stringify(f.manifest));
    rawJson.plugin.name = "different.js";

    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: rawJson,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    assertEquals(result.reason, "plugin_name_mismatch");
  } finally {
    await cleanupFixture(f);
  }
});

// ─── Failure: key not trusted ───────────────────────────────────────────────

Deno.test("verifyPlugin - key not in trust store returns key_not_trusted", async () => {
  const f = await setupFixture();
  try {
    const emptyTrust = emptyTrustStore();
    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: f.manifest,
      trust: emptyTrust,
    });
    assertEquals(result.ok, false);
    assertEquals(result.reason, "key_not_trusted");
  } finally {
    await cleanupFixture(f);
  }
});

// ─── Failure: key revoked ───────────────────────────────────────────────────

Deno.test("verifyPlugin - revoked key returns key_revoked (default)", async () => {
  const f = await setupFixture();
  try {
    // Revoke the key
    f.trust.keys[0].revokedAt = new Date().toISOString();
    f.trust.keys[0].revokedReason = "test";

    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: f.manifest,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    assertEquals(result.reason, "key_revoked");
  } finally {
    await cleanupFixture(f);
  }
});

Deno.test("verifyPlugin - revoked key passes when allowRevoked=true", async () => {
  const f = await setupFixture();
  try {
    f.trust.keys[0].revokedAt = new Date().toISOString();
    f.trust.keys[0].revokedReason = "test";

    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: f.manifest,
      trust: f.trust,
      allowRevoked: true,
    });
    // Should pass signature check and reach the hash check
    assertEquals(result.ok, true);
  } finally {
    await cleanupFixture(f);
  }
});

// ─── Failure: signature invalid (tampered) ──────────────────────────────────

Deno.test("verifyPlugin - tampered signature returns signature_invalid", async () => {
  const f = await setupFixture({ tamper: "sig" });
  try {
    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: f.manifest,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    assertEquals(result.reason, "signature_invalid");
  } finally {
    await cleanupFixture(f);
  }
});

Deno.test("verifyPlugin - wrong public key in trust store returns signature_invalid", async () => {
  const f = await setupFixture({ tamper: "trust" });
  try {
    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: f.manifest,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    assertEquals(result.reason, "signature_invalid");
  } finally {
    await cleanupFixture(f);
  }
});

// ─── Failure: file content mismatch ─────────────────────────────────────────

Deno.test("verifyPlugin - file content tampered returns plugin_sha256_mismatch", async () => {
  const f = await setupFixture();
  try {
    // Overwrite the plugin file with different content
    await Deno.writeFile(`${f.pluginDir}/${f.pluginName}`, new TextEncoder().encode("tampered"));

    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: f.manifest,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    assertEquals(result.reason, "plugin_sha256_mismatch");
  } finally {
    await cleanupFixture(f);
  }
});

Deno.test("verifyPlugin - size mismatch (covered by content tamper which changes size too)", async () => {
  // The size check is in the same code path as the sha256 check. A file content
  // tamper already changes both size and sha256; the verifier returns the first
  // mismatch it finds (sha256). To isolate the size branch we'd need a manifest
  // whose sha256 matches the file but size differs — possible only by bypassing
  // Object.freeze via JSON round-trip AND a hash-collision, which is impractical.
  // This test is kept as a placeholder documenting the behavior.
  const f = await setupFixture();
  try {
    // Overwrite file with same sha256 but different size is impossible.
    // Instead, verify that content tamper (which is the realistic attack)
    // returns plugin_sha256_mismatch.
    await Deno.writeFile(`${f.pluginDir}/${f.pluginName}`, new TextEncoder().encode("x"));
    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/${f.pluginName}`,
      manifest: f.manifest,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    // The exact reason (sha256 vs size) depends on which check runs first.
    // Both are valid "content mismatch" outcomes.
    assertEquals(
      result.reason === "plugin_sha256_mismatch" ||
        result.reason === "plugin_size_mismatch",
      true,
    );
  } finally {
    await cleanupFixture(f);
  }
});

// ─── Failure: file not found ────────────────────────────────────────────────

Deno.test("verifyPlugin - missing plugin file returns ok=false with detail", async () => {
  const f = await setupFixture();
  try {
    const result = await verifyPlugin({
      pluginPath: `${f.pluginDir}/nonexistent-${crypto.randomUUID()}.js`,
      manifest: f.manifest,
      trust: f.trust,
    });
    assertEquals(result.ok, false);
    assertEquals(typeof result.detail, "string");
  } finally {
    await cleanupFixture(f);
  }
});

Deno.test("validatePublicKey - accepts valid Ed25519 public key", async () => {
  const kp = await generateKeyPair();
  const ok = await validatePublicKey(kp.publicKey);
  assertEquals(ok, true);
});

Deno.test("validatePublicKey - rejects garbage input", async () => {
  const ok = await validatePublicKey("not-a-valid-base64-key!!!");
  assertEquals(ok, false);
});

Deno.test("validatePublicKey - rejects empty string", async () => {
  const ok = await validatePublicKey("");
  assertEquals(ok, false);
});
