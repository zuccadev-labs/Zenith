/**
 * @module @zenith/observability
 *
 * Public API de observabilidad.
 */

export {
  MetricRegistry,
  type MetricType,
  type Label,
  type MetricSample,
  type HistogramBucket,
  type RegistryOptions,
  type TimeSeries,
  labelKey,
  validateLabelName,
} from "./metric-registry.ts";

export {
  PrometheusRemoteWriter,
  serializeToJson,
  type RemoteWriteConfig,
  type RemoteWriteState,
  type LoggerLike,
} from "./prometheus-remote-write.ts";

export {
  LokiShipper,
  serializeToLokiJson,
  type LokiConfig,
  type LokiState,
  type LokiLogEntry,
  type LokiStream,
} from "./loki-shipper.ts";
