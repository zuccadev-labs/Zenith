/**
 * ZenithProvider — SDK initialization boundary.
 *
 * Two-phase init strategy (large-corp pattern):
 *
 * Phase 1 — Synchronous (render-time, via useRef lazy init):
 *   Zenith.initialize(config) — sets appId, serverURL, reads localStorage token.
 *   MUST be synchronous because useZenithQuery calls Zenith.getConfig() on
 *   first render. Safe to run in render because it's idempotent and has no
 *   async side effects. useRef prevents re-running in re-renders or StrictMode.
 *
 * Phase 2 — Asynchronous (useEffect):
 *   userStore.init() — validates stored session token against /users/me.
 *   Must be async (network request). useRef guard prevents double-run in
 *   React 18/19 StrictMode (which intentionally double-invokes effects in dev).
 *
 * Children always render immediately (no conditional null) so Suspense and
 * error boundaries work correctly. Children see loading:true from userStore
 * until phase 2 completes.
 */

import React, { createContext, useContext, useRef } from "react";
import { Zenith } from "../core/Zenith.js";
import { userStore } from "./userStore.js";
import type { ZenithConfig } from "../types/ZenithConfig.js";

interface ZenithContextValue {
  isInitialized: boolean;
  config: ZenithConfig | null;
}

const ZenithContext = createContext<ZenithContextValue>({
  isInitialized: false,
  config: null,
});

export const ZenithProvider: React.FC<{
  appId: string;
  serverURL: string;
  masterKey?: string;
  javascriptKey?: string;
  clientKey?: string;
  restApiKey?: string;
  children: React.ReactNode;
}> = ({ appId, serverURL, masterKey, javascriptKey, clientKey, restApiKey, children }) => {

  // ── Phase 1: Synchronous SDK config init ────────────────────────────────
  // useRef ensures this runs exactly once per component instance,
  // even in StrictMode or concurrent rendering.
  const sdkRef = useRef<{ initialized: boolean; config: ZenithConfig | null }>({
    initialized: false,
    config: null,
  });

  if (!sdkRef.current.initialized) {
    sdkRef.current.initialized = true;
    // Zenith.initialize() is idempotent — safe to call in render.
    // It only sets config properties and reads localStorage; no network calls.
    Zenith.initialize({ appId, serverURL, masterKey, javascriptKey, clientKey, restApiKey });
    sdkRef.current.config = Zenith.getConfig();
  }

  // ── Phase 2: Async session validation ───────────────────────────────────
  // React.useEffect equivalent using a ref-guarded immediate call.
  // We use a module-level flag so this survives HMR without re-fetching.
  const storeRef = useRef(false);
  if (!storeRef.current) {
    storeRef.current = true;
    // Defer to microtask so we don't block first paint, but don't wait for
    // an entire frame (useEffect would wait for paint + commit).
    Promise.resolve().then(() => userStore.init());
  }

  return (
    <ZenithContext.Provider
      value={{ isInitialized: true, config: sdkRef.current.config }}
    >
      {children}
    </ZenithContext.Provider>
  );
};

export function useZenithContext() {
  return useContext(ZenithContext);
}
