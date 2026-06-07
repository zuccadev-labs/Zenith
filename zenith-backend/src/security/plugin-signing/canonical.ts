/**
 * Canonical JSON (RFC 8785 / JCS) para serialización reproducible.
 *
 * La firma de un manifest debe ser sobre una representación única y
 * determinística, no sobre el JSON prettified que escribió el humano.
 * Si no, dos manifests lógicamente iguales firmarían diferente.
 *
 * Reglas JCS aplicadas (subset mínimo para nuestro caso):
 *   1. Object keys ordenadas lexicográficamente (punto de código Unicode).
 *   2. Sin whitespace.
 *   3. Strings: escapado mínimo JSON (RFC 8259).
 *   4. Numbers: representación más corta que roundtrips.
 *   5. Arrays: preservan orden (el orden ES semántico en nuestro schema).
 *   6. No soporta NaN/Infinity (no aparecen en nuestros datos).
 *
 * No usamos la lib externa `canonicalize` para mantener zero deps.
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

// deno-lint-ignore no-control-regex
const needsEscape = /[\\"\b\f\n\r\t]|\u0000|[\u0001-\u001F]/g;

function escapeString(s: string): string {
  return `"${
    s.replace(needsEscape, (c) => {
      switch (c) {
        case "\\":
          return "\\\\";
        case '"':
          return '\\"';
        case "\b":
          return "\\b";
        case "\f":
          return "\\f";
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "\t":
          return "\\t";
        default: {
          const cp = c.charCodeAt(0);
          if (cp <= 0xFFFF) {
            return `\\u${cp.toString(16).padStart(4, "0")}`;
          }
          // surrogate pair
          const offset = cp - 0x10000;
          const hi = 0xD800 + (offset >> 10);
          const lo = 0xDC00 + (offset & 0x3FF);
          return `\\u${hi.toString(16).padStart(4, "0")}\\u${
            lo.toString(16).padStart(4, "0")
          }`;
        }
      }
    })
  }"`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error("JCS: NaN/Infinity not allowed");
  }
  if (Number.isInteger(n)) return n.toString();
  // JSON.stringify number formatting is JCS-compliant
  return JSON.stringify(n);
}

function canonicalize(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  // Object: sort keys lexicographically by code point
  const keys = Object.keys(value).sort();
  const pairs: string[] = [];
  for (const k of keys) {
    pairs.push(escapeString(k) + ":" + canonicalize((value as Record<string, Json>)[k]));
  }
  return "{" + pairs.join(",") + "}";
}

/** Serializa cualquier valor JSON-compatible a JCS canonical. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value as Json);
}

/**
 * Stable stringify para loggear. NO usar para firmar (usar `canonicalJson`).
 * Solo para debugging.
 */
export function stableStringify(value: unknown): string {
  return canonicalize(value as Json);
}
