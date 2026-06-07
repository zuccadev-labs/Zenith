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
  type PluginAuthor,
  type PluginArtifact,
  type PluginPermission,
  type PluginSignature,
  type SignedPluginManifest,
  type TrustedAuthorKey,
  type TrustStore,
  type VerificationResult,
  type VerificationFailure,
  type VerifyOptions,
} from "./types.ts";

export {
  canonicalJson,
  stableStringify,
} from "./canonical.ts";

export {
  type KeyPairRaw,
  generateKeyPair,
  importPublicRaw,
  importPrivateRaw,
  exportPublicRaw,
  exportPrivateRaw,
  sign,
  verify,
  fingerprint,
  fingerprintShort,
  buildKeyId,
  isValidKeyId,
} from "./keys.ts";

export {
  buildPluginArtifact,
  sha256OfFile,
  signPlugin,
  verifyPluginSignature,
  parseManifest,
  validateManifest,
  type BuildArtifactOptions,
  type SignOptions,
  type VerifySignatureOptions,
} from "./manifest.ts";

export {
  globalTrustPath,
  projectTrustPath,
  emptyTrustStore,
  loadTrustStore,
  loadMergedTrustStore,
  saveTrustStore,
  findKey,
  findKeysByAuthor,
  addKey,
  revokeKey,
  removeKey,
  validateTrustStore,
} from "./trust-store.ts";

export {
  verifyPlugin,
  validatePublicKey,
} from "./verifier.ts";
