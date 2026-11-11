/**
 * @module @zenith/core/schema.types
 * Tipos base para el esquema de datos agnóstico de Zenith.
 *
 * Basado en la especificación de Parse Server, pero extendido para
 * soportar Polyglot Persistence (cruzar relaciones entre bases de datos).
 */

/**
 * Puntero agnóstico de Zenith.
 * Representa una relación (1:1 o N:1) hacia otro objeto.
 *
 * En Parse clásico, un Pointer solo tenía className y objectId.
 * En Zenith, añadimos `databaseId` para permitir que el Pipeline
 * sepa qué adaptador consultar (ej. AuthTrait -> ScyllaDB, CrudTrait -> MongoDB).
 */
export interface ZenithPointer {
  readonly __type: "Pointer";
  readonly className: string;
  readonly objectId: string;
  /**
   * (Opcional) Identificador del adaptador o base de datos de destino.
   * Si no se provee, se asume la base de datos por defecto del className.
   */
  readonly databaseId?: string;
}

/**
 * Función de utilidad para crear un Puntero válido.
 */
export function createPointer(
  className: string,
  objectId: string,
  databaseId?: string,
): ZenithPointer {
  return {
    __type: "Pointer",
    className,
    objectId,
    ...(databaseId ? { databaseId } : {}),
  };
}

export type ZenithDataType =
  | string
  | number
  | boolean
  | Date
  | ZenithPointer
  | ZenithDataType[]
  | { [key: string]: ZenithDataType }
  | null;

/**
 * Tipos de datos soportados nativamente por el motor de Esquemas de Zenith.
 * Incluye los clásicos de Parse y extensiones nativas Web3.
 */
export type ZenithFieldType =
  | "String"
  | "Number"
  | "Boolean"
  | "Date"
  | "Object"
  | "Array"
  | "Pointer"
  | "Relation"
  | "GeoPoint"
  | "File"
  | "Bytes"
  | "BlockchainAddress" // Nuevo Web3
  | "EncryptedKey" // Nuevo Web3 (Non-Custodial)
  | "ACL"; // Control de acceso a nivel de objeto

export interface ZenithFieldDefinition {
  type: ZenithFieldType;
  targetClass?: string; // Requerido para Pointer o Relation
}

export interface ZenithSchema {
  className: string;
  fields: Record<string, ZenithFieldDefinition>;
  classLevelPermissions?: Record<string, unknown>;
  protectedFields?: Record<string, string[]>; // e.g. { "*": ["password", "privateKey"] }
}
