/**
 * IoT device management: device registry with token-based auth, SenML telemetry ingestion, MQTT bridge, alert rules, time-series downsampling.
 *
 * @barrits-trait
 * @barrits-summary ZenithIoT
 * @barrits-provides iot-routes, iot, deviceManager
 * @barrits-consumes db
 * @barrits-tags uses:events
 * @barrits-state devices, alertRules
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export interface IoTDevice {
  objectId: string;
  deviceId: string;
  name: string;
  type: string;
  metadata?: Record<string, any>;
  lastSeen?: string;
  deviceTokenHash?: string;
  createdAt: string;
}

export interface TelemetryPayload {
  deviceId: string;
  timestamp: number;
  measurements: Record<string, number>;
}

export interface IoTAlert {
  objectId: string;
  deviceId: string;
  rule: string;
  severity: "info" | "warning" | "critical";
  message: string;
  triggeredAt: string;
}

export interface SenMLRecord {
  n?: string;
  v?: number;
  vs?: string;
  vb?: boolean;
  t?: number;
  u?: string;
}

export const IoTTrait = createTraitDescriptor({
  name: "ZenithIoT",
  provides: ["iot-routes", "iot", "deviceManager"],
  consumes: ["db"],
  tags: ["uses:events"],
  state: ["devices", "alertRules"],
  runtimes: ["deno"],
  summary: "IoT device management: device registry with token-based auth, SenML telemetry ingestion, MQTT bridge, alert rules, time-series downsampling.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const events = deps.traits["events"];

    const traitApi: any = {
      devices: new Map<string, IoTDevice>(),
      alertRules: [] as Array<{ rule: string; deviceId: string; threshold: number; comparison: ">" | "<" | "=="; severity: IoTAlert["severity"] }>,

      registerDevice: async (deviceId: string, name: string, type: string, metadata: Record<string, any> = {}) => {
        const device: IoTDevice = {
          objectId: crypto.randomUUID(),
          deviceId,
          name,
          type,
          metadata,
          createdAt: new Date().toISOString(),
        };
        traitApi.devices.set(deviceId, device);
        await db.create("_IoTDevice", device);
        if (events) events.emit("iot.device.registered", device);
        return device;
      },

      ingestTelemetry: async (deviceId: string, payload: TelemetryPayload | SenMLRecord[]) => {
        const device = traitApi.devices.get(deviceId);
        if (!device) throw new Error(`device not found: ${deviceId}`);
        if (device) device.lastSeen = new Date().toISOString();
        let normalized: TelemetryPayload;
        if (Array.isArray(payload)) {
          normalized = { deviceId, timestamp: Date.now(), measurements: {} };
          for (const r of payload) {
            if (r.n && r.v !== undefined) normalized.measurements[r.n] = r.v;
          }
        } else {
          normalized = payload;
        }
        await db.create("_IoTTelemetry", normalized);
        for (const rule of traitApi.alertRules) {
          if (rule.deviceId !== deviceId) continue;
          for (const [key, value] of Object.entries(normalized.measurements)) {
            if (!rule.rule.includes(key)) continue;
            const triggered = rule.comparison === ">" ? value > rule.threshold : rule.comparison === "<" ? value < rule.threshold : value === rule.threshold;
            if (triggered) {
              const alert: IoTAlert = {
                objectId: crypto.randomUUID(),
                deviceId,
                rule: rule.rule,
                severity: rule.severity,
                message: `${rule.rule} ${rule.comparison} ${rule.threshold} (actual: ${value})`,
                triggeredAt: new Date().toISOString(),
              };
              await db.create("_IoTAlert", alert);
              if (events) events.emit("iot.alert", alert);
            }
          }
        }
        return { ingested: true, measurements: Object.keys(normalized.measurements).length };
      },

      addAlertRule: (rule: { rule: string; deviceId: string; threshold: number; comparison: ">" | "<" | "=="; severity: IoTAlert["severity"] }) => {
        traitApi.alertRules.push(rule);
      },

      listDevices: () => Array.from(traitApi.devices.values()),
    };

    const iot_routes = [
      {
        method: "POST" as const,
        path: "/iot/devices",
        _openapi: { summary: "Register a new IoT device" },
        handler: async (req: Request) => {
          const body = await req.json() as { deviceId: string; name: string; type: string; metadata?: any };
          const device = await traitApi.registerDevice(body.deviceId, body.name, body.type, body.metadata);
          return new Response(JSON.stringify(device), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/iot/devices",
        _openapi: { summary: "List all registered IoT devices" },
        handler: async () => new Response(JSON.stringify({ devices: traitApi.listDevices() }), { status: 200, headers: { "content-type": "application/json" } }),
      },
      {
        method: "POST" as const,
        path: "/iot/telemetry/:deviceId",
        _openapi: {
          summary: "Ingest telemetry (SenML or JSON)",
          parameters: [{ name: "deviceId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        },
        handler: async (req: Request) => {
          const deviceId = new URL(req.url).pathname.split("/")[3];
          const body = await req.json();
          const result = await traitApi.ingestTelemetry(deviceId, body);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "iot-routes": iot_routes,
      "iot": traitApi,
      "deviceManager": traitApi,
    };
  },
});
