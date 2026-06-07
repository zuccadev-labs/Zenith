import type { ZenithConfig } from "./src/core/types.ts";

/**
 * Zenith Base Configuration
 * 
 * This file replaces ParseServer's initialization config.
 * It's modular, strongly typed, and separates infrastructure concerns.
 */
export const config: ZenithConfig = {
  appId: Deno.env.get("ZENITH_APP_ID") || "zenith-dev",
  masterKey: Deno.env.get("ZENITH_MASTER_KEY") || "changeme_masterkey",
  serverURL: Deno.env.get("ZENITH_SERVER_URL") || "http://localhost:1337/api",
  port: parseInt(Deno.env.get("ZENITH_PORT") || "1337", 10),
  
  // Opciones de seguridad y acceso
  allowClientClassCreation: true,
  enableAnonymousUsers: false,
  
  // Cloud Code
  cloudCodePath: Deno.env.get("ZENITH_CLOUD_CODE_PATH") || "./cloud/main.ts",
};
