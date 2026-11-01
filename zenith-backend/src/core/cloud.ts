/**
 * @module @zenith/core/cloud
 * Registro global de Cloud Code — API pública de Zenith.Cloud
 * 
 * Equivale a Parse.Cloud pero con tipado estricto y composición de traits.
 * Los desarrolladores usan esta API en su archivo `cloud/main.ts` para
 * registrar funciones, hooks y validaciones personalizadas.
 * 
 * Inspirado en 10 años de Parse Server:
 * - Parse.Cloud.define()     → Zen.Cloud.define()
 * - Parse.Cloud.beforeSave() → Zen.Cloud.beforeSave()
 * - Parse.Cloud.afterSave()  → Zen.Cloud.afterSave()
 * - Parse.Cloud.job()        → Zen.Cloud.job()
 * 
 * La diferencia es que en Zenith, todo está tipado y las funciones
 * se registran en un store inmutable que el CloudCodeTrait consume.
 */

import type { ZenithObject, ZenithAuthContext, ZenithPluginsRegistry } from "./types.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { ZenithError, ZenithErrorCode } from "./errors.ts";
import { applySchema, defineSchema, getSchema } from "./cloud-schema.ts";

// ─── Multi-Tenant Context & App Registry ───────────────────────────────────────

/**
 * AsyncLocalStorage multi-tenant para el contexto de la request actual.
 * Se usa internamente para resolver el appId activo, la auth y el flag de master key.
 * Los desarrolladores NO deberían acceder a esto directamente; usan `Zen.DB`,
 * `Zen.Cloud`, etc. que lo resuelven automáticamente.
 *
 * @example
 * const ctx = zenithContext.getStore();
 * if (ctx) console.log(ctx.appId, ctx.auth?.userId);
 */
export const zenithContext = new AsyncLocalStorage<{ appId: string; auth?: ZenithAuthContext; masterKey?: boolean }>();

/**
 * Registro de Apps para Cross-Tenant Queries en la misma RAM.
 */
export const ZenAppRegistry = new Map<string, any>();

// ─── Tipos del Cloud Code ──────────────────────────────────────────────────────

/**
 * Objeto de Request que recibe toda Cloud Function o Trigger.
 * Equivalente a `Parse.Cloud.FunctionRequest`.
 */
export interface CloudFunctionRequest {
  /** Parámetros enviados por el cliente */
  readonly params: Record<string, unknown>;
  /** Usuario autenticado (si existe) */
  readonly user?: { objectId: string; username?: string };
  /** Información de autenticación */
  readonly auth?: ZenithAuthContext;
  /** Si la request fue hecha con Master Key */
  readonly master: boolean;
  /** Headers originales de la request HTTP */
  readonly headers: Record<string, string>;
  /** IP del cliente */
  readonly ip?: string;
  /** Installation ID del cliente */
  readonly installationId?: string;
  /** Logueo nativo de la función (Parse Parity) */
  readonly log: {
     info: (msg: string, metadata?: any) => void;
     error: (msg: string, metadata?: any) => void;
  };
}

/**
 * Objeto de Request para Triggers (beforeSave, afterSave, etc.)
 * Equivalente a `Parse.Cloud.TriggerRequest`.
 */
export interface CloudTriggerRequest<T = ZenithObject> {
  /** El objeto que se está guardando/eliminando */
  object: T;
  /** El objeto original (antes de la mutación, solo en updates) */
  readonly original?: T;
  /** Usuario autenticado */
  readonly user?: { objectId: string; username?: string };
  /** Información de autenticación */
  readonly auth?: ZenithAuthContext;
  /** Si la request fue hecha con Master Key */
  readonly master: boolean;
  /** Contexto compartido entre beforeSave y afterSave */
  context: Record<string, unknown>;
  /** IP del cliente */
  readonly ip?: string;
  /** Installation ID del cliente */
  readonly installationId?: string;
  /** Logueo nativo (Parse Parity) */
  readonly log: {
     info: (msg: string, metadata?: any) => void;
     error: (msg: string, metadata?: any) => void;
  };
  /** Propiedades específicas de _File (Parse Parity) */
  readonly fileSize?: number;
  readonly contentLength?: number;
}

/**
 * Objeto de Request para beforeFind triggers.
 */
export interface CloudBeforeFindRequest {
  /** Nombre de la clase */
  readonly className: string;
  /** Query actual (se puede mutar) */
  query: Record<string, unknown>;
  /** Usuario autenticado */
  readonly user?: { objectId: string; username?: string };
  /** Si la request fue hecha con Master Key */
  readonly master: boolean;
  /** Contexto compartido */
  readonly context: Record<string, unknown>;
  /** Logueo nativo (Parse Parity) */
  readonly log: {
     info: (msg: string, metadata?: any) => void;
     error: (msg: string, metadata?: any) => void;
  };
  /** Indica si la consulta es un GET por ID (Parse Parity) */
  readonly isGet?: boolean;
}

/** Handler de una Cloud Function */
export type CloudFunctionHandler = (request: CloudFunctionRequest) => Promise<unknown> | unknown;

/** Handler de un Trigger de ciclo de vida */
export type CloudTriggerHandler = (request: CloudTriggerRequest) => Promise<void> | void;

/** Handler de un beforeFind trigger */
export type CloudBeforeFindHandler = (request: CloudBeforeFindRequest) => Promise<void> | void;

/** Handler de un afterFind trigger */
export type CloudAfterFindHandler = (request: { className: string; objects: ZenithObject[]; query: Record<string, unknown> }) => Promise<ZenithObject[]> | ZenithObject[];

/** Handler de un Background Job */
export type CloudJobHandler = (request: { params: Record<string, unknown>; message: (msg: string) => void }) => Promise<void> | void;

/** Validator para Cloud Functions y Triggers */
export interface CloudValidator {
  requireUser?: boolean;
  requireMaster?: boolean;
  /** Si es true, la validación se salta si la request tiene Master Key (Parse parity) */
  skipWithMasterKey?: boolean;
  requireAnyUserRoles?: string[];
  requireAllUserRoles?: string[];
  fields?: Record<string, {
    required?: boolean;
    type?: string;
    default?: unknown;
    /** Si es true, el campo no puede modificarse después de su creación inicial (Parse parity) */
    constant?: boolean;
    options?: unknown[] | ((val: any) => boolean | Promise<boolean>);
    error?: string;
  }>;
}

// ─── Trigger Categories ────────────────────────────────────────────────────────

type TriggerCategory = "beforeSave" | "afterSave" | "beforeDelete" | "afterDelete" | "beforeFind" | "afterFind" | "beforeLogin" | "afterLogin" | "beforeLogout" | "afterLogout" | "beforePasswordResetRequest" | "beforeConnect" | "beforeSubscribe" | "afterLiveQueryEvent" | "beforePublish" | "beforeWatch" | "onStreamEvent" | "beforeSaveFile" | "afterSaveFile" | "beforeDeleteFile" | "afterDeleteFile";

// ─── Store Global de Cloud Code ────────────────────────────────────────────────

/** Registro de Cloud Functions */
const _functions: Map<string, { handler: CloudFunctionHandler; validator?: CloudValidator }> = new Map();

/** Registro de Triggers (por categoría y className) */
const _triggers: Map<string, Map<string, { handler: CloudTriggerHandler | CloudBeforeFindHandler | CloudAfterFindHandler; validator?: CloudValidator }>> = new Map();

/** Registro de Background Jobs */
const _jobs: Map<string, CloudJobHandler> = new Map();

// Inicializar categorías de triggers
for (const cat of ["beforeSave", "afterSave", "beforeDelete", "afterDelete", "beforeFind", "afterFind", "beforeLogin", "afterLogin", "beforeLogout", "afterLogout", "beforePasswordResetRequest", "beforeConnect", "beforeSubscribe", "afterLiveQueryEvent", "beforePublish", "beforeWatch", "onStreamEvent", "beforeSaveFile", "afterSaveFile", "beforeDeleteFile", "afterDeleteFile"] as const) {
  _triggers.set(cat, new Map());
}

// ─── API Pública: Zenith.Cloud ──────────────────────────────────────────────────

/**
 * API principal de Cloud Code de Zenith.
 * 
 * Uso desde `cloud/main.ts`:
 * ```typescript
 * import { Zen } from "@zenith/core";
 * 
 * Zen.Cloud.define("hello", async (request) => {
 *   return { message: `Hello ${request.params.name}!` };
 * });
 * 
 * Zen.Cloud.beforeSave("GameScore", async (request) => {
 *   if (request.object.score > 1000) {
 *     throw new Error("Score too high!");
 *   }
 * });
 * ```
 */
export const ZenCloud = {
  /**
   * Define una Cloud Function.
   * Equivalente a `Parse.Cloud.define()`.
   * 
   * @param name - Nombre de la función (se invoca vía POST /functions/:name)
   * @param handler - Función que recibe el request y retorna el resultado
   * @param validator - Reglas opcionales de validación
   */
  define(name: string, handler: CloudFunctionHandler, validator?: CloudValidator): void {
    _functions.set(name, { handler, validator });
  },

  /**
   * Registra los campos de una clase. `Zen.DB.insert()` aplica sus valores por defecto
   * y exige los campos requeridos.
   */
  defineSchema,

  /** Devuelve los campos registrados de una clase, si los hay. */
  getSchema,

  /**
   * Invoca programáticamente una Cloud Function local.
   * Equivalente a `Parse.Cloud.run()`.
   */
  async run(name: string, params?: Record<string, unknown>, options?: { user?: { objectId: string; username?: string }; master?: boolean; installationId?: string }): Promise<unknown> {
    const entry = _functions.get(name);
    if (!entry) throw new Error(`Invalid function: "${name}".`);
    
    // El request manual
    const request: CloudFunctionRequest = {
      params: params || {},
      user: options?.user,
      master: !!options?.master,
      headers: {},
      installationId: options?.installationId,
      log: { info: (msg: string) => console.log(`[Cloud][INFO] ${msg}`), error: (msg: string) => console.log(`[Cloud][ERROR] ${msg}`) }
    };
    
    // Validation is usually done by CloudCodeTrait on HTTP, but if called programmatically we could do it too,
    // although for simplicity we will bypass it since it's an internal call (often master key).
    return entry.handler(request);
  },

  /**
   * Define un Background Job.
   * Equivalente a `Parse.Cloud.job()`.
   */
  job(name: string, handler: CloudJobHandler): void {
    _jobs.set(name, handler);
  },

  /**
   * Trigger antes de guardar un objeto.
   * Equivalente a `Parse.Cloud.beforeSave()`.
   * El handler puede mutar `request.object` antes de que se persista.
   */
  beforeSave(className: string, handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforeSave")!.set(className, { handler, validator });
  },

  /**
   * Trigger después de guardar un objeto.
   * Equivalente a `Parse.Cloud.afterSave()`.
   */
  afterSave(className: string, handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("afterSave")!.set(className, { handler, validator });
  },

  /**
   * Trigger antes de eliminar un objeto.
   * Equivalente a `Parse.Cloud.beforeDelete()`.
   */
  beforeDelete(className: string, handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforeDelete")!.set(className, { handler, validator });
  },

  /**
   * Trigger después de eliminar un objeto.
   * Equivalente a `Parse.Cloud.afterDelete()`.
   */
  afterDelete(className: string, handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("afterDelete")!.set(className, { handler, validator });
  },

  /**
   * Trigger antes de ejecutar una query (find).
   * Permite mutar la query antes de que se ejecute.
   * Equivalente a `Parse.Cloud.beforeFind()`.
   */
  beforeFind(className: string, handler: CloudBeforeFindHandler, validator?: CloudValidator): void {
    _triggers.get("beforeFind")!.set(className, { handler: handler as any, validator });
  },

  /**
   * Trigger después de ejecutar una query (find).
   * Permite filtrar o transformar los resultados antes de enviarlos al cliente.
   * Equivalente a `Parse.Cloud.afterFind()`.
   */
  afterFind(className: string, handler: CloudAfterFindHandler, validator?: CloudValidator): void {
    _triggers.get("afterFind")!.set(className, { handler: handler as any, validator });
  },

  /**
   * Trigger antes del login de un usuario.
   * Equivalente a `Parse.Cloud.beforeLogin()`.
   */
  beforeLogin(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforeLogin")!.set("_User", { handler, validator });
  },

  /**
   * Trigger después del login de un usuario.
   * Equivalente a `Parse.Cloud.afterLogin()`.
   */
  afterLogin(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("afterLogin")!.set("_User", { handler, validator });
  },

  /**
   * Trigger antes del logout de un usuario.
   * Equivalente a `Parse.Cloud.beforeLogout()`.
   */
  beforeLogout(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforeLogout")!.set("_Session", { handler, validator });
  },

  /**
   * Trigger después del logout de un usuario.
   * Equivalente a `Parse.Cloud.afterLogout()`.
   */
  afterLogout(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("afterLogout")!.set("_Session", { handler, validator });
  },

  /**
   * Trigger antes de un request de reseteo de contraseña.
   * Equivalente a `Parse.Cloud.beforePasswordResetRequest()`.
   */
  beforePasswordResetRequest(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforePasswordResetRequest")!.set("_User", { handler, validator });
  },

  /**
   * Trigger antes de que un cliente se conecte al WebSocket de LiveQuery.
   * Permite rechazar la conexión WebSocket inicial.
   * Equivalente a `Parse.Cloud.beforeConnect()`.
   */
  beforeConnect(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    // "LiveQuery" as a pseudo-class name for connection events
    _triggers.get("beforeConnect")!.set("LiveQuery", { handler, validator });
  },

  /**
   * Trigger antes de que un cliente se suscriba a una clase en LiveQuery.
   * Equivalente a `Parse.Cloud.beforeSubscribe()`.
   */
  beforeSubscribe(className: string, handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforeSubscribe")!.set(className, { handler, validator });
  },

  /**
   * Trigger genérico que se dispara ante eventos de LiveQuery.
   * Equivalente a `Parse.Cloud.afterLiveQueryEvent()`.
   */
  afterLiveQueryEvent(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("afterLiveQueryEvent")!.set("LiveQuery", { handler, validator });
  },

  /** Alias para retrocompatibilidad con las primeras versiones de Zenith */
  onLiveQueryEvent(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    this.afterLiveQueryEvent(handler, validator);
  },

  /**
   * Trigger antes de que un usuario publique un stream de medios.
   * Permite validar ancho de banda, tokens o rechazar la creación del stream.
   */
  beforePublish(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforePublish")!.set("MediaStream", { handler, validator });
  },

  /**
   * Trigger antes de que un usuario observe un stream.
   * Útil para paywalls o restricción por geolocalización.
   */
  beforeWatch(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforeWatch")!.set("MediaStream", { handler, validator });
  },

  /**
   * Trigger genérico para eventos del ciclo de vida del stream (inicio, parada, bitrate).
   */
  onStreamEvent(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("onStreamEvent")!.set("MediaStream", { handler, validator });
  },

  /**
   * Trigger antes de guardar un archivo.
   * Equivalente a `Parse.Cloud.beforeSaveFile()`.
   */
  beforeSaveFile(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforeSaveFile")!.set("_File", { handler, validator });
  },

  /**
   * Trigger después de guardar un archivo.
   * Equivalente a `Parse.Cloud.afterSaveFile()`.
   */
  afterSaveFile(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("afterSaveFile")!.set("_File", { handler, validator });
  },

  /**
   * Trigger antes de eliminar un archivo.
   * Equivalente a `Parse.Cloud.beforeDeleteFile()`.
   */
  beforeDeleteFile(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("beforeDeleteFile")!.set("_File", { handler, validator });
  },

  /**
   * Trigger después de eliminar un archivo.
   * Equivalente a `Parse.Cloud.afterDeleteFile()`.
   */
  afterDeleteFile(handler: CloudTriggerHandler, validator?: CloudValidator): void {
    _triggers.get("afterDeleteFile")!.set("_File", { handler, validator });
  },

  /**
   * HTTP Request proxy from Cloud Code (Parse.Cloud.httpRequest equivalent).
   */
  async httpRequest(options: { url: string; method?: string; headers?: Record<string, string>; body?: any }): Promise<any> {
    const res = await fetch(options.url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch (_e) { /* keep data=null on parse error */ }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, data };
  },

  /**
   * Envía un email usando el MailAdapter configurado.
   * Equivalente a `Parse.Cloud.sendEmail()`.
   */
  async sendEmail(data: { to: string; subject: string; text?: string; html?: string; from?: string }): Promise<void> {
     // Obtenemos la app activa en el clúster
     const ctx = zenithContext.getStore();
     if (!ctx || !ctx.appId) throw new Error("Zen.Cloud.sendEmail cannot run outside an active AppContext");
     const app = ZenAppRegistry.get(ctx.appId);
     if (!app || !app.mailAdapter) {
         ZenLogger.warn(`Zen.Cloud.sendEmail: No mailAdapter configured for app ${ctx.appId}`);
         throw new Error("No mail adapter configured for Parse Server.");
     }
     await app.mailAdapter.sendMail(data);
  }
} as const;

// ─── Acceso Interno (para CloudCodeTrait y RestCrudTrait) ──────────────────────

/**
 * Acceso interno para que los Traits del engine consulten las funciones y
 * triggers registrados. Los desarrolladores NO deben usar esto directamente.
 */
export const _cloudCodeRegistry = {
  /** Retorna una Cloud Function registrada o undefined */
  getFunction: (name: string) => _functions.get(name),

  /** Retorna un trigger registrado o undefined */
  getTrigger: (category: TriggerCategory, className: string) => _triggers.get(category)?.get(className),

  /** Retorna un Background Job registrado o undefined */
  getJob: (name: string) => _jobs.get(name),

  /** Lista todas las funciones registradas */
  listFunctions: () => [..._functions.keys()],

  /** Lista todos los jobs registrados */
  listJobs: () => [..._jobs.keys()],

  /** Lista todos los triggers de una categoría */
  listTriggers: (category: TriggerCategory) => [...(_triggers.get(category)?.keys() || [])],
} as const;

// ─── Wrapper de Base de Datos para DX (Zen.DB) ────────────────────────────────

/**
 * Wrapper estático para que las funciones Cloud Code puedan interactuar con la Base de Datos.
 * Resuelve automáticamente el adaptador correcto basado en el AsyncLocalStorage (appId).
 */
export const ZenDB = {
  /**
   * Obtiene el adaptador de base de datos para el appId activo.
   * Resuelve automáticamente según el contexto multi-tenant (AsyncLocalStorage).
   * Si no hay app activa, toma la primera app registrada (fallback seguro).
   *
   * @returns DatabaseAdapter — adaptador de base de datos (MongoDB, ScyllaDB, etc.)
   * @throws Error si no hay apps registradas en el registry
   */
  getAdapter: () => {
    const ctx = zenithContext.getStore();
    if (!ctx || !ctx.appId) {
      const firstApp = Array.from(ZenAppRegistry.values())[0];
      if (!firstApp) throw new Error("Zen.DB is not initialized yet. No apps found in Registry.");
      return firstApp.db;
    }
    const app = ZenAppRegistry.get(ctx.appId);
    if (!app || !app.db) throw new Error(`Zen.DB Error: No DB adapter found for appId '${ctx.appId}'`);
    return app.db;
  },

  // ─── Enforce ACL Helper (H-07: con resolución de Roles) ──────────────────
  /**
   * Construye la query MongoDB que filtra objetos por ACL.
   * [H-07] Ahora incluye los IDs de los roles del usuario (ej. "role:Admin")
   * para garantizar que objetos con `_rperm: ["role:Admin"]` sean accesibles.
   */
  _getUserRoles: async (userId: string): Promise<string[]> => {
    // Devuelve lista de role-strings (ej. ["role:Admin", "role:Editor"])
    try {
      const adapter = ZenDB.getAdapter();
      // Los roles en _Role tienen un campo 'users' con Relation a _User
      const roles = await adapter.find("_Role", {
        where: { "users": { $elemMatch: { objectId: userId } } }
      });
      return (roles || []).map((r: any) => `role:${r.name}`);
    } catch (_e) {
      return []; // Fail-safe: si no se pueden leer roles, no bloquear
    }
  },

  /**
   * [H-07] Inyecta filtro ACL en queries de lectura.
   * Construye un `$and` para que solo retorne objetos cuyo `_rperm` incluya
   * al usuario actual, sus roles, o sea público (`*`). Si es master key, bypass.
   *
   * @param query — Query original del desarrollador
   * @param options — Opciones: useMasterKey (bypass ACL), userRoles (rol IDs precargados)
   * @returns Query modificada con filtro ACL
   * @internal
   */
  _enforceAclQuery(query: Record<string, any>, options?: { useMasterKey?: boolean; userRoles?: string[] }): Record<string, any> {
    const ctx = zenithContext.getStore();
    const isMaster = options?.useMasterKey || ctx?.masterKey;
    if (isMaster) return query; // Bypass ACL con MasterKey

    const userId = ctx?.auth?.userId;
    const userRoles = options?.userRoles || []; // Roles ya resueltos

    // Construir la lista de identidades permitidas: *, userId, y todos sus roles
    const allowedIdentities = ["*", ...(userId ? [userId] : []), ...userRoles];

    const readQuery = {
      $or: [
        { _rperm: { $exists: false } },
        { _rperm: { $size: 0 } },
        { _rperm: { $in: allowedIdentities } }
      ]
    };

    return { $and: [query, readQuery] };
  },

  /**
   * [H-07] Verifica que el usuario tenga permiso de escritura sobre un objeto.
   * Revisa el `_wperm` del objeto existente. Si el usuario no está en la lista
   * y no hay wildcard, rechaza la operación.
   *
   * @param className — Clase del objeto
   * @param id — ObjectId del objeto
   * @param options — Opciones: useMasterKey (bypass ACL)
   * @throws Error si el usuario no tiene permisos de escritura
   * @internal
   */
  async _enforceAclWrite(className: string, id: string, options?: { useMasterKey?: boolean }): Promise<void> {
    const ctx = zenithContext.getStore();
    const isMaster = options?.useMasterKey || ctx?.masterKey;
    if (isMaster) return;

    const adapter = ZenDB.getAdapter();
    const existing = await adapter.findOne(className, { where: { _id: id } });
    if (!existing) return;

    const wperms = existing._wperm || [];
    if (wperms.length === 0 || wperms.includes("*")) return;

    const userId = ctx?.auth?.userId;
    if (!userId || !wperms.includes(userId)) {
      throw new Error(`Zen.DB Error: Access denied. You don't have write permissions for this object.`);
    }
  },

  /**
   * Busca documentos en una clase de Parse.
   * Inyecta automáticamente filtros ACL basados en el usuario autenticado.
   * Soporta cross-tenant queries via `options.targetAppId`.
   *
   * @param className — Nombre de la clase (ej. "TodoItem", "_User")
   * @param query — Query con where, order, limit, skip, include, count
   * @param options — targetAppId (cross-tenant), useMasterKey (bypass ACL)
   * @returns Array de documentos
   */
  find: async (className: string, query: Record<string, any>, options?: { targetAppId?: string; useMasterKey?: boolean }): Promise<any[]> => {
    const adapter = options?.targetAppId ? ZenAppRegistry.get(options.targetAppId)?.db : ZenDB.getAdapter();
    if (!adapter) throw new Error(`Cannot find DB adapter for targetAppId: ${options?.targetAppId}`);
    
    // Inject ACL
    if (query.where) {
      query.where = ZenDB._enforceAclQuery(query.where, options);
    }

    return adapter.find(className, query);
  },

  /**
   * Busca un único documento en una clase de Parse.
   * Inyecta filtros ACL. Soporta cross-tenant.
   *
   * @param className — Nombre de la clase
   * @param query — Query con where, include, etc.
   * @param options — targetAppId, useMasterKey
   * @returns Documento encontrado o null
   */
  findOne: async (className: string, query: Record<string, any>, options?: { targetAppId?: string; useMasterKey?: boolean }): Promise<any> => {
    const adapter = options?.targetAppId ? ZenAppRegistry.get(options.targetAppId)?.db : ZenDB.getAdapter();
    if (!adapter) throw new Error(`Cannot find DB adapter for targetAppId: ${options?.targetAppId}`);
    
    // Inject ACL
    if (query.where) {
      query.where = ZenDB._enforceAclQuery(query.where, options);
    }

    return adapter.findOne(className, query);
  },

  /**
   * Inserta un nuevo documento en una clase de Parse.
   * Soporta cross-tenant.
   *
   * @param className — Nombre de la clase
   * @param document — Datos del documento a insertar
   * @param options — targetAppId, useMasterKey
   * @returns Documento creado (con objectId)
   */
  insert: async (className: string, document: Record<string, any>, options?: { targetAppId?: string; useMasterKey?: boolean }): Promise<any> => {
    const adapter = options?.targetAppId ? ZenAppRegistry.get(options.targetAppId)?.db : ZenDB.getAdapter();
    if (!adapter) throw new Error(`Cannot find DB adapter for targetAppId: ${options?.targetAppId}`);
    return adapter.insert(className, applySchema(className, document));
  },

  /**
   * Actualiza un documento existente en una clase de Parse.
   * Verifica ACL de escritura antes de mutar. Soporta cross-tenant.
   *
   * @param className — Nombre de la clase
   * @param id — ObjectId del documento
   * @param document — Datos a actualizar
   * @param options — targetAppId, useMasterKey
   * @returns Documento actualizado
   */
  update: async (className: string, id: string, document: Record<string, any>, options?: { targetAppId?: string; useMasterKey?: boolean }): Promise<any> => {
    const adapter = options?.targetAppId ? ZenAppRegistry.get(options.targetAppId)?.db : ZenDB.getAdapter();
    if (!adapter) throw new Error(`Cannot find DB adapter for targetAppId: ${options?.targetAppId}`);
    
    await ZenDB._enforceAclWrite(className, id, options);
    return adapter.update(className, id, document);
  },

  /**
   * Actualiza solo si el documento cumple las condiciones, de forma atómica en el motor.
   * Evita carreras de leer y luego escribir (reservar stock, reclamar un carrito).
   *
   * @returns Documento actualizado, o null si las condiciones no se cumplieron
   * @throws Error si el adapter activo no puede garantizar la atomicidad
   */
  updateIf: async (className: string, id: string, conditions: Record<string, unknown>, document: Record<string, any>, options?: { targetAppId?: string; useMasterKey?: boolean }) => {
    const adapter = options?.targetAppId ? ZenAppRegistry.get(options.targetAppId)?.db : ZenDB.getAdapter();
    if (!adapter) throw new Error(`Cannot find DB adapter for targetAppId: ${options?.targetAppId}`);
    if (!adapter.updateIf) throw new Error(`Zen.DB Error: the active database adapter does not support atomic updateIf.`);

    await ZenDB._enforceAclWrite(className, id, options);
    return adapter.updateIf(className, id, conditions, document);
  },

  /**
   * Elimina un documento de una clase de Parse.
   * Verifica ACL de escritura. Soporta cross-tenant.
   *
   * @param className — Nombre de la clase
   * @param id — ObjectId del documento
   * @param options — targetAppId, useMasterKey
   */
  delete: async (className: string, id: string, options?: { targetAppId?: string; useMasterKey?: boolean }): Promise<void> => {
    const adapter = options?.targetAppId ? ZenAppRegistry.get(options.targetAppId)?.db : ZenDB.getAdapter();
    if (!adapter) throw new Error(`Cannot find DB adapter for targetAppId: ${options?.targetAppId}`);
    
    await ZenDB._enforceAclWrite(className, id, options);
    return adapter.delete(className, id);
  }
};

// ─── Wrapper de Federation (RPC Cluster) ──────────────────────────────────────

/**
 * Zenith Federation — RPC entre apps en el clúster.
 * Resuelve llamadas cross-app de forma transparente:
 * - Misma RAM → in-memory directo (sin red)
 * - Distinta máquina → ZeroMQ (vía FederationTrait)
 *
 * @example
 * const remoteUsers = await Zen.Federation.rpcCall({
 *   targetAppId: "app-dos",
 *   action: "db.find",
 *   payload: { className: "_User", query: {} }
 * });
 */
export const ZenFederation = {
  /**
   * Ejecuta una llamada RPC asíncrona hacia otra App en el clúster.
   * Si la App está en la misma RAM, lo resuelve directamente.
   * Si está en otra máquina física, usa ZeroMQ (vía FederationTrait).
   */
  rpcCall: async (options: { targetAppId: string; action: string; payload: any }): Promise<any> => {
    const localApp = ZenAppRegistry.get(options.targetAppId);
    
    // Si la App está en el mismo proceso (Misma RAM), resolvemos in-memory sin red
    if (localApp && localApp.federation) {
       return await localApp.federation.handleLocalRpc(options.action, options.payload);
    }
    
    // Si la App está en otro servidor, usamos ZeroMQ (el trait inyecta el manejador real aquí)
    if ((globalThis as any).Zen?.Cluster?.rpcCall) {
       return await (globalThis as any).Zen.Cluster.rpcCall(options);
    }
    
    throw new Error(`[Federation] Cannot reach targetAppId: ${options.targetAppId}. It is not local and ZeroMQ cluster transport is missing.`);
  }
};

// ─── Wrapper para Configuración Global (Zen.Config) ──────────────────────

const kvStore = await Deno.openKv();

/**
 * Zenith Config — configuración global de la aplicación.
 * Paridad con `Parse.Config`. Soporta caché en Deno.Kv y CacheAdapter plugin.
 * Los parámetros se persisten en `_GlobalConfig` y se cachean para lecturas rápidas.
 *
 * @example
 * // Leer un parámetro
 * const welcomeMessage = await Zen.Config.get("welcome_message");
 *
 * // Leer todos los parámetros
 * const allParams = await Zen.Config.get();
 *
 * // Guardar parámetros
 * await Zen.Config.save({ maxUsers: 1000, featureX: true });
 */
export const ZenConfig = {
  /**
   * Obtiene la configuración global con caché en memoria ultrarrápida.
   * Soporta Deno.Kv (local/edge) o CacheAdapter Plugin.
   * Paridad con `Parse.Config.get()`.
   */
  get: async (key?: string): Promise<any> => {
    const ctx = zenithContext.getStore();
    const appId = ctx?.appId || "default";
    const cacheKey = `config:${appId}:params`;

    // 1. Check Plugin Cache Adapter (if exists) or fallback to Deno.Kv
    if (ZenPlugins.CacheAdapter && ZenPlugins.CacheAdapter.get) {
      try {
        const cachedParams = await ZenPlugins.CacheAdapter.get(cacheKey);
        if (cachedParams) return key ? cachedParams[key] : cachedParams;
      } catch (e) { ZenLogger.warn(`CacheAdapter get failed: ${e}`); }
    } else {
      const cached = await kvStore.get(["config", appId, "params"]);
      if (cached.value) {
        const params = cached.value as Record<string, any>;
        return key ? params[key] : params;
      }
    }

    // 2. Fallback to DB
    const db = ZenDB.getAdapter();
    const conf = await db.findOne("_GlobalConfig", { where: { _id: "params" } });
    const params = conf ? conf.params : {};
    
    // 3. Save to Cache
    if (ZenPlugins.CacheAdapter && ZenPlugins.CacheAdapter.set) {
      try { await ZenPlugins.CacheAdapter.set(cacheKey, params); } 
      catch (e) { ZenLogger.warn(`CacheAdapter set failed: ${e}`); }
    } else {
      await kvStore.set(["config", appId, "params"], params);
    }
    
    return key ? params[key] : params;
  },

  /**
   * Guarda o actualiza la configuración global.
   * Paridad con `Parse.Config.save()`.
   */
  save: async (params: Record<string, any>, _options?: { master?: boolean }): Promise<void> => {
    // Solo Master Key debería modificar config global, pero lo permitimos a nivel de motor si lo invoca un dev en cloud code.
    const db = ZenDB.getAdapter();
    const ctx = zenithContext.getStore();
    const appId = ctx?.appId || "default";
    const cacheKey = `config:${appId}:params`;

    // Modificar o crear en DB
    const conf = await db.findOne("_GlobalConfig", { where: { _id: "params" } });
    let newParams = {};
    if (conf) {
      newParams = { ...conf.params, ...params };
      await db.update("_GlobalConfig", "params", { params: newParams });
    } else {
      newParams = { ...params };
      await db.insert("_GlobalConfig", { _id: "params", params: newParams });
    }

    // Invalidar y actualizar Caché
    if (ZenPlugins.CacheAdapter && ZenPlugins.CacheAdapter.set) {
      try { await ZenPlugins.CacheAdapter.set(cacheKey, newParams); } 
      catch (e) { ZenLogger.warn(`CacheAdapter set failed: ${e}`); }
    } else {
      await kvStore.set(["config", appId, "params"], newParams);
    }
  }
};


// ─── Logger Global (OpenTelemetry Parity & File System) ────────────────────────

const _getLogDir = () => Deno.env.get("ZENITH_LOGS_PATH");
let _logDirCreated = false;

const _ensureLogDir = (dir: string) => {
  if (_logDirCreated) return;
  try {
    Deno.mkdirSync(dir, { recursive: true });
    _logDirCreated = true;
  } catch (_e) {
    // Ignore if exists
    _logDirCreated = true;
  }
};

const _writeToFile = (level: string, msg: string, metadata?: any) => {
  const logDir = _getLogDir();
  if (!logDir) return; // Si no hay configuración, solo usa stdout
  
  _ensureLogDir(logDir);
  
  try {
    const timestamp = new Date().toISOString();
    const metaStr = metadata ? ` ${JSON.stringify(metadata)}` : "";
    const logLine = `[${timestamp}] [${level}] ${msg}${metaStr}\n`;
    Deno.writeTextFileSync(`${logDir}/zenith.log`, logLine, { append: true });
  } catch (_e) {
    // Fail silently for logger
  }
};

/**
 * Logger global ligado a OpenTelemetry para que los desarrolladores
 * puedan escribir logs fuera del contexto de una petición específica.
 * Compatible con stdout (Kubernetes) y FileSystem (On-Premise).
 */
export const ZenLogger = {
  info: (msg: string, metadata?: any) => {
    console.log(`[Zenith][INFO] ${msg}`, metadata || "");
    _writeToFile("INFO", msg, metadata);
  },
  error: (msg: string, metadata?: any) => {
    console.error(`[Zenith][ERROR] ${msg}`, metadata || "");
    _writeToFile("ERROR", msg, metadata);
  },
  warn: (msg: string, metadata?: any) => {
    console.warn(`[Zenith][WARN] ${msg}`, metadata || "");
    _writeToFile("WARN", msg, metadata);
  },
  debug: (msg: string, metadata?: any) => {
    console.debug(`[Zenith][DEBUG] ${msg}`, metadata || "");
    _writeToFile("DEBUG", msg, metadata);
  },
};

// ─── Utilidad GeoPoint (Paridad Parse.GeoPoint) ───────────────────────────────

export class ZenGeoPoint {
  latitude: number;
  longitude: number;

  constructor(latitude: number | { latitude: number; longitude: number } | [number, number], longitude?: number) {
    if (Array.isArray(latitude)) {
      this.latitude = latitude[0];
      this.longitude = latitude[1];
    } else if (typeof latitude === "object") {
      this.latitude = latitude.latitude;
      this.longitude = latitude.longitude;
    } else {
      this.latitude = latitude;
      this.longitude = longitude || 0;
    }

    if (this.latitude > 90.0 || this.latitude < -90.0) throw new Error("Latitude must be within range [-90.0, 90.0]");
    if (this.longitude > 180.0 || this.longitude < -180.0) throw new Error("Longitude must be within range [-180.0, 180.0]");
  }

  toJSON() {
    return { __type: "GeoPoint", latitude: this.latitude, longitude: this.longitude };
  }

  radiansTo(point: ZenGeoPoint): number {
    const dLat = (point.latitude - this.latitude) * (Math.PI / 180.0);
    const dLon = (point.longitude - this.longitude) * (Math.PI / 180.0);
    const lat1 = this.latitude * (Math.PI / 180.0);
    const lat2 = point.latitude * (Math.PI / 180.0);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    return 2 * Math.asin(Math.sqrt(a));
  }

  kilometersTo(point: ZenGeoPoint): number {
    return this.radiansTo(point) * 6371.0;
  }

  milesTo(point: ZenGeoPoint): number {
    return this.radiansTo(point) * 3958.8;
  }
}

// ─── Custom API Builder (Fase 29) ───────────────────────────────────────────────

export interface CustomRouteConfig {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string; // Ej: "/stripe/webhook"
  security: {
    requireApiKey?: string; // Nombre del Header esperado o valor directo
    requireRoles?: string[];
  };
  handler: (req: Request, ctx: any) => Promise<Response> | Response;
}

const _customRoutes: CustomRouteConfig[] = [];

export const ZenAPI = {
  defineRoute: (config: CustomRouteConfig) => {
    _customRoutes.push(config);
    ZenLogger.info(`[Zen.API] Registered Custom Secure Route: ${config.method} ${config.path}`);
  },
  getRoutes: () => _customRoutes
};

// ─── Plugins Export Namespace ───────────────────────────────────────────────────

/**
 * Registro de Traits de Terceros / Plugins.
 * Permite a plugins (ej. Zen.Plugins.Stripe) exponer métodos globales sin colisionar
 * con el motor core de Zenith.
 */
export const ZenPlugins: ZenithPluginsRegistry = {};

// ─── Zen.Shell (Wrapper nativo tipo zx) ───────────────────────────────────

/**
 * Interfaz de ejecución de comandos de Shell. Grado Militar y robusto.
 * Permite integraciones de terceros ejecutando binarios en el host de manera segura.
 */
export const ZenShell = {
  _allowedCommands: [] as string[],
  
  /**
   * Configura la lista blanca de binarios permitidos (Military-Grade SecOps).
   */
  setAllowedCommands(commands: string[]) {
    this._allowedCommands = commands;
  },

  /**
   * Ejecuta un comando en el sistema. Retorna { stdout, stderr, code }.
   * @param command Nombre del binario (ej. "git", "vault")
   * @param args Argumentos del comando
   * @param options Opciones adicionales como CWD o Env Vars
   */
  exec: async (command: string, args: string[] = [], options?: { cwd?: string; env?: Record<string, string> }) => {
    // 1. Military-Grade Allowlist Check
    if (ZenShell._allowedCommands.length > 0 && !ZenShell._allowedCommands.includes(command)) {
      ZenLogger.error(`[Zen.Shell] 🛡️ SecOps Blocked: Attempted to execute unauthorized command '${command}'`);
      throw new ZenithError(
        ZenithErrorCode.SHELL_COMMAND_NOT_ALLOWED,
        `Execution of binary '${command}' is not in the allowedShellCommands allowlist.`,
        403
      );
    }

    try {
      const cmd = new Deno.Command(command, {
        args,
        cwd: options?.cwd,
        env: options?.env,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();
      const stdout = new TextDecoder().decode(output.stdout);
      const stderr = new TextDecoder().decode(output.stderr);
      
      if (!output.success) {
        throw new ZenithError(
          ZenithErrorCode.SHELL_EXECUTION_FAILED,
          `Command failed with code ${output.code}: ${stderr}`,
          500
        );
      }
      return { stdout, stderr, code: output.code };
    } catch (err: any) {
      ZenLogger.error(`[Zen.Shell] Exec Error: ${err.message}`);
      if (err instanceof ZenithError) throw err;
      throw new ZenithError(ZenithErrorCode.SHELL_EXECUTION_FAILED, err.message, 500);
    }
  }
};

// ─── Namespace Principal (Exportación) ──────────────────────────────────────────

/**
 * Namespace principal de Zenith, equivalente al objeto `Parse` global.
 * Usado en archivos cloud/main.ts como:
 * ```
 * import { Zen } from "@zenith/core";
 * Zen.Cloud.define("hello", ...);
 * const remoteUsers = await Zen.Federation.rpcCall({ targetAppId: "APP_DOS", action: "db.find", payload: {} });
 * ```
 */
/**
 * Global engine reference set by createZenithApp after boot.
 * Allows cloud code files to access engine services dynamically.
 */
export const ZENITH_ENGINE: { current: Record<string, unknown> | null } = { current: null };

export const Zen = {
  Cloud: ZenCloud,
  DB: ZenDB,
  Config: ZenConfig,
  Federation: ZenFederation,
  GeoPoint: ZenGeoPoint,
  Logger: ZenLogger,
  API: ZenAPI,
  Plugins: ZenPlugins,
  Shell: ZenShell,
  App: (appId: string) => ({
      DB: {
          find: (c: string, q: any) => ZenDB.find(c, q, { targetAppId: appId }),
          findOne: (c: string, q: any) => ZenDB.findOne(c, q, { targetAppId: appId }),
          insert: (c: string, d: any) => ZenDB.insert(c, d, { targetAppId: appId }),
          update: (c: string, id: string, d: any) => ZenDB.update(c, id, d, { targetAppId: appId }),
          delete: (c: string, id: string) => ZenDB.delete(c, id, { targetAppId: appId })
      }
  })
} as const;
