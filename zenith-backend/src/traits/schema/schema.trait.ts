/**
 * Parse Server-compatible schema management: add/update/delete columns, set CLP (class-level permissions), validate objects against schema, system class protection.
 *
 * @barrits-trait
 * @barrits-summary ZenithSchemaManagement
 * @barrits-provides schema-routes, schema, schemaValidator
 * @barrits-consumes db
 * @barrits-state schemas, systemClasses
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const SchemaManagementTrait = createTraitDescriptor({
  name: "ZenithSchemaManagement",
  provides: ["schema-routes", "schema", "schemaValidator"],
  consumes: ["db"],
  state: ["schemas", "systemClasses"],
  runtimes: ["deno"],
  summary: "Parse Server-compatible schema management: add/update/delete columns, set CLP (class-level permissions), validate objects against schema, system class protection.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    // Definitions live in _SCHEMA; every instance re-reads them at most every 30 s.
    const SCHEMA_TTL_MS = 30_000;
    const loaded = new Map<string, { at: number; schema: any }>();
    const traitApi: any = {
      schemas: new Map<string, any>(),
      systemClasses: ["_User", "_Role", "_Session", "_Installation", "_Product", "_Audience", "_AudienceMembership", "_AdUnit", "_group", "_IdempotencyRequest", "_JobStatus"],

      registerSystemClass: (className: string, fields: Record<string, any>) => {
        traitApi.schemas.set(className, { className, fields, systemClass: true, createdAt: new Date().toISOString() });
      },

      defineClass: async (className: string, fields: Record<string, any>, options: { clp?: any; indexes?: any } = {}) => {
        if (traitApi.systemClasses.includes(className)) {
          throw Object.assign(new Error(`cannot redefine system class: ${className}`), { status: 403 });
        }
        const schemaRecord = {
          className,
          fields: { objectId: { type: "String" }, createdAt: { type: "Date" }, updatedAt: { type: "Date" }, ACL: { type: "ACL" }, ...fields },
          clp: options.clp || { find: { "*": true }, count: { "*": true }, get: { "*": true }, create: { "*": true }, update: { "*": true }, delete: { "*": true }, addField: { "*": true }, protectedFields: {} },
          indexes: options.indexes || {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        traitApi.schemas.set(className, schemaRecord);
        await db.upsert("_SCHEMA", { className }, schemaRecord);
        loaded.delete(className);
        return schemaRecord;
      },

      addColumn: async (className: string, fieldName: string, fieldType: string, options: { defaultValue?: any; required?: boolean } = {}) => {
        const schema = traitApi.schemas.get(className);
        if (!schema) throw new Error(`class not found: ${className}`);
        schema.fields[fieldName] = { type: fieldType, ...options };
        schema.updatedAt = new Date().toISOString();
        await db.upsert("_SCHEMA", { className }, schema);
        loaded.delete(className);
        return schema;
      },

      deleteColumn: async (className: string, fieldName: string) => {
        const schema = traitApi.schemas.get(className);
        if (!schema) throw new Error(`class not found: ${className}`);
        delete schema.fields[fieldName];
        schema.updatedAt = new Date().toISOString();
        await db.upsert("_SCHEMA", { className }, schema);
        loaded.delete(className);
        return schema;
      },

      setCLP: async (className: string, clp: any) => {
        const schema = traitApi.schemas.get(className);
        if (!schema) throw new Error(`class not found: ${className}`);
        schema.clp = { ...schema.clp, ...clp };
        schema.updatedAt = new Date().toISOString();
        await db.upsert("_SCHEMA", { className }, schema);
        loaded.delete(className);
        return schema;
      },

      validate: (className: string, data: Record<string, any>) => {
        const schema = traitApi.schemas.get(className);
        if (!schema) return { valid: true, errors: [] };
        const errors: string[] = [];
        for (const [fieldName, fieldDef] of Object.entries<any>(schema.fields)) {
          if (fieldName === "objectId" || fieldName === "createdAt" || fieldName === "updatedAt" || fieldName === "ACL") continue;
          if (fieldDef.required && data[fieldName] === undefined) errors.push(`${fieldName} is required`);
          if (data[fieldName] !== undefined && fieldDef.type === "Number" && typeof data[fieldName] !== "number") errors.push(`${fieldName} must be Number`);
          if (data[fieldName] !== undefined && fieldDef.type === "Boolean" && typeof data[fieldName] !== "boolean") errors.push(`${fieldName} must be Boolean`);
        }
        return { valid: errors.length === 0, errors };
      },

      getSchema: (className: string) => traitApi.schemas.get(className),

      /** The definition of `className` (this instance's, else the one in _SCHEMA), or `null`. */
      resolve: async (className: string) => {
        const hit = loaded.get(className);
        if (hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.schema;
        const stored = await db.findOne("_SCHEMA", { className });
        const schema = stored ?? traitApi.schemas.get(className) ?? null;
        if (stored) traitApi.schemas.set(className, stored);
        loaded.set(className, { at: Date.now(), schema });
        return schema;
      },

      listSchemas: () => Array.from(traitApi.schemas.values()),

      /** Parse CLP check. `roles`: the caller's role names (without the `role:` prefix). */
      checkCLP: (className: string, operation: string, userId: string | null, master: boolean, roles: string[] = []) => {
        if (master) return true;
        const schema = traitApi.schemas.get(className);
        if (!schema) return true;
        const clpForOp = schema.clp?.[operation];
        if (!clpForOp) return true;
        if (clpForOp["*"] === true) return true;
        if (!userId) return false;
        if (clpForOp.requiresAuthentication === true) return true;
        if (clpForOp[userId] === true) return true;
        // Before: any signed-in user passed a rule naming "role:admin".
        return roles.some((r) => clpForOp[`role:${r}`] === true);
      },
    };

    traitApi.registerSystemClass("_User", {
      username: { type: "String", required: true },
      password: { type: "String", required: true },
      email: { type: "String" },
      emailVerified: { type: "Boolean" },
      authData: { type: "Object" },
    });
    traitApi.registerSystemClass("_Role", { name: { type: "String", required: true }, users: { type: "Relation", targetClass: "_User" }, roles: { type: "Relation", targetClass: "_Role" } });
    traitApi.registerSystemClass("_Session", { user: { type: "Pointer", targetClass: "_User" }, installationId: { type: "String" }, sessionToken: { type: "String" }, expiresWithSessionToken: { type: "Boolean" } });
    traitApi.registerSystemClass("_Installation", { installationId: { type: "String", required: true }, deviceToken: { type: "String" }, channels: { type: "Array" }, pushType: { type: "String" } });
    traitApi.registerSystemClass("_SCHEMA", { className: { type: "String", required: true }, fields: { type: "Object" }, clp: { type: "Object" } });

    const schema_routes = [
      {
        method: "POST" as const,
        path: "/schemas/:className",
        _openapi: {
          summary: "Create or update a schema for a class",
          parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { fields: { type: "object" }, clp: { type: "object" } } } } } },
        },
        handler: async (req: Request) => {
          const className = new URL(req.url).pathname.split("/")[2];
          const body = await req.json() as { fields: Record<string, any>; clp?: any };
          const schema = await traitApi.defineClass(className, body.fields, { clp: body.clp });
          return new Response(JSON.stringify(schema), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/schemas/:className",
        _openapi: { summary: "Get the schema for a class", parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const className = new URL(req.url).pathname.split("/")[2];
          const schema = traitApi.getSchema(className);
          if (!schema) return new Response(JSON.stringify({ error: "schema not found" }), { status: 404, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify(schema), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/schemas",
        _openapi: { summary: "List all registered schemas" },
        handler: async () => new Response(JSON.stringify({ results: traitApi.listSchemas() }), { status: 200, headers: { "content-type": "application/json" } }),
      },
      {
        method: "PUT" as const,
        path: "/schemas/:className",
        _openapi: { summary: "Update a schema (add fields, modify CLP)", parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const className = new URL(req.url).pathname.split("/")[2];
          const body = await req.json() as { fields?: Record<string, any>; clp?: any };
          if (body.clp) await traitApi.setCLP(className, body.clp);
          if (body.fields) {
            for (const [fieldName, fieldDef] of Object.entries<any>(body.fields)) {
              await traitApi.addColumn(className, fieldName, fieldDef.type, fieldDef);
            }
          }
          return new Response(JSON.stringify(traitApi.getSchema(className)), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "DELETE" as const,
        path: "/schemas/:className",
        _openapi: { summary: "Delete a schema definition (does not delete data)", parameters: [{ name: "className", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const className = new URL(req.url).pathname.split("/")[2];
          traitApi.schemas.delete(className);
          return new Response(null, { status: 204 });
        },
      },
    ];

    return {
      "schema-routes": schema_routes,
      "schema": traitApi,
      "schemaValidator": traitApi.validate,
    };
  },
});
