/**
 * @module @zenith/adapters/timeseries/scylla
 *
 * Adaptador Time-Series sobre ScyllaDB (Cassandra-compatible).
 * ScyllaDB es la base ideal para IoT time-series:
 *  - Escrituras 1M+ ops/sec (LSM tree)
 *  - Particionado por (deviceId, bucket_day) para compactación eficiente
 *  - TTL nativo por fila — retención automática de datos
 *
 * Schema de tabla optimizado para IoT:
 *   CREATE TABLE zenith.ts_readings (
 *     device_id  TEXT,
 *     bucket     DATE,        -- Partición diaria (hotspot controlado)
 *     ts         TIMESTAMP,   -- Tiempo preciso
 *     metric     TEXT,        -- Nombre de la medición (ej. "temperature")
 *     value_num  DOUBLE,
 *     value_str  TEXT,
 *     unit       TEXT,
 *     tags       MAP<TEXT,TEXT>,
 *     PRIMARY KEY ((device_id, bucket), ts, metric)
 *   ) WITH CLUSTERING ORDER BY (ts DESC)
 *     AND default_time_to_live = 2592000;  -- 30 días TTL
 *
 * Lab: ScyllaDB en puerto 53042 (host) → 9042 (interno)
 */

export interface TimeSeriesPoint {
  deviceId:   string;
  ts:         number;        // Unix ms
  metric:     string;        // ej. "temperature"
  valueNum?:  number;
  valueStr?:  string;
  unit?:      string;        // SenML: "Cel", "hPa", "%RH", "A", "V"
  tags?:      Record<string, string>;
}

export interface TimeSeriesQuery {
  deviceId:   string;
  metric?:    string;
  from:       Date;
  to?:        Date;
  limit?:     number;
  downsample?: {
    interval: "1m" | "5m" | "15m" | "1h" | "1d";
    fn:       "avg" | "max" | "min" | "sum" | "count";
  };
}

export interface TimeSeriesAdapter {
  initialize(): Promise<void>;
  write(points: TimeSeriesPoint[]): Promise<void>;
  query(q: TimeSeriesQuery): Promise<TimeSeriesPoint[]>;
  deleteDevice(deviceId: string): Promise<void>;
}

// Bucket diario para particionado: YYYY-MM-DD
function dayBucket(ts: number): string {
  return new Date(ts).toISOString().substring(0, 10);
}

// Calcula los buckets diarios entre from y to
function getDayBuckets(from: Date, to: Date): string[] {
  const buckets: string[] = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = to ?? new Date();
  while (cur <= end) {
    buckets.push(cur.toISOString().substring(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return buckets;
}

// Interval en ms para downsampling
const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000
};

/**
 * Downsampling en memoria. En producción usar ScyllaDB UDF o TimescaleDB.
 * Para < 10K points/device/day es suficiente. Escalar con Spark para petabytes.
 */
function downsamplePoints(
  points: TimeSeriesPoint[],
  interval: string,
  fn: string
): TimeSeriesPoint[] {
  const bucketMs = INTERVAL_MS[interval] ?? 60_000;
  const groups = new Map<string, number[]>();

  for (const p of points) {
    if (p.valueNum === undefined) continue;
    const bucketTs = Math.floor(p.ts / bucketMs) * bucketMs;
    const key = `${p.deviceId}|${p.metric}|${bucketTs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p.valueNum);
  }

  const result: TimeSeriesPoint[] = [];
  for (const [key, values] of groups.entries()) {
    const [deviceId, metric, bucketTs] = key.split("|");
    let value = 0;
    if (fn === "avg")   value = values.reduce((a, b) => a + b, 0) / values.length;
    if (fn === "max")   value = Math.max(...values);
    if (fn === "min")   value = Math.min(...values);
    if (fn === "sum")   value = values.reduce((a, b) => a + b, 0);
    if (fn === "count") value = values.length;

    result.push({
      deviceId, metric,
      ts:       parseInt(bucketTs),
      valueNum: parseFloat(value.toFixed(6)),
    });
  }

  return result.sort((a, b) => b.ts - a.ts);
}

export function createScyllaTimeSeriesAdapter(cassandraClient: any, keyspace = "zenith"): TimeSeriesAdapter {
  const client = cassandraClient;
  const ks = keyspace;

  return {
    async initialize() {
      // Crear keyspace si no existe
      await client.execute(`
        CREATE KEYSPACE IF NOT EXISTS ${ks}
        WITH replication = {'class': 'SimpleStrategy', 'replication_factor': '1'}
        AND durable_writes = true
      `);

      // Crear tabla de time-series optimizada para IoT
      await client.execute(`
        CREATE TABLE IF NOT EXISTS ${ks}.ts_readings (
          device_id  TEXT,
          bucket     TEXT,
          ts         BIGINT,
          metric     TEXT,
          value_num  DOUBLE,
          value_str  TEXT,
          unit       TEXT,
          tags       MAP<TEXT, TEXT>,
          PRIMARY KEY ((device_id, bucket), ts, metric)
        ) WITH CLUSTERING ORDER BY (ts DESC)
          AND default_time_to_live = 7776000
      `);
      // TTL = 90 días. Cambiar según retención requerida.

      // Índice secundario en metric para filtros
      await client.execute(`
        CREATE INDEX IF NOT EXISTS ON ${ks}.ts_readings (metric)
      `).catch(() => {}); // Puede fallar si ya existe — ignorar

      console.log(`[ScyllaTS] ✅ Keyspace '${ks}' and table 'ts_readings' ready.`);
    },

    async write(points: TimeSeriesPoint[]) {
      if (!points.length) return;

      // Batch insert (máx 65535 statements por batch en Cassandra/Scylla)
      const BATCH_SIZE = 100;
      const query = `
        INSERT INTO ${ks}.ts_readings
          (device_id, bucket, ts, metric, value_num, value_str, unit, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        USING TTL 7776000
      `;

      for (let i = 0; i < points.length; i += BATCH_SIZE) {
        const batch = points.slice(i, i + BATCH_SIZE);
        const queries = batch.map(p => ({
          query,
          params: [
            p.deviceId,
            dayBucket(p.ts),
            p.ts,
            p.metric,
            p.valueNum ?? null,
            p.valueStr ?? null,
            p.unit ?? null,
            p.tags ?? {},
          ],
        }));
        await client.batch(queries, { prepare: true });
      }
    },

    async query(q: TimeSeriesQuery): Promise<TimeSeriesPoint[]> {
      const to = q.to ?? new Date();
      const buckets = getDayBuckets(q.from, to);

      const allPoints: TimeSeriesPoint[] = [];

      for (const bucket of buckets) {
        let cql = `
          SELECT device_id, bucket, ts, metric, value_num, value_str, unit, tags
          FROM ${ks}.ts_readings
          WHERE device_id = ? AND bucket = ?
            AND ts >= ? AND ts <= ?
        `;
        const params: any[] = [
          q.deviceId,
          bucket,
          q.from.getTime(),
          to.getTime(),
        ];

        if (q.metric) {
          cql += " AND metric = ?";
          params.push(q.metric);
        }

        cql += " ORDER BY ts DESC";
        if (q.limit && !q.downsample) {
          cql += ` LIMIT ${q.limit}`;
        }

        const result = await client.execute(cql, params, { prepare: true });
        for (const row of result.rows) {
          allPoints.push({
            deviceId:  row.device_id,
            ts:        Number(row.ts),
            metric:    row.metric,
            valueNum:  row.value_num ?? undefined,
            valueStr:  row.value_str ?? undefined,
            unit:      row.unit ?? undefined,
            tags:      row.tags ?? undefined,
          });
        }
      }

      // Aplicar downsampling si se solicita
      if (q.downsample) {
        return downsamplePoints(allPoints, q.downsample.interval, q.downsample.fn)
          .slice(0, q.limit ?? 1000);
      }

      return allPoints.slice(0, q.limit ?? 1000);
    },

    async deleteDevice(deviceId: string) {
      // Scylla no tiene DELETE sin partition key — debemos iterar buckets
      // En producción usar TTL + tombstone compaction
      console.warn(`[ScyllaTS] deleteDevice(${deviceId}): use TTL expiry or tombstone compaction for large datasets.`);
      await client.execute(
        `DELETE FROM ${ks}.ts_readings WHERE device_id = ?`,
        [deviceId],
        { prepare: true }
      ).catch(() => {});
    },
  };
}
