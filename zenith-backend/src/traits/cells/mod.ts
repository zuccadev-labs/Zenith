/**
 * @module @zenith/traits/cells
 *
 * Cells (ADR-019): the binding surface (Cloudflare Durable Objects API), the `local` and `celld`
 * providers, KV and Queue bindings.
 */
export * from "./types.ts";
export { CellId, CellIdFactory } from "./ids.ts";
export { CellStorage, type CellStorageOptions, MAX_KEY_BYTES, MAX_VALUE_BYTES } from "./storage.ts";
export {
  type CellClassOptions,
  type CellsStats,
  type LocalCellsOptions,
  LocalCellsProvider,
} from "./local.ts";
export {
  KV_CELL_CLASS,
  type KVGetType,
  type KVListOptions,
  type KVListResult,
  type KVNamespace,
  kvNamespace,
  type KVPutOptions,
  ZenithKVCell,
} from "./kv.ts";
export {
  type JobQueueLike,
  type MessageBatch,
  type Queue,
  queueBinding,
  type QueueConsumer,
  queueJobType,
  type QueueMessage,
  type QueueSendOptions,
  registerQueueConsumer,
} from "./queue.ts";
export {
  type CelldCellClass,
  CelldCellsClient,
  type CelldClientOptions,
  celldDeploy,
  type CelldDeployOptions,
  type CelldDevNode,
  celldEntryModule,
  type CelldNamespace,
  type CelldProject,
  type CelldProjectOptions,
  type CelldWranglerConfig,
  celldWranglerConfig,
  generateCelldProject,
  startCelldDev,
} from "./celld.ts";
export { type CellsApi, type CellsConfig, type CellsDeps, createCellsApi } from "./api.ts";
export {
  type CellDefinition,
  cellDefinitions,
  type CellsHandle,
  cellsOf,
  createZenCells,
  defineCellClass,
  type ZenCellsAPI,
} from "./registry.ts";
export { cellsRoutes, CellsTrait } from "./cells.trait.ts";
