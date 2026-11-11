/**
 * @module plugin-signing
 *
 * Cadena de confianza Ed25519 para plugins de Zenith.
 *
 * API de alto nivel:
 *
 * ```ts
 * import {
 *   generateKeyPair, buildKeyId, fingerprint,
 *   buildPluginArtifact, signPlugin, parseManifest,
 *   loadMergedTrustStore, addKey, saveTrustStore,
 *   verifyPlugin,
 * } from "../security/plugin-signing/mod.ts";
 *
 * // Generar par de claves
 * const kp = await generateKeyPair();
 * const keyId = buildKeyId("acme-corp", kp.publicKey);
 *
 * // Construir + firmar manifest
 * const artifact = buildPluginArtifact({...});
 * const manifest = await signPlugin({artifact, privateKeyB64: kp.privateKey, authorId: "acme-corp", keyId});
 * await Deno.writeTextFile("crm.plugin.ts.manifest.json", JSON.stringify(manifest, null, 2));
 *
 * // En el backend: verificar antes de cargar
 * const trust = await loadMergedTrustStore();
 * const result = await verifyPlugin({pluginPath: "./plugins/crm.plugin.ts", manifest, trust});
 * if (!result.ok) throw new Error(`Plugin ${result.reason}: ${result.detail}`);
 * ```
 *
 * Ver ADR-004-plugin-signing.md para el threat model completo.
 */

export {
  MANIFEST_VERSION,
  type PluginArtifact,
  type PluginAuthor,
  type PluginPermission,
  type PluginSignature,
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
