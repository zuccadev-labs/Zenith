/**
 * Verifier de alto nivel: dado un archivo de plugin y su manifest firmado,
 * verifica TODA la cadena: estructura, firma, cadena de confianza, contenido.
 *
 * Es la función que llama el `mod.ts` antes de hacer `import(pluginUrl)`.
 *
 * Errores posibles: ver `VerificationFailure` en types.ts.
 */

import { createHash } from "node:crypto";
import { basename } from "@std/path";
import type { SignedPluginManifest, VerificationResult, VerifyOptions } from "./types.ts";
import { validateManifest } from "./manifest.ts";
import { findKey } from "./trust-store.ts";
import { verifyPluginSignature } from "./manifest.ts";
import { importPublicRaw } from "./keys.ts";

/** Resultado de validación de la firma cruda (sin trust check). */
async function checkRawSignature(
  manifest: SignedPluginManifest,
  publicKeyB64: string,
): Promise<boolean> {
  try {
    return await verifyPluginSignature({ manifest, publicKeyB64 });
  } catch (e) {
    // Loggear pero devolver false; el caller reporta
    console.warn(`[plugin-signing] signature check error: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Verifica un plugin contra su manifest firmado.
 *
 * Pasos:
 *   1. Validar estructura del manifest
 *   2. Validar manifestVersion
 *   3. Validar campos básicos (sha256 format, etc)
 *   4. Buscar key en trust store
 *   5. Si la key está revocada y `allowRevoked=false` → reject
 *   6. Verificar firma Ed25519
 *   7. Re-hashear el archivo del plugin y comparar con manifest.plugin.sha256
 *   8. Re-medir tamaño y comparar
 *   9. Verificar que el nombre del plugin declarado coincide con el archivo
 */
export async function verifyPlugin(
  opts: VerifyOptions,
): Promise<VerificationResult> {
  const { pluginPath, manifest: rawManifest, trust, allowRevoked = false } = opts;

  // 1. Validar estructura
  let manifest: SignedPluginManifest;
  try {
    manifest = validateManifest(rawManifest);
  } catch (e) {
    return {
      ok: false,
      reason: "manifest_malformed",
      detail: (e as Error).message,
    };
  }

  // 2. manifestVersion ya validado por validateManifest
  // 3. Campos básicos ya validados

  // Verificar nombre del plugin declarado vs archivo
  const pathBasename = basename(pluginPath);
  if (pathBasename !== manifest.plugin.name) {
    return {
      ok: false,
      reason: "plugin_name_mismatch",
      detail: `file=${pathBasename} manifest=${manifest.plugin.name}`,
    };
  }

  // 4. Buscar key
  const trustedKey = findKey(trust, manifest.plugin.author.keyId);
  if (!trustedKey) {
    return {
      ok: false,
      reason: "key_not_trusted",
      detail: `keyId=${manifest.plugin.author.keyId} author=${manifest.plugin.author.id}`,
    };
  }

  // 5. Check revoked
  if (trustedKey.revokedAt && !allowRevoked) {
    return {
      ok: false,
      reason: "key_revoked",
      detail:
        `keyId=${trustedKey.keyId} revokedAt=${trustedKey.revokedAt} reason=${trustedKey.revokedReason}`,
    };
  }

  // 6. Verificar firma cruda
  const sigValid = await checkRawSignature(manifest, trustedKey.publicKey);
  if (!sigValid) {
    return {
      ok: false,
      reason: "signature_invalid",
      detail: `keyId=${trustedKey.keyId}`,
    };
  }

  // 7-8. Re-hashear y re-medir el archivo del plugin
  let fileContent: Uint8Array;
  try {
    fileContent = await Deno.readFile(pluginPath);
  } catch (e) {
    return {
      ok: false,
      reason: "manifest_malformed", // Re-usar: indica que no se pudo validar
      detail: `Cannot read plugin file: ${(e as Error).message}`,
    };
  }
  const actualSha = createHash("sha256").update(fileContent).digest("hex");
  if (actualSha !== manifest.plugin.sha256) {
    return {
      ok: false,
      reason: "plugin_sha256_mismatch",
      detail: `expected=${manifest.plugin.sha256} actual=${actualSha}`,
    };
  }
  if (fileContent.byteLength !== manifest.plugin.size) {
    return {
      ok: false,
      reason: "plugin_size_mismatch",
      detail: `expected=${manifest.plugin.size} actual=${fileContent.byteLength}`,
    };
  }

  return {
    ok: true,
    keyId: trustedKey.keyId,
    author: manifest.plugin.author.id,
  };
}

/**
 * Valida que una clave pública es una clave Ed25519 válida.
 * Útil al agregar al trust store (para no guardar basura).
 */
export async function validatePublicKey(publicKeyB64: string): Promise<boolean> {
  try {
    await importPublicRaw(publicKeyB64);
    return true;
  } catch {
    return false;
  }
}
