/**
 * @hook useZenithUser
 * React 18 hook — backed by the UserStore singleton.
 *
 * Key improvements over useState pattern:
 * - useSyncExternalStore: concurrent-safe, no tearing in React 18 Concurrent Mode
 * - Single network request per app lifetime (not per component mount)
 * - All components share the SAME user object — no de-sync
 * - Cross-tab logout sync via storage events
 * - ZenithProvider integration calls init() exactly once
 */

import { useCallback, useSyncExternalStore } from "react";
import { ZenithUser } from "../objects/ZenithUser.js";
import { userStore } from "./userStore.js";

export function useZenithUser() {
  // ── useSyncExternalStore — React 18/19 concurrent-safe ──────────────────────
  // All components calling useZenithUser() share the SAME store snapshot.
  // No tearing, no de-sync, no extra network requests.
  const user = useSyncExternalStore(
    useCallback((cb) => userStore.subscribe(cb), []),
    userStore.getUser,
    () => null,           // SSR snapshot
  );

  const loading = useSyncExternalStore(
    useCallback((cb) => userStore.subscribe(cb), []),
    userStore.getLoading,
    () => true,
  );

  // userStore.init() is called by ZenithProvider — no need to call here.

  // ── Actions ────────────────────────────────────────────────────────────────

  const logOut = useCallback(async () => {
    try {
      await ZenithUser.logOut();
    } finally {
      userStore.clearUser();
    }
  }, []);

  /**
   * Manually set the user (e.g. after signUp / logIn in a form component).
   * Propagates to ALL consumers without an extra network request.
   */
  const setUser = useCallback((u: ZenithUser | null) => {
    userStore.setUser(u);
  }, []);

  return { user, loading, logOut, setUser };
}
