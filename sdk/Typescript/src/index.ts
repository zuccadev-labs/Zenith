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

// ─── React ───────────────────────────────────────────────────────────────────
// Exported as a subpath: @zuccadev-labs/zenith/react
// Usage: import { ZenithProvider, useZenithUser } from '@zuccadev-labs/zenith/react';
