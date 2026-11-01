/**
 * Motor de impuestos y envío por país del plugin de e-commerce.
 *
 * Las tasas viven en la clase `StoreCountryRule`: cambian por ley y por negocio, así que no hay
 * valores por defecto. Sin regla activa para el destino, el checkout se rechaza en vez de cobrar
 * un impuesto supuesto.
 */
import { ZenithErrors } from "../core/errors.ts";

export interface CountryRule {
  /** ISO 3166: país ("VE") o subdivisión ("US-CA"). La subdivisión tiene prioridad. */
  code: string;
  currency: string;
  decimals?: number;
  taxName?: string;
  /** Porcentaje, de 0 a 100. */
  taxRate: number;
  /** El precio ya incluye el impuesto: se desglosa en vez de sumarse. */
  taxIncluded?: boolean;
  taxableShipping?: boolean;
  shippingFlat: number;
  /** Subtotal desde el que el envío es gratis. Sin valor, nunca lo es. */
  freeShippingFrom?: number;
  isActive?: boolean;
}

export const COUNTRY_RULE_SCHEMA = {
  code:             { type: "String",  required: true },
  currency:         { type: "String",  required: true },
  decimals:         { type: "Number",  defaultValue: 2 },
  taxName:          { type: "String" },
  taxRate:          { type: "Number",  required: true },
  taxIncluded:      { type: "Boolean", defaultValue: false },
  taxableShipping:  { type: "Boolean", defaultValue: false },
  shippingFlat:     { type: "Number",  required: true },
  freeShippingFrom: { type: "Number" },
  isActive:         { type: "Boolean", defaultValue: true },
};

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateCountryRule(rule: any): CountryRule {
  const code = String(rule?.code ?? "").toUpperCase();
  if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code)) throw ZenithErrors.invalidRequest("code must be ISO 3166, like VE or US-CA.");
  const currency = String(rule?.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw ZenithErrors.invalidRequest("currency must be ISO 4217, like USD.");
  if (!isAmount(rule.taxRate) || rule.taxRate > 100) throw ZenithErrors.invalidRequest("taxRate must be between 0 and 100.");
  if (!isAmount(rule.shippingFlat)) throw ZenithErrors.invalidRequest("shippingFlat must be a positive amount.");
  if (rule.freeShippingFrom !== undefined && !isAmount(rule.freeShippingFrom)) {
    throw ZenithErrors.invalidRequest("freeShippingFrom must be a positive amount.");
  }
  const decimals = rule.decimals ?? 2;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw ZenithErrors.invalidRequest("decimals must be between 0 and 4.");
  return {
    ...rule, code, currency, decimals,
    taxIncluded: !!rule.taxIncluded,
    taxableShipping: !!rule.taxableShipping,
    isActive: rule.isActive !== false,
  };
}

/** Busca la regla activa del destino: primero la subdivisión, después el país. */
export async function findCountryRule(Zen: any, address: any): Promise<CountryRule> {
  const country = String(address?.country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw ZenithErrors.invalidRequest("shippingAddress.country must be an ISO 3166 code, like VE.");

  const region = address?.region ? String(address.region).toUpperCase() : undefined;
  if (region) {
    const regional = await Zen.DB.findOne("StoreCountryRule", { where: { code: region, isActive: true } });
    if (regional) return regional;
  }
  const rule = await Zen.DB.findOne("StoreCountryRule", { where: { code: country, isActive: true } });
  if (!rule) throw ZenithErrors.invalidRequest(`Store does not sell to '${country}': no active country rule.`);
  return rule;
}

export function computeTotals(input: { subtotal: number; discount: number; freeShipping: boolean; rule: CountryRule }) {
  const { subtotal, discount, freeShipping, rule } = input;
  const decimals = rule.decimals ?? 2;
  const round = (value: number) => parseFloat(value.toFixed(decimals));

  const free = freeShipping || (rule.freeShippingFrom !== undefined && subtotal >= rule.freeShippingFrom);
  const shipping = free ? 0 : round(rule.shippingFlat);
  const net = Math.max(0, subtotal - discount);
  const base = net + (rule.taxableShipping ? shipping : 0);
  const rate = rule.taxRate / 100;
  const tax = round(rule.taxIncluded ? base - base / (1 + rate) : base * rate);
  const total = round(net + shipping + (rule.taxIncluded ? 0 : tax));

  return { subtotal: round(subtotal), discount: round(discount), shipping, tax, total };
}
