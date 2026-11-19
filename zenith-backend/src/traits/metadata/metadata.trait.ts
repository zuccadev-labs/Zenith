/**
 * Metadata Trait — Custom Objects y Custom Fields en runtime.
 *
 * Permite crear, editar y eliminar clases y campos personalizados
 * vía API (igual que la Metadata API de Twenty CRM).
 * Los Custom Objects son ciudadanos de primera clase: tienen el mismo
 * soporte CRUD, filtros, vistas y API que los objetos estándar.
 *
 * Integración con SchemaManagementTrait: delega la persistencia
 * en _SCHEMA y llama a db.upsert para aplicar el schema al driver.
 *
 * @barrits-trait
 * @barrits-summary ZenithMetadata
 * @barrits-provides metadata_routes, metadata
 * @barrits-consumes db, schema
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";
import { ZenithErrors } from "../../core/errors.ts";
import { errRes, jsonRes, NO_CONTENT, now, pathParams } from "../../core/trait-utils.ts";

/**
 * Field types a custom field can declare (a superset of the Parse and Twenty CRM types).
 * `GET /zen/metadata/field-types` returns this list, and `addField` rejects any other type.
 */
export const FIELD_TYPES = [
  "String",
  "Text",
  "RichText",
  "Number",
  "Boolean",
  "Date",
  "DateTime",
  "Email",
  "Phone",
  "URL",
  "JSON",
  "Select",
  "MultiSelect",
  "Rating",
  "Currency",
  "Address",
  "FullName",
  "Pointer",
  "Relation",
  "Array",
  "Position",
] as const;

/** One of the field types listed in {@linkcode FIELD_TYPES}. */
export type FieldType = typeof FIELD_TYPES[number];

/** A field of a custom object, as stored in its metadata and applied to the class schema. */
export interface MetaField {
  /** Field (column) name, unique within the object. */
  name: string;
  /** Data type of the field. */
  type: FieldType;
  /** Human-readable label shown in UIs. */
  label?: string;
  /** Free-text description of what the field holds. */
  description?: string;
  /** Whether the schema requires a value for this field. */
  required?: boolean;
  /** Value the schema uses when a record omits the field. */
  defaultValue?: unknown;
  /** Select/MultiSelect only: the allowed options. */
  options?: Array<{ value: string; label: string; color?: string }>;
  /** Pointer/Relation only: the class the field points to. */
  targetClass?: string;
  /** Currency only: ISO 4217 currency code. */
  currency?: string;
  /** Rating only: maximum rating value. */
  maxRating?: number;
  /**
   * Built-in field (`objectId`, `createdAt`, `updatedAt`, `ACL`): it cannot be updated or removed
   * and is not sent to the schema manager.
   */
  isSystem?: boolean;
}

/** A custom object (a user-defined class) created at runtime through the metadata API. */
export interface MetaObject {
  /** Unique id of the metadata record. */
  objectId: string;
  /** Class name in PascalCase; it cannot be one of the reserved system classes. */
  name: string;
  /** Singular display name (defaults to `name`). */
  nameSingular: string;
  /** Plural display name (defaults to `name` + "s"). */
  namePlural: string;
  /** Icon identifier shown in UIs. */
  icon?: string;
  /** Free-text description of the object. */
  description?: string;
  /** True for objects created through the API; only custom objects can be modified or deleted. */
  isCustom: boolean;
  /** The object's fields, starting with the built-in system fields. */
  fields: MetaField[];
  /** Creation time (ISO 8601). */
  createdAt: string;
  /** Last update time (ISO 8601). */
  updatedAt: string;
}

/** Prefijo protegido — el usuario no puede crear objetos con estos nombres */
const SYSTEM_CLASSES = new Set([
  "_User",
  "_Role",
  "_Session",
  "_File",
  "_Tenant",
  "ERP_Audit",
  "WorkspaceMember",
  "WorkspaceInvitation",
  "ZenithApiKey",
  "ZenithView",
  "ZenithViewFilter",
  "ZenithViewSort",
  "ZenithViewField",
  "Note",
  "Task",
  "Comment",
  "Attachment",
  "Contact",
  "Lead",
  "Deal",
  "Account",
  "Pipeline",
  "Campaign",
  "Activity",
  "CRM_Insight",
  "Product",
  "Order",
  "Invoice",
  "Employee",
  "Warehouse",
  "InventoryEntry",
]);

/**
 * Trait that provides the runtime custom objects and custom fields API (`metadata`) and its routes
 * under `/zen/metadata` (`metadata_routes`). Objects are persisted in `_CustomObject` and their
 * fields are applied to the class schema through the `schema` capability, so a new entity gets
 * CRUD, views, search and API support without a redeploy.
 */
export const MetadataTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithMetadata",
  provides: ["metadata_routes", "metadata"],
  consumes: ["db", "schema"],
  state: [],
  runtimes: ["deno"],

  summary:
    "Custom Objects and Custom Fields runtime API. Create any business entity with full CRUD, views, search and API support — no redeploy needed.",

  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const schema = deps.traits["schema"];

    // Registro en memoria (sincronizado con _CustomObject en DB)
    const customObjects = new Map<string, MetaObject>();

    // Bootstrap: cargar objetos custom existentes al iniciar
    (async () => {
      try {
        const existing = await db.find("_CustomObject", {});
        for (const obj of existing) customObjects.set(obj.name, obj);
      } catch { /* tabla vacía en primer boot */ }
    })();

    const api = {
      // ── Custom Objects ─────────────────────────────────────────────────────

      async listObjects(): Promise<{ objects: MetaObject[] }> {
        const all = Array.from(customObjects.values());
        return { objects: all.sort((a, b) => a.name.localeCompare(b.name)) };
      },

      async getObject(name: string): Promise<MetaObject> {
        const obj = customObjects.get(name);
        if (!obj) throw ZenithErrors.notFound("CustomObject", name);
        return obj;
      },

      async createObject(
        data: {
          name: string;
          nameSingular?: string;
          namePlural?: string;
          icon?: string;
          description?: string;
          fields?: MetaField[];
        },
      ): Promise<MetaObject> {
        const name = data.name?.trim();
        if (!name) throw ZenithErrors.validationFailed("name es obligatorio.");
        if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) {
          throw ZenithErrors.validationFailed("name debe ser PascalCase (ej: CustomerOrder).");
        }
        if (SYSTEM_CLASSES.has(name)) {
          throw ZenithErrors.forbidden(`'${name}' es un sistema de clase reservado.`);
        }
        if (customObjects.has(name)) {
          throw ZenithErrors.validationFailed(`El objeto '${name}' ya existe.`);
        }

        // Campos base siempre incluidos (Parse compat)
        const baseFields: MetaField[] = [
          { name: "objectId", type: "String", isSystem: true },
          { name: "createdAt", type: "DateTime", isSystem: true },
          { name: "updatedAt", type: "DateTime", isSystem: true },
          { name: "ACL", type: "JSON", isSystem: true },
        ];

        const metaObj: MetaObject = {
          objectId: crypto.randomUUID(),
          name,
          nameSingular: data.nameSingular ?? name,
          namePlural: data.namePlural ?? `${name}s`,
          icon: data.icon,
          description: data.description,
          isCustom: true,
          fields: [...baseFields, ...(data.fields ?? [])],
          createdAt: now(),
          updatedAt: now(),
        };

        // Persistir en DB y registrar en SchemaManagementTrait
        await db.create("_CustomObject", metaObj);
        if (schema?.defineClass) {
          const schemaFields = Object.fromEntries(
            metaObj.fields.filter((f) => !f.isSystem).map(
              (f) => [f.name, { type: f.type, required: f.required, defaultValue: f.defaultValue }],
            ),
          );
          await schema.defineClass(name, schemaFields, {}).catch(() => {});
        }
        customObjects.set(name, metaObj);
        return metaObj;
      },

      async updateObject(
        name: string,
        data: Partial<Pick<MetaObject, "nameSingular" | "namePlural" | "icon" | "description">>,
      ): Promise<MetaObject> {
        const obj = customObjects.get(name);
        if (!obj) throw ZenithErrors.notFound("CustomObject", name);
        const updated = { ...obj, ...data, updatedAt: now() };
        await db.update("_CustomObject", { objectId: obj.objectId }, updated);
        customObjects.set(name, updated);
        return updated;
      },

      async deleteObject(name: string): Promise<{ success: boolean }> {
        const obj = customObjects.get(name);
        if (!obj) throw ZenithErrors.notFound("CustomObject", name);
        if (!obj.isCustom) {
          throw ZenithErrors.forbidden(`No se puede eliminar un objeto de sistema.`);
        }
        await db.delete("_CustomObject", { objectId: obj.objectId });
        customObjects.delete(name);
        return { success: true };
      },

      // ── Custom Fields ──────────────────────────────────────────────────────

      async addField(objectName: string, field: MetaField): Promise<MetaObject> {
        const obj = customObjects.get(objectName);
        if (!obj) throw ZenithErrors.notFound("CustomObject", objectName);
        if (!field.name || !field.type) {
          throw ZenithErrors.validationFailed("name y type son obligatorios para el campo.");
        }
        if (!FIELD_TYPES.includes(field.type as any)) {
          throw ZenithErrors.validationFailed(
            `Tipo '${field.type}' no soportado. Usa: ${FIELD_TYPES.join(", ")}`,
          );
        }
        if (obj.fields.find((f) => f.name === field.name)) {
          throw ZenithErrors.validationFailed(
            `El campo '${field.name}' ya existe en '${objectName}'.`,
          );
        }

        obj.fields.push(field);
        obj.updatedAt = now();
        await db.update("_CustomObject", { objectId: obj.objectId }, obj);
        if (schema?.addColumn) {
          await schema.addColumn(objectName, field.name, field.type, {
            defaultValue: field.defaultValue,
            required: field.required,
          }).catch(() => {});
        }
        customObjects.set(objectName, obj);
        return obj;
      },

      async updateField(
        objectName: string,
        fieldName: string,
        data: Partial<MetaField>,
      ): Promise<MetaObject> {
        const obj = customObjects.get(objectName);
        if (!obj) throw ZenithErrors.notFound("CustomObject", objectName);
        const idx = obj.fields.findIndex((f) => f.name === fieldName);
        if (idx < 0) throw ZenithErrors.notFound("Field", fieldName);
        if (obj.fields[idx].isSystem) {
          throw ZenithErrors.forbidden("Los campos de sistema no se pueden modificar.");
        }
        obj.fields[idx] = { ...obj.fields[idx], ...data, name: fieldName };
        obj.updatedAt = now();
        await db.update("_CustomObject", { objectId: obj.objectId }, obj);
        customObjects.set(objectName, obj);
        return obj;
      },

      async deleteField(objectName: string, fieldName: string): Promise<MetaObject> {
        const obj = customObjects.get(objectName);
        if (!obj) throw ZenithErrors.notFound("CustomObject", objectName);
        const field = obj.fields.find((f) => f.name === fieldName);
        if (!field) throw ZenithErrors.notFound("Field", fieldName);
        if (field.isSystem) {
          throw ZenithErrors.forbidden("Los campos de sistema no se pueden eliminar.");
        }
        obj.fields = obj.fields.filter((f) => f.name !== fieldName);
        obj.updatedAt = now();
        await db.update("_CustomObject", { objectId: obj.objectId }, obj);
        if (schema?.deleteColumn) await schema.deleteColumn(objectName, fieldName).catch(() => {});
        customObjects.set(objectName, obj);
        return obj;
      },

      /** Retorna los tipos de campo y sus opciones de configuración */
      getFieldTypes() {
        return {
          types: FIELD_TYPES,
          descriptions: {
            String: "Texto de una línea",
            Text: "Texto multilínea",
            RichText: "Editor de bloque (JSON Tiptap/Lexical)",
            Number: "Número entero o decimal",
            Boolean: "Verdadero / Falso",
            Date: "Fecha (YYYY-MM-DD)",
            DateTime: "Fecha y hora (ISO 8601)",
            Email: "Email con validación de formato",
            Phone: "Teléfono con código de país",
            URL: "URL con validación https://",
            JSON: "Objeto JSON libre",
            Select: "Lista desplegable (opciones configurables)",
            MultiSelect: "Selección múltiple (opciones configurables)",
            Rating: "Calificación 1-N estrellas",
            Currency: "Monto + código moneda (USD, EUR, MXN...)",
            Address: "Dirección estructurada (street, city, state, zip, country)",
            FullName: "Nombre completo (firstName + lastName)",
            Pointer: "Relación 1:N (FK a otra clase)",
            Relation: "Relación N:M",
            Array: "Array de valores",
            Position: "Float para drag & drop (Kanban)",
          },
        };
      },
    };

    const metadata_routes = [
      // Objects
      {
        method: "GET" as const,
        path: "/zen/metadata/objects",
        _openapi: { summary: "Listar todos los Custom Objects", tags: ["Metadata"] },
        handler: async (_req: Request, _ctx: any) => {
          try {
            return jsonRes(await api.listObjects());
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "GET" as const,
        path: "/zen/metadata/objects/:name",
        _openapi: { summary: "Obtener Custom Object con sus fields", tags: ["Metadata"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/metadata/objects/:name", req.url)!;
            return jsonRes(await api.getObject(p.name));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "POST" as const,
        path: "/zen/metadata/objects",
        _openapi: { summary: "Crear Custom Object (genera clase y schema)", tags: ["Metadata"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            return jsonRes(await api.createObject(await req.json()), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "PUT" as const,
        path: "/zen/metadata/objects/:name",
        _openapi: { summary: "Actualizar metadata del Custom Object", tags: ["Metadata"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/metadata/objects/:name", req.url)!;
            return jsonRes(await api.updateObject(p.name, await req.json()));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "DELETE" as const,
        path: "/zen/metadata/objects/:name",
        _openapi: { summary: "Eliminar Custom Object", tags: ["Metadata"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/metadata/objects/:name", req.url)!;
            await api.deleteObject(p.name);
            return NO_CONTENT;
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Fields
      {
        method: "POST" as const,
        path: "/zen/metadata/objects/:name/fields",
        _openapi: { summary: "Añadir campo al Custom Object", tags: ["Metadata"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/metadata/objects/:name/fields", req.url)!;
            return jsonRes(await api.addField(p.name, await req.json()), 201);
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "PUT" as const,
        path: "/zen/metadata/objects/:name/fields/:fieldName",
        _openapi: { summary: "Actualizar campo del Custom Object", tags: ["Metadata"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/metadata/objects/:name/fields/:fieldName", req.url)!;
            return jsonRes(await api.updateField(p.name, p.fieldName, await req.json()));
          } catch (e) {
            return errRes(e);
          }
        },
      },
      {
        method: "DELETE" as const,
        path: "/zen/metadata/objects/:name/fields/:fieldName",
        _openapi: { summary: "Eliminar campo del Custom Object", tags: ["Metadata"] },
        handler: async (req: Request, _ctx: any) => {
          try {
            const p = pathParams("/zen/metadata/objects/:name/fields/:fieldName", req.url)!;
            await api.deleteField(p.name, p.fieldName);
            return NO_CONTENT;
          } catch (e) {
            return errRes(e);
          }
        },
      },
      // Types reference
      {
        method: "GET" as const,
        path: "/zen/metadata/field-types",
        _openapi: { summary: "Tipos de campo disponibles con descripción", tags: ["Metadata"] },
        handler: async (_req: Request, _ctx: any) => jsonRes(api.getFieldTypes()),
      },
    ];

    return { metadata_routes, metadata: api };
  },
});
