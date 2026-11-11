/**
 * @module @zenith/security/webhook-signature
 *
 * Firma de los webhooks que envía Zenith, en un solo sitio. Esquema de Stripe:
 *
 *   x-zenith-signature: t=<unix segundos>,v1=<hex HMAC-SHA256(secreto, "<t>.<cuerpo>")>
 *
 * - **Marca de tiempo firmada:** el receptor rechaza firmas fuera de la tolerancia (5 min por
 *   defecto), así que una petición capturada no se puede reenviar más tarde.
 * - **Varios `v1`, varios secretos:** durante una rotación, el receptor verifica con el secreto
 *   nuevo y con el anterior.
 * - **Comparación en tiempo constante** (core/crypto.ts).
 *
 * Antes había dos implementaciones (`cloud/webhook.trait.ts` y `webhooks/webhook.manager.trait.ts`).
 * Firmaban solo el cuerpo, con la marca en milisegundos, y la verificación esperaba `"<t>.<cuerpo>"`:
 * una firma propia nunca verificaba.
 */
import { hmacSha256Hex, timingSafeEqual } from "../core/crypto.ts";

/** Cabecera HTTP con la firma. */
export const WEBHOOK_SIGNATURE_HEADER = "x-zenith-signature";
/** Tolerancia por defecto entre la marca firmada y el reloj del receptor. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const enc = new TextEncoder();
const signedPayload = (t: number, body: string) => `${t}.${body}`;

/** Valor de la cabecera de firma para `body`. `nowMs` solo para pruebas. */
export async function signWebhook(secret: string, body: string, nowMs: number = Date.now()): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${await hmacSha256Hex(secret, signedPayload(t, body))}`;
}

/** Marca de tiempo y firmas `v1` de una cabecera; `null` si está mal formada. */
export function parseWebhookSignature(header: string): { t: number; v1: string[] } | null {
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  return Number.isSafeInteger(t) && v1.length > 0 ? { t, v1 } : null;
}

/**
 * Si `header` firma `body` con alguno de `secrets` dentro de la tolerancia. Falla cerrado: una
 * cabecera mal formada, sin secretos o fuera de tiempo devuelve `false`.
 */
export async function verifyWebhook(
  header: string | null | undefined,
  body: string,
  secrets: readonly string[],
  options: { toleranceSeconds?: number; nowMs?: number } = {},
): Promise<boolean> {
  const parsed = header ? parseWebhookSignature(header) : null;
  if (!parsed || secrets.length === 0) return false;
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - parsed.t) > tolerance) return false;
  let ok = false;
  for (const secret of secrets) {
    const expected = enc.encode(await hmacSha256Hex(secret, signedPayload(parsed.t, body)));
    // Sin cortocircuito: el tiempo no revela cuál de las firmas o de los secretos coincidió.
    for (const candidate of parsed.v1) ok = timingSafeEqual(expected, enc.encode(candidate)) || ok;
  }
  return ok;
}
