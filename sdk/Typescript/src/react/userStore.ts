/**
 * @module userStore
 * Singleton user state store — enterprise pattern for React 18.
 *
 * Design principles (large-corp grade):
 * 1. Single source of truth — one ZenithUser instance for ALL hook consumers.
 *    Multiple `useZenithUser()` calls share state, not each getting its own copy.
 * 2. useSyncExternalStore-compatible — React 18 concurrent-safe external store.
 * 3. Cross-tab synchronization — storage events propagate logout to all open tabs.
 * 4. Zero redundant requests — init() is idempotent; second call is a no-op.
 * 5. Session token in localStorage — industry standard for SPAs (same as Parse SDK).
 *    For apps requiring stricter security, swap to an httpOnly cookie via a
 *    server-side token proxy — that's a backend architectural decision.
 */

import type { ZenithUser } from "../objects/ZenithUser.js";

type Listener = () => void;

class UserStore {
  // ── State ──────────────────────────────────────────────────────────────────
  private _user: ZenithUser | null = null;
  private _loading = true;
  private _initialized = false;
  private _listeners = new Set<Listener>();

  // ── Initialization ─────────────────────────────────────────────────────────

  /**
   * Idempotent init — safe to call from multiple components.
   * First call fetches current session; subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    // Cross-tab sync: another tab logging out should log out this tab too.
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (e: StorageEvent) => {
        // Any sessionToken key change in another tab triggers a refresh
        if (e.key?.includes("/sessionToken")) {
          this.refresh();
        }
      });
    }

    await this.refresh();
  }

  /**
   * Re-validates the stored session token against the server.
   * Called on init and on cross-tab storage events.
   */
  async refresh(): Promise<void> {
    // Lazy import to avoid circular dependencies
    const { ZenithUser } = await import("../objects/ZenithUser.js");
    this._loading = true;
    this._notify();
    try {
      // 1. Fast path: Hydrate instantly from ZenithStorage (LocalStorage/Memory)
      const user = await ZenithUser.currentAsync();
      this._user = user;
      
      // 2. Background validation: Ensure session is still valid on the server
      if (user) {
        ZenithUser.fetchCurrent().then((validUser) => {
           if (!validUser) this.clearUser(); // Token expired
        }).catch(() => {});
      }
    } catch {
      this._user = null;
    } finally {
      this._loading = false;
      this._notify();
    }
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  /** Called after signUp / logIn to immediately update all consumers. */
  setUser(user: ZenithUser | null): void {
    this._user = user;
    this._loading = false;
    this._notify();
  }

  clearUser(): void {
    this._user = null;
    this._loading = false;
    this._notify();
  }

  // ── useSyncExternalStore API ───────────────────────────────────────────────
  // React 18 concurrent-safe: no tearing, no extra renders.

  /** Subscribe to store changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Snapshot for useSyncExternalStore — must be referentially stable when unchanged. */
  getUser = (): ZenithUser | null => this._user;
  getLoading = (): boolean => this._loading;

  // ── Private ────────────────────────────────────────────────────────────────

  private _notify(): void {
    this._listeners.forEach((l) => l());
  }
}

/** Singleton — one per app instance. */
export const userStore = new UserStore();
