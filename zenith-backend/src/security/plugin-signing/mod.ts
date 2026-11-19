/**
 * Ed25519 chain of trust for Zenith plugins: authors sign a manifest describing the plugin file
 * (hash, size, permissions) and the backend verifies it against a trust store before loading it.
 *
 * @example
 * ```ts
 * import {
 *   buildKeyId,
 *   buildPluginArtifact,
 *   generateKeyPair,
 *   loadMergedTrustStore,
 *   sha256OfFile,
 *   signPlugin,
 *   verifyPlugin,
 * } from "@zuccadev-labs/zenith/plugin-signing";
 *
 * // Generate a key pair
 * const kp = await generateKeyPair();
 * const keyId = buildKeyId("acme-corp", kp.publicKey);
 *
 * // Build and sign the manifest
 * const { sha256, size } = await sha256OfFile("./plugins/crm.plugin.ts");
 * const artifact = buildPluginArtifact({
 *   name: "crm.plugin.ts",
 *   version: "1.0.0",
 *   sha256,
 *   size,
 *   permissions: ["data:read"],
 *   author: { id: "acme-corp", keyId },
 * });
 * const manifest = await signPlugin({
 *   artifact,
 *   privateKeyB64: kp.privateKey,
 *   authorId: "acme-corp",
 *   keyId,
 * });
 * await Deno.writeTextFile("crm.plugin.ts.manifest.json", JSON.stringify(manifest, null, 2));
 *
 * // In the backend: verify before loading
 * const trust = await loadMergedTrustStore();
 * const result = await verifyPlugin({ pluginPath: "./plugins/crm.plugin.ts", manifest, trust });
 * if (!result.ok) throw new Error(`Plugin ${result.reason}: ${result.detail}`);
 * ```
 *
 * See ADR-004-plugin-signing.md for the full threat model.
 *
 * @module
 */

export {
  MANIFEST_VERSION,
  type PluginArtifact,
  type PluginAuthor,
  type PluginPermission,
  type PluginSignature,
  type SignatureAlgorithm,
  type SignedPluginManifest,
  type TrustedAuthorKey,
  type TrustStore,
  type VerificationFailure,
  type VerificationResult,
  type VerifyOptions,
} from "./types.ts";

export { canonicalJson, stableStringify } from "./canonical.ts";

export {
  buildKeyId,
  exportPrivateRaw,
  exportPublicRaw,
  fingerprint,
  fingerprintShort,
  generateKeyPair,
  importPrivateRaw,
  importPublicRaw,
  isValidKeyId,
  type KeyPairRaw,
  sign,
  verify,
} from "./keys.ts";

export {
  type BuildArtifactOptions,
  buildPluginArtifact,
  parseManifest,
  sha256OfFile,
  type SignOptions,
  signPlugin,
  validateManifest,
  verifyPluginSignature,
  type VerifySignatureOptions,
} from "./manifest.ts";

export {
  addKey,
  emptyTrustStore,
  findKey,
  findKeysByAuthor,
  globalTrustPath,
  loadMergedTrustStore,
  loadTrustStore,
  projectTrustPath,
  removeKey,
  revokeKey,
  saveTrustStore,
  validateTrustStore,
} from "./trust-store.ts";

export { validatePublicKey, verifyPlugin } from "./verifier.ts";
