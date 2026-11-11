import type { ZenithConfig } from "./src/core/types.ts";
import { requireEnv, type ZenithAppDefinition } from "./config-loader.ts";

export type { ZenithAppDefinition };

/** The listening port: ZENITH_PORT (the Helm chart sets it from zenith.port), 1337 by default. */
const PORT = Number(Deno.env.get("ZENITH_PORT") ?? 1337);

export const apps: ZenithAppDefinition[] = [
  {
    mountPath: "/parse",
    config: {
      appId: "myAppId1",
      masterKey: requireEnv("APP1_MASTER_KEY", { minLength: 64 }),
      serverURL: "http://localhost:1337/parse/app1",
      port: PORT,
      allowClientClassCreation: true,
      enableAnonymousUsers: false,
      cloudCodePath: "./cloud/main.ts",
      
      // DB Segmentada para la App 1
      databaseURI: Deno.env.get("MONGO_URI") || "mongodb://192.168.14.50:53017/app1_db?directConnection=true",
      authDatabaseURI: Deno.env.get("SCYLLA_URI") || "192.168.14.50:53042",
      mediaStorageURI: Deno.env.get("RUSTFS_URI") || "http://192.168.14.50:8614",
      cacheURI: Deno.env.get("REDIS_URI") || "redis://192.168.14.50:53079",

      // App 1: B2C E-Commerce & SaaS
      features: {
        saas: true,
        ecommerce: true,
        ai: true,
        gdpr: true,
        e2ee_media: true,
        e2ee_mode: "strict_sframe"
      }
    } as any
  },
  {
    mountPath: "/parse",
    config: {
      appId: "myAppId2",
      masterKey: requireEnv("APP2_MASTER_KEY", { minLength: 64 }),
      serverURL: "http://localhost:1337/parse/app2",
      port: PORT,
      allowClientClassCreation: false, // Prod app
      enableAnonymousUsers: false,
      
      // DB Segmentada para la App 2
      databaseURI: Deno.env.get("MONGO_URI") || "mongodb://192.168.14.50:53017/app2_db?directConnection=true",
      authDatabaseURI: Deno.env.get("SCYLLA_URI") || "192.168.14.50:53042",
      mediaStorageURI: Deno.env.get("RUSTFS_URI") || "http://192.168.14.50:8614",
      cacheURI: Deno.env.get("REDIS_URI") || "redis://192.168.14.50:53079",

      // App 2: Pura Infraestructura (Ataque Surface Reducida)
      features: {
        saas: false,
        ecommerce: false,
        ai: false,
        gdpr: false
      }
    } as any
  }
];
