/**
 * @module @zuccadev-labs/zenith/crm
 *
 * Enterprise CRM SDK — 100% acoplado al ZenithCRMTrait del backend.
 * Provee tipado fuerte para Contact, Lead, Deal y operaciones de Pipeline.
 * Reutiliza el RESTController del SDK para auth, retry y error handling.
 */

import { RESTController } from "../rest/RESTController.js";

// ─── Tipos del dominio CRM ────────────────────────────────────────────────────

export type CRMPointer = { __type: "Pointer"; className: string; objectId: string };

export interface CRMContact {
  objectId?: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  title?: string;
  tags?: string[];
  source?: "manual" | "web" | "import" | "referral" | "campaign";
  score?: number;
  notes?: string;
  owner?: CRMPointer;
  createdAt?: string;
  updatedAt?: string;
}

export interface CRMLead {
  objectId?: string;
  contact: CRMPointer;
  owner: CRMPointer;
  stage?: "new" | "contacted" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
  value?: number;
  currency?: string;
  probability?: number;
  closeDate?: string;
  lostReason?: string;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CRMDeal {
  objectId?: string;
  title: string;
  stage: string;
  pipeline?: string;
  amount?: number;
  currency?: string;
  owner?: CRMPointer;
  closeDate?: string;
  wonAt?: string;
  lostAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CRMListOptions {
  limit?: number;
  skip?: number;
  order?: string;
  where?: Record<string, unknown>;
  count?: boolean;
}

export interface CRMListResult<T> {
  results: T[];
  count?: number;
}

export interface LeadConvertResult {
  deal: CRMDeal;
  leadId: string;
  converted: boolean;
}

export interface LeadQualifyResult {
  leadId: string;
  score: number;
  breakdown: { activityScore: number; valueScore: number; stageScore: number };
}

export interface PipelineSummary {
  stages: Array<{ stage: string; count: number; totalAmount: number; deals: Array<{ objectId: string; title: string; amount: number }> }>;
  totalDeals: number;
  grandTotal: number;
}

// ─── ZenithCRM ───────────────────────────────────────────────────────────────

/**
 * SDK para el módulo CRM corporativo de Zenith.
 * Todos los métodos utilizan el RESTController centralizado (auth, headers, retry).
 *
 * @example
 * ```ts
 * import { ZenithCRM } from "@zuccadev-labs/zenith/crm";
 *
 * const contact = await ZenithCRM.Contacts.create({ name: "Jane Doe", email: "jane@corp.com" });
 * const lead    = await ZenithCRM.Leads.create({ contactId: contact.objectId!, value: 50000 });
 * const result  = await ZenithCRM.Leads.convertToDeal(lead.objectId!, { dealTitle: "Acuerdo 2025" });
 * ```
 */
export class ZenithCRM {

  // ── Contacts ────────────────────────────────────────────────────────────────

  static readonly Contacts = {

    /** Lista contactos con soporte de paginación, filtros y orden. */
    async list(options: CRMListOptions = {}): Promise<CRMListResult<CRMContact>> {
      const params: Record<string, any> = {};
      if (options.limit !== undefined) params.limit = options.limit;
      if (options.skip  !== undefined) params.skip  = options.skip;
      if (options.order !== undefined) params.order = options.order;
      if (options.where !== undefined) params.where = options.where;
      if (options.count)               params.count = "1";
      return RESTController.request("GET", "/zen/crm/contacts", params);
    },

    /** Obtiene un contacto por su objectId. */
    async get(objectId: string): Promise<CRMContact> {
      return RESTController.request("GET", `/zen/crm/contacts/${objectId}`);
    },

    /** Crea un nuevo contacto CRM. Requiere: name, email. */
    async create(data: Omit<CRMContact, "objectId" | "createdAt" | "updatedAt">): Promise<CRMContact> {
      return RESTController.request("POST", "/zen/crm/contacts", data);
    },

    /** Actualiza un contacto existente de forma parcial (PATCH semantics vía PUT). */
    async update(objectId: string, data: Partial<CRMContact>): Promise<CRMContact> {
      return RESTController.request("PUT", `/zen/crm/contacts/${objectId}`, data);
    },

    /** Elimina un contacto. Retorna 204 No Content. */
    async delete(objectId: string): Promise<void> {
      await RESTController.request("DELETE", `/zen/crm/contacts/${objectId}`);
    },
  };

  // ── Leads ────────────────────────────────────────────────────────────────────

  static readonly Leads = {

    /** Lista leads con soporte de paginación y filtros. */
    async list(options: CRMListOptions = {}): Promise<CRMListResult<CRMLead>> {
      const params: Record<string, any> = {};
      if (options.limit !== undefined) params.limit = options.limit;
      if (options.skip  !== undefined) params.skip  = options.skip;
      if (options.order !== undefined) params.order = options.order;
      if (options.where !== undefined) params.where = options.where;
      return RESTController.request("GET", "/zen/crm/leads", params);
    },

    /** Obtiene un lead por su objectId. */
    async get(objectId: string): Promise<CRMLead> {
      return RESTController.request("GET", `/zen/crm/leads/${objectId}`);
    },

    /**
     * Crea un nuevo lead. Requiere `contactId` (objectId del contacto).
     * El `owner` se asigna automáticamente desde la sesión si no se provee.
     */
    async create(data: { contactId: string; value?: number; stage?: CRMLead["stage"]; currency?: string; probability?: number; closeDate?: string }): Promise<CRMLead> {
      return RESTController.request("POST", "/zen/crm/leads", data);
    },

    /** Actualiza un lead. */
    async update(objectId: string, data: Partial<CRMLead>): Promise<CRMLead> {
      return RESTController.request("PUT", `/zen/crm/leads/${objectId}`, data);
    },

    /** Elimina un lead. */
    async delete(objectId: string): Promise<void> {
      await RESTController.request("DELETE", `/zen/crm/leads/${objectId}`);
    },

    /**
     * Califica un lead usando el algoritmo de Lead Scoring del backend.
     * Calcula score = activityScore×0.4 + valueScore×0.4 + stageScore×0.2
     */
    async qualify(leadId: string): Promise<LeadQualifyResult> {
      return RESTController.request("POST", `/zen/crm/leads/${leadId}/qualify`, {});
    },

    /**
     * Convierte un Lead cualificado en un Deal.
     * El Lead pasa a stage "won". Operación atómica en el backend.
     */
    async convertToDeal(leadId: string, options: { dealTitle?: string; amount?: number; pipeline?: string; stage?: string; closeDate?: string } = {}): Promise<LeadConvertResult> {
      return RESTController.request("POST", `/zen/crm/leads/${leadId}/convert`, options);
    },
  };

  // ── Deals ────────────────────────────────────────────────────────────────────

  static readonly Deals = {

    /** Lista deals con paginación y filtros. */
    async list(options: CRMListOptions = {}): Promise<CRMListResult<CRMDeal>> {
      const params: Record<string, any> = {};
      if (options.limit !== undefined) params.limit = options.limit;
      if (options.skip  !== undefined) params.skip  = options.skip;
      if (options.order !== undefined) params.order = options.order;
      if (options.where !== undefined) params.where = options.where;
      return RESTController.request("GET", "/zen/crm/deals", params);
    },

    /** Obtiene un deal por su objectId. */
    async get(objectId: string): Promise<CRMDeal> {
      return RESTController.request("GET", `/zen/crm/deals/${objectId}`);
    },

    /**
     * Crea un deal. Requiere: title, stage.
     * El owner se asigna desde la sesión activa.
     */
    async create(data: Omit<CRMDeal, "objectId" | "createdAt" | "updatedAt">): Promise<CRMDeal> {
      return RESTController.request("POST", "/zen/crm/deals", data);
    },

    /** Actualiza un deal. */
    async update(objectId: string, data: Partial<CRMDeal>): Promise<CRMDeal> {
      return RESTController.request("PUT", `/zen/crm/deals/${objectId}`, data);
    },

    /** Elimina un deal. */
    async delete(objectId: string): Promise<void> {
      await RESTController.request("DELETE", `/zen/crm/deals/${objectId}`);
    },
  };

  // ── Pipeline Analytics ───────────────────────────────────────────────────────

  static readonly Pipeline = {

    /**
     * Retorna el resumen del pipeline: deals agrupados por stage con
     * totales financieros. Ideal para vistas Kanban y dashboards ejecutivos.
     */
    async summary(): Promise<PipelineSummary> {
      return RESTController.request("GET", "/zen/crm/pipeline/summary");
    },
  };
}
