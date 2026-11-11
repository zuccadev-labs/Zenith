/**
 * @module @zenith/core/crypto
 *
 * Primitivas criptográficas compartidas por el motor, los traits y la seguridad.
 * Fuente de verdad única, como `trait-utils.ts`: ningún módulo reimplementa aleatorios, hashes,
 * firmas ni comparaciones. Todas usan Web Crypto (CSPRNG del sistema) y `@std/encoding`.
 *
 * Clasificación:
 * - **Aleatorios:** `randomBytes`, `randomHex`, `randomString` (sin sesgo de módulo).
 * - **Codificación:** `toHex`, `toBase64Url`, `fromBase64Url`.
 * - **Hash:** `sha256`, `sha256Hex`. Para secretos de un solo uso (tokens de sesión o de
 *   invitación); las contraseñas y las API keys usan Argon2id (`security/api-keys/manager.ts`).
 * - **Firmas:** `hmacSha256Hex` y `signingKey`. Para firmar datos se usa HMAC, nunca
 *   `sha256(datos + clave)`.
 * - **Comparación:** `timingSafeEqual`, `timingSafeEqualString`, en tiempo constante.
 */
import { decodeBase64Url, encodeBase64Url, encodeHex } from "@std/encoding";

const enc = new TextEncoder();
const bytesOf = (data: string | Uint8Array): Uint8Array => (typeof data === "string" ? enc.encode(data) : data);

// ─── Aleatorios ───────────────────────────────────────────────────────────────

/** Web Crypto entrega como mucho 64 KiB por llamada. */
const MAX_RANDOM_CHUNK = 65_536;

/** `n` bytes del CSPRNG. */
export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += MAX_RANDOM_CHUNK) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + MAX_RANDOM_CHUNK, n)));
  }
  return out;
}

/** `n` bytes aleatorios en hexadecimal (`2n` caracteres). */
export function randomHex(n: number): string {
  return encodeHex(randomBytes(n));
}

/**
 * Cadena de `length` caracteres de `alphabet`, uniforme. Descarta los bytes que caen fuera del
 * mayor múltiplo del tamaño del alfabeto (muestreo por rechazo), así que `byte % alphabet.length`
 * no favorece a los primeros caracteres.
 */
export function randomString(length: number, alphabet: string): string {
  const size = alphabet.length;
  if (size < 2 || size > 256) throw new RangeError("randomString: alphabet must have 2 to 256 characters.");
  const limit = 256 - (256 % size);
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length - out.length + 8)) {
      if (b < limit) out += alphabet[b % size];
      if (out.length === length) break;
    }
  }
  return out;
}

// ─── Codificación ─────────────────────────────────────────────────────────────

/** Bytes en hexadecimal en minúsculas. */
export function toHex(data: ArrayBuffer | Uint8Array): string {
  return encodeHex(data instanceof Uint8Array ? data : new Uint8Array(data));
}

/** Base64url sin relleno (RFC 4648 §5), el de JWT y PKCE. */
export function toBase64Url(data: ArrayBuffer | Uint8Array): string {
  return encodeBase64Url(data instanceof Uint8Array ? data : new Uint8Array(data));
}

/** Inverso de `toBase64Url`. Acepta la entrada con o sin relleno. */
export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(decodeBase64Url(s.replace(/=+$/, "")));
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/** SHA-256 de una cadena (UTF-8) o de bytes. */
export async function sha256(data: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytesOf(data) as BufferSource));
}

/** SHA-256 en hexadecimal. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

// ─── Firmas ───────────────────────────────────────────────────────────────────

/** HMAC-SHA256 de `data` con `key`, en hexadecimal. */
export async function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey("raw", bytesOf(key) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, bytesOf(data) as BufferSource));
}

const processKeys = new Map<string, string>();

/**
 * La clave de firma de la variable de entorno `envName`. Si no está definida, usa una clave
 * aleatoria del proceso y lo avisa una vez: nunca una clave fija conocida, con la que cualquiera
 * podría firmar. Lo firmado así solo vale en este proceso y hasta que se reinicie.
 */
export function signingKey(envName: string, warn: (m: string) => void = console.warn): string {
  let fromEnv: string | undefined;
  try {
    fromEnv = Deno.env.get(envName);
  } catch {
    fromEnv = undefined; // sin permiso --allow-env
  }
  if (fromEnv) return fromEnv;
  let key = processKeys.get(envName);
  if (!key) {
    key = randomHex(32);
    processKeys.set(envName, key);
    warn(`[crypto] ${envName} is not set: using a random per-process key. Signatures are valid only in this process until it restarts.`);
  }
  return key;
}

// ─── Comparación ──────────────────────────────────────────────────────────────

/** Igualdad de bytes en tiempo constante para longitudes iguales; longitudes distintas → false. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Igualdad de dos secretos en tiempo constante, también respecto a su longitud: compara sus
 * SHA-256, que siempre miden 32 bytes.
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return timingSafeEqual(ha, hb);
}
