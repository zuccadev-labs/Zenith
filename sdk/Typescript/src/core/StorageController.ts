/**
 * Enterprise StorageController Interface
 * Agnóstico y asíncrono para soportar LocalStorage, Cookies, Memory y AsyncStorage (React Native).
 */
export interface StorageController {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStorageAdapter implements StorageController {
  private store: Map<string, string> = new Map();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

export class WebStorageAdapter implements StorageController {
  async getItem(key: string): Promise<string | null> {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, value);
    }
  }

  async removeItem(key: string): Promise<void> {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.removeItem(key);
    }
  }

  async clear(): Promise<void> {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  }
}

export class CookieStorageAdapter implements StorageController {
  async getItem(key: string): Promise<string | null> {
    if (typeof document === "undefined") return null;
    const match = document.cookie.match(new RegExp('(^| )' + key + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (typeof document !== "undefined") {
      document.cookie = `${key}=${encodeURIComponent(value)}; path=/; secure; samesite=lax; max-age=31536000`; // 1 year expiry
    }
  }

  async removeItem(key: string): Promise<void> {
    if (typeof document !== "undefined") {
      document.cookie = `${key}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  }

  async clear(): Promise<void> {
    // Cannot clear all cookies generically, would need to track keys. Not implementing for now.
    console.warn("CookieStorageAdapter.clear() is not implemented for security reasons.");
  }
}

/**
 * Singleton proxy manager para el almacenamiento, igual a Parse.Storage
 */
class ZenithStorageCore {
  private controller: StorageController;

  constructor() {
    // Default to WebStorage if available, otherwise MemoryStorage
    if (typeof window !== "undefined" && window.localStorage) {
      this.controller = new WebStorageAdapter();
    } else {
      this.controller = new MemoryStorageAdapter();
    }
  }

  public setController(controller: StorageController) {
    this.controller = controller;
  }

  public async getItem(key: string): Promise<string | null> {
    return this.controller.getItem(key);
  }

  public async setItem(key: string, value: string): Promise<void> {
    return this.controller.setItem(key, value);
  }

  public async removeItem(key: string): Promise<void> {
    return this.controller.removeItem(key);
  }

  public async clear(): Promise<void> {
    return this.controller.clear();
  }
}

export const ZenithStorage = new ZenithStorageCore();
