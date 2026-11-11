/**
 * @module @zenith/observability
 *
 * Public API de observabilidad.
 */

export {
  type HistogramBucket,
  type Label,
  labelKey,
  MetricRegistry,
  type MetricSample,
  type MetricType,
  type RegistryOptions,
  type TimeSeries,
  validateLabelName,
} from "./metric-registry.ts";

export {
  type LoggerLike,
  PrometheusRemoteWriter,
  type RemoteWriteConfig,
  type RemoteWriteState,
  serializeToJson,
} from "./prometheus-remote-write.ts";

export {
  type LokiConfig,
  type LokiLogEntry,
  LokiShipper,
  type LokiState,
  type LokiStream,
  serializeToLokiJson,
} from "./loki-shipper.ts";
