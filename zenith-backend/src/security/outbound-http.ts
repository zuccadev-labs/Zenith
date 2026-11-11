/**
 * @module @zenith/security/outbound-http
 *
 * Peticiones HTTP salientes hacia URLs que no controla Zenith: webhooks, Cloud Code Hooks y la acción
 * `send_webhook` de las automatizaciones. Una sola implementación, con las protecciones de Standard
 * Webhooks (§ Security) y OWASP API7:2023 (SSRF):
 *
 * - **Esquema:** solo `https:`. `http:` solo con `allowHttp`, pensado para desarrollo.
 * - **Destino:** el host se resuelve y todas sus direcciones tienen que ser públicas (`core/net.ts`).
 *   Quedan fuera loopback, redes privadas, link-local y metadatos de nube (169.254.169.254). Un literal
 *   IP se comprueba igual. `allowPrivate` lo desactiva, pensado para desarrollo y pruebas.
 * - **Redirecciones:** no se siguen (`redirect: "manual"`). Un 3xx es una respuesta más, no un salto a
 *   otro destino que nadie validó.
 * - **Tiempo:** 15 s por defecto (Standard Webhooks: 15-30 s).
 *
 * Riesgo residual: entre la resolución y la conexión el DNS puede cambiar (DNS rebinding). Para
 * eliminarlo, las entregas deben salir por un proxy de salida que filtre destinos (por ejemplo
 * smokescreen) en una red aislada, como recomienda Standard Webhooks.
 */
import { isPublicAddress, parseIp } from "../core/net.ts";

export interface OutboundPolicy {
  /** Permite `http:`. Por defecto, solo `https:`. */
  readonly allowHttp?: boolean;
  /** Permite destinos privados o de loopback. Solo para desarrollo y pruebas. */
  readonly allowPrivate?: boolean;
  /** Milisegundos antes de abortar. Por defecto, 15 000. */
  readonly timeoutMs?: number;
  /** Resolutor DNS (inyectable en pruebas). */
  readonly resolve?: (host: string) => Promise<string[]>;
}

/** Un destino rechazado por la política. El mensaje se puede devolver al operador. */
export class OutboundBlockedError extends Error {
  override name = "OutboundBlockedError";
}

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000;

async function resolveAll(host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([
    Deno.resolveDns(host, "A").catch(() => [] as string[]),
    Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
  ]);
  return [...a, ...aaaa];
}

/** Valida una URL de destino: esquema y, sin `allowPrivate`, que todas sus direcciones sean públicas. */
export async function checkOutboundUrl(raw: string, policy: OutboundPolicy = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundBlockedError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowHttp)) {
    throw new OutboundBlockedError(`Only https URLs are allowed (got ${url.protocol}).`);
  }
  if (url.username || url.password) throw new OutboundBlockedError("URLs with credentials are not allowed.");
  if (policy.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = parseIp(host) ? [host] : await (policy.resolve ?? resolveAll)(host);
  if (addresses.length === 0) throw new OutboundBlockedError(`Host "${host}" does not resolve.`);
  const blocked = addresses.filter((a) => !isPublicAddress(a));
  if (blocked.length) throw new OutboundBlockedError(`Host "${host}" resolves to a non-public address (${blocked.join(", ")}).`);
  return url;
}

/** `fetch` hacia un destino externo con la política aplicada. Lanza `OutboundBlockedError` si se rechaza. */
export async function safeFetch(raw: string, init: RequestInit = {}, policy: OutboundPolicy = {}): Promise<Response> {
  const url = await checkOutboundUrl(raw, policy);
  const timeout = AbortSignal.timeout(policy.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return await fetch(url, { ...init, redirect: "manual", signal });
}
