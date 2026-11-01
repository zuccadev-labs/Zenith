/**
 * Registro de clases de `Zen.Cloud.defineSchema()`.
 */
import { ZenithErrors } from "./errors.ts";

/** Definición de un campo de una clase registrada. */
export interface CloudSchemaField {
  type: string;
  required?: boolean;
  defaultValue?: unknown;
  targetClass?: string;
}

const schemas = new Map<string, Record<string, CloudSchemaField>>();

export function defineSchema(className: string, fields: Record<string, CloudSchemaField>): void {
  schemas.set(className, fields);
}

export function getSchema(className: string): Record<string, CloudSchemaField> | undefined {
  return schemas.get(className);
}

/** Aplica los valores por defecto y exige los campos requeridos de una clase registrada. */
export function applySchema(className: string, document: Record<string, any>): Record<string, any> {
  const fields = schemas.get(className);
  if (!fields) return document;

  const result = { ...document };
  for (const [name, field] of Object.entries(fields)) {
    if (result[name] === undefined && field.defaultValue !== undefined) {
      result[name] = structuredClone(field.defaultValue);
    }
    if (field.required && (result[name] === undefined || result[name] === null)) {
      throw ZenithErrors.validationFailed(`${className}.${name} is required.`);
    }
  }
  return result;
}
