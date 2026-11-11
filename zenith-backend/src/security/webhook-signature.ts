/**
 * @module @zenith/security/webhook-signature
 *
 * Firma de los webhooks que envía Zenith según Standard Webhooks 1.0 (standardwebhooks.com), la
 * especificación neutral que siguen OpenAI, Twilio, Supabase y otros. Cualquier receptor la verifica con
 * las bibliotecas oficiales (`standardwebhooks` en npm, Go, Python, Rust…).
 *
 * Cabeceras de cada entrega:
 * - `webhook-id`: id del mensaje. No cambia entre reintentos, así que el receptor lo usa para
 *   deduplicar.
 * - `webhook-timestamp`: segundos Unix del intento.
 * - `webhook-signature`: `v1,<base64(HMAC-SHA256(clave, "<id>.<timestamp>.<cuerpo>"))>`. Durante una
 *   rotación van varias firmas separadas por espacios, con la clave nueva y con la anterior.
 *
 * Secreto: `whsec_` + base64 de 32 bytes aleatorios (la especificación admite de 24 a 64). La clave
 * HMAC son esos bytes decodificados, no el texto. El receptor rechaza firmas con más de 5 minutos de
 * diferencia (la tolerancia de la biblioteca oficial).
 */
import { fromBase64, hmacSha256, randomBytes, timingSafeEqual, toBase64 } from "../core/crypto.ts";

export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";
/** Tolerancia entre la marca firmada y el reloj del receptor (la de la biblioteca oficial). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = "whsec_";

/** Un secreto nuevo: `whsec_` + base64 de 32 bytes del CSPRNG. */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + toBase64(randomBytes(32));
}

/** Los bytes de la clave. Acepta el secreto con o sin `whsec_`; lanza si no es base64 de 24 a 64 bytes. */
export function webhookKeyBytes(secret: string): Uint8Array<ArrayBuffer> {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  let key: Uint8Array<ArrayBuffer>;
  try {
    key = fromBase64(raw);
  } catch {
    throw new Error("Webhook secret: expected whsec_ followed by base64.");
  }
  if (key.length < 24 || key.length > 64) throw new Error("Webhook secret: the key must be 24 to 64 bytes.");
  return key;
}

/** `v1,<base64>` para un mensaje. */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  if (id.includes(".")) throw new Error("webhook-id must not contain '.'.");
  return `v1,${toBase64(await hmacSha256(webhookKeyBytes(secret), `${id}.${timestamp}.${body}`))}`;
}

/**
 * Las tres cabeceras de una entrega. Con varios secretos (rotación), una firma por secreto: el receptor
 * acepta el mensaje con cualquiera de ellos.
 */
export async function webhookHeaders(
  secrets: readonly string[],
  id: string,
  body: string,
  nowMs: number = Date.now(),
): Promise<Record<string, string>> {
  if (secrets.length === 0) throw new Error("webhookHeaders: at least one secret.");
  const timestamp = Math.floor(nowMs / 1000);
  const signatures = await Promise.all(secrets.map((s) => signWebhook(s, id, timestamp, body)));
  return {
    [WEBHOOK_ID_HEADER]: id,
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: signatures.join(" "),
  };
}

type HeaderSource = Headers | Record<string, string | undefined>;
const header = (h: HeaderSource, name: string) => (h instanceof Headers ? h.get(name) : h[name] ?? h[name.toLowerCase()]) ?? null;

/**
 * Si las cabeceras firman `body` con alguno de `secrets` dentro de la tolerancia. Falla cerrado: falta
 * de cabeceras, marca fuera de tiempo o ninguna firma válida devuelven `false`. Es la verificación de
 * la biblioteca oficial, para pruebas y para los receptores escritos en Deno.
 */
export async function verifyWebhook(
  headers: HeaderSource,
  body: string,
  secrets: readonly string[],
  options: { toleranceSeconds?: number; nowMs?: number } = {},
): Promise<boolean> {
  const id = header(headers, WEBHOOK_ID_HEADER);
  const ts = header(headers, WEBHOOK_TIMESTAMP_HEADER);
  const sig = header(headers, WEBHOOK_SIGNATURE_HEADER);
  if (!id || !ts || !sig || !/^\d+$/.test(ts) || id.includes(".") || secrets.length === 0) return false;
  const timestamp = Number(ts);
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return false;
  const enc = new TextEncoder();
  const candidates = sig.split(" ").filter((s) => s.startsWith("v1,")).map((s) => enc.encode(s.slice(3)));
  let ok = false;
  for (const secret of secrets) {
    let expected: Uint8Array;
    try {
      expected = enc.encode(toBase64(await hmacSha256(webhookKeyBytes(secret), `${id}.${timestamp}.${body}`)));
    } catch {
      continue;
    }
    // Sin cortocircuito: el tiempo no revela qué firma o qué secreto coincidió.
    for (const c of candidates) ok = timingSafeEqual(expected, c) || ok;
  }
  return ok;
}
