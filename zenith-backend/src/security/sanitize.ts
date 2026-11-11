/**
 * @module @zenith/security/sanitize
 *
 * Lo que sale de Zenith hacia un tercero (webhooks, Cloud Code Hooks) nunca lleva credenciales:
 * `sanitizePayload` quita, en cualquier nivel, los campos de sesión, contraseña, authData y hashes de
 * los objetos Parse. Parse Server los reenvía tal cual (y además las cabeceras del cliente); Zenith no.
 */

/** Campos que nunca salen hacia un tercero, en cualquier nivel: credenciales y secretos de objetos Parse. */
const SENSITIVE_KEYS = new Set(["sessionToken", "password", "_hashed_password", "authData", "_auth_data", "tokenHash", "keyHash", "hash", "secret", "secrets", "_perishable_token", "_email_verify_token"]);

/** Copia de `data` sin los campos sensibles (objetos y listas anidados incluidos). */
export function sanitizePayload(data: unknown, depth = 0): unknown {
  if (depth > 20 || data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((v) => sanitizePayload(v, depth + 1));
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(([k]) => !SENSITIVE_KEYS.has(k)).map(([k, v]) => [k, sanitizePayload(v, depth + 1)]),
  );
}
