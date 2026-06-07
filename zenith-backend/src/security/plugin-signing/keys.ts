/**
 * Ed25519 keypair management para plugin signing.
 *
 * Formato en disco (raw 32 bytes, base64):
 *   - Public key:  32 bytes raw → base64
 *   - Private key: 32 bytes (seed) → base64
 *
 * Usamos raw (no SPKI/PKCS8) por simplicidad e interoperabilidad
 * con herramientas CLI externas. Si en el futuro se quiere
 * compatibilidad X.509/HSM, se puede agregar una capa de adaptación.
 *
 * WebCrypto en Deno 2.x soporta Ed25519 nativamente.
 */

import { createHash } from "node:crypto";

/** Par de claves Ed25519 en formato raw base64. */
export interface KeyPairRaw {
  /** Clave pública raw 32 bytes, base64. */
  publicKey: string;
  /** Clave privada raw 32 bytes (seed), base64. */
  privateKey: string;
}

/** Genera un par de claves Ed25519 nuevo. */
export async function generateKeyPair(): Promise<KeyPairRaw> {
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  return {
    publicKey: await exportPublicRaw(kp.publicKey),
    privateKey: await exportPrivateRaw(kp.privateKey),
  };
}

/** Exporta clave pública a base64 SPKI DER (~44 bytes para Ed25519). */
export async function exportPublicRaw(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("spki", key);
  return uint8ToBase64(new Uint8Array(raw));
}

/** Exporta clave privada a base64 PKCS8 DER (~48 bytes para Ed25519). */
export async function exportPrivateRaw(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("pkcs8", key);
  return uint8ToBase64(new Uint8Array(raw));
}

/** Importa una clave pública SPKI DER base64. */
export async function importPublicRaw(b64: string): Promise<CryptoKey> {
  const raw = base64ToUint8(b64);
  return await crypto.subtle.importKey(
    "spki",
    raw as BufferSource,
    { name: "Ed25519" },
    true,
    ["verify"],
  );
}

/** Importa una clave privada PKCS8 DER base64. */
export async function importPrivateRaw(b64: string): Promise<CryptoKey> {
  const raw = base64ToUint8(b64);
  return await crypto.subtle.importKey(
    "pkcs8",
    raw as BufferSource,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
}

/** Firma data con la clave privada. Devuelve firma raw 64 bytes en base64. */
export async function sign(
  privateKey: CryptoKey,
  data: Uint8Array,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    data as BufferSource,
  );
  return uint8ToBase64(new Uint8Array(sig));
}

/** Verifica firma con la clave pública. */
export async function verify(
  publicKey: CryptoKey,
  data: Uint8Array,
  signatureB64: string,
): Promise<boolean> {
  const sig = base64ToUint8(signatureB64);
  if (sig.byteLength !== 64) {
    throw new Error(
      `Ed25519 signature must be 64 bytes raw, got ${sig.byteLength}`,
    );
  }
  return await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    sig as BufferSource,
    data as BufferSource,
  );
}

/**
 * Fingerprint legible de una clave pública.
 * Formato: `ed25519:AB:CD:EF:GH` (SHA-256 of public key, primeros 4 bytes
 * en hex con separador `:` cada byte).
 *
 * Compacto (16 chars total) — suficiente para identificación visual única
 * (4 bytes = 2^32 colisiones, aceptable para display; el keyId completo
 * tiene los 8 hex chars sin separador).
 *
 * Usado para:
 *   - Identificar visualmente una clave en logs / CLI
 *   - Construir el `keyId` por convención: `<author-id>-ed25519-<fingerprint-short>`
 */
export function fingerprint(publicKeyB64: string): string {
  const raw = base64ToUint8(publicKeyB64);
  const hash = createHash("sha256").update(raw).digest();
  const first4 = hash.subarray(0, 4);
  const hexPairs: string[] = [];
  for (let i = 0; i < first4.length; i++) {
    hexPairs.push(first4[i].toString(16).padStart(2, "0").toUpperCase());
  }
  return `ed25519:${hexPairs.join(":")}`;
}

/**
 * Short fingerprint: primeros 8 hex chars del SHA-256 de la clave pública,
 * sin separadores. Usado para construir el `keyId`.
 */
export function fingerprintShort(publicKeyB64: string): string {
  const raw = base64ToUint8(publicKeyB64);
  const hash = createHash("sha256").update(raw).digest();
  // 4 bytes = 8 hex chars
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += hash[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return out;
}

/** Construye un `keyId` estándar. */
export function buildKeyId(authorId: string, publicKeyB64: string): string {
  // Sanitize authorId: lowercase alphanumeric + hyphens
  const safe = authorId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${safe}-ed25519-${fingerprintShort(publicKeyB64)}`;
}

/** Valida formato de un `keyId`. */
export function isValidKeyId(keyId: string): boolean {
  return /^[a-z0-9-]+-ed25519-[A-F0-9]{8}$/.test(keyId);
}

// ── Base64 helpers (evitamos atob/btoa que no están en Deno std) ───────────

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
