// ─── Core ─────────────────────────────────────────────────────────────────────
export { Zenith } from "./core/Zenith.js";
export { ZenithError, ZenithErrorCode } from "./core/ZenithError.js";
export type { ZenithConfig, ZenithContext } from "./types/ZenithConfig.js";
export { ZenithStorage, WebStorageAdapter, MemoryStorageAdapter, CookieStorageAdapter } from "./core/StorageController.js";
export type { StorageController } from "./core/StorageController.js";

// ─── Data Objects ─────────────────────────────────────────────────────────────
export { ZenithObject } from "./objects/ZenithObject.js";
export type { ZenithPointer } from "./objects/ZenithObject.js";
export { ZenithUser } from "./objects/ZenithUser.js";
export { ZenithQuery } from "./objects/ZenithQuery.js";
export { ZenithCloud } from "./objects/ZenithCloud.js";
export { ZenithFile, ZenithAPIKey } from "./objects/ZenithFile.js";

// ─── Real-time ────────────────────────────────────────────────────────────────
export {
  LiveQueryClient,
  ZenithLiveQueryClient,
  ZenithLiveQuerySubscription,
} from "./livequery/livequery.js";
export type { LiveQueryEvent, LiveQueryErrorCallback, SubscriptionCallback } from "./livequery/livequery.js";

// ─── Media ────────────────────────────────────────────────────────────────────
export { ZenithMediaRoom } from "./media/media.js";
export type { MediaRoomOptions } from "./media/media.js";

// ─── Business Logic (CRM / ERP) ──────────────────────────────────────────────
export { ZenithCRM } from "./crm/ZenithCRM.js";
export type {
  CRMContact,
  CRMLead,
  CRMDeal,
  CRMPointer,
  CRMListOptions,
  CRMListResult,
  LeadConvertResult,
  LeadQualifyResult,
  PipelineSummary,
} from "./crm/ZenithCRM.js";

export { ZenithERP } from "./erp/ZenithERP.js";
export type {
  ERPProduct,
  ERPOrder,
  ERPOrderLine,
  ERPInvoice,
  ERPInvoiceLine,
  ERPEmployee,
  ERPInventoryStock,
  ERPPointer,
  ERPListOptions,
  ERPListResult,
  FulfillOrderResult,
} from "./erp/ZenithERP.js";

// ─── Fase 2: Notifications / Favorites+Tags / Webhooks / CSV ─────────────────
export { ZenithNotifications } from "./notifications/ZenithNotifications.js";
export type { ZenithNotification } from "./notifications/ZenithNotifications.js";

export { ZenithFavoritesTags } from "./favtags/ZenithFavoritesTags.js";
export type { ZenithFavorite, ZenithTag, ZenithTagAssign } from "./favtags/ZenithFavoritesTags.js";

export { ZenithWebhooks } from "./webhooks/ZenithWebhooks.js";
export type { ZenithWebhook, ZenithWebhookAttempt, ZenithWebhookDelivery, ZenithWebhookMessage } from "./webhooks/ZenithWebhooks.js";

export { ZenithCSV } from "./automation/ZenithAutomationCSV.js";
export type { CSVImportResult, CSVSupportedClass } from "./automation/ZenithAutomationCSV.js";

// ─── Fase 3: Email / Calendar / Automation ───────────────────────────────────
export { ZenithEmail } from "./comms/ZenithEmailCalendar.js";
export type { EmailChannel, MessageThread, EmailMessage } from "./comms/ZenithEmailCalendar.js";

export { ZenithCalendar } from "./comms/ZenithEmailCalendar.js";
export type { CalendarChannel, CalendarEvent, CalendarSlot } from "./comms/ZenithEmailCalendar.js";

export { ZenithAutomation } from "./automation/ZenithAutomationCSV.js";
export type {
  AutomationRule, AutomationLog, AutoAction,
  AutoCondition, AutoConditionGroup, ActionType, ConditionOp,
} from "./automation/ZenithAutomationCSV.js";

// ─── React ───────────────────────────────────────────────────────────────────
// Exported as a subpath: @zuccadev-labs/zenith-client/react
// Usage: import { ZenithProvider, useZenithUser } from '@zuccadev-labs/zenith-client/react';
