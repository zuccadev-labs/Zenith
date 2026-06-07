import { Zenith } from "../core/Zenith.js";
import { RESTController } from "../rest/RESTController.js";
import { ZenithObject } from "./ZenithObject.js";

/**
 * @class ZenithUser
 * Full parity with Parse.User. Manages auth, sessions, OAuth linking.
 *
 * @example
 * const user = new ZenithUser();
 * user.set("username", "alice");
 * user.set("password", "Str0ng!Pass");
 * user.set("email", "alice@example.com");
 * await user.signUp();
 */
export class ZenithUser extends ZenithObject {
  constructor(attributes?: Record<string, any>) {
    super("_User", attributes);
  }

  // ─── Field Accessors ──────────────────────────────────────────────────────

  public get username(): string { return this.get("username"); }
  public set username(val: string) { this.set("username", val); }

  public get email(): string { return this.get("email"); }
  public set email(val: string) { this.set("email", val); }

  public get sessionToken(): string | undefined { return this.get("sessionToken"); }

  /** Write-only. Never returned from backend. */
  public set password(val: string) { this.set("password", val); }

  // ─── Registration ─────────────────────────────────────────────────────────

  public async signUp(): Promise<this> {
    const res = await RESTController.request("POST", "/users", this.toJSON());
    this.set(res);
    await this._saveCurrentUser();
    return this;
  }

  // ─── Authentication ───────────────────────────────────────────────────────

  /**
   * Logs in with username and password. Returns the authenticated user.
   */
  public static async logIn(username: string, password: string): Promise<ZenithUser> {
    const res = await RESTController.request("GET", "/login", { username, password });
    const user = new ZenithUser(res);
    await user._saveCurrentUser();
    return user;
  }

  // Local memory cache for the current user
  private static _currentUser: ZenithUser | null = null;

  /**
   * Internal method to persist the current user and their session token locally.
   */
  private async _saveCurrentUser(): Promise<void> {
    ZenithUser._currentUser = this;
    if (this.sessionToken) {
      await Zenith.setSessionTokenAsync(this.sessionToken);
    }
    const { ZenithStorage } = await import('../core/StorageController.js');
    await ZenithStorage.setItem(`Zenith/${Zenith.getConfig().appId}/currentUser`, JSON.stringify(this.toJSON()));
  }

  /**
   * Synchronously returns the currently cached user from memory.
   * Note: This may be null on first load until currentAsync() or initialize hydration completes.
   */
  public static current(): ZenithUser | null {
    return ZenithUser._currentUser;
  }

  /**
   * Asynchronously retrieves the current user from the StorageController.
   * If found, caches it in memory. Does NOT make a network request.
   */
  public static async currentAsync(): Promise<ZenithUser | null> {
    if (ZenithUser._currentUser) return ZenithUser._currentUser;
    
    const { ZenithStorage } = await import('../core/StorageController.js');
    const stored = await ZenithStorage.getItem(`Zenith/${Zenith.getConfig().appId}/currentUser`);
    if (stored) {
      try {
        const data = JSON.parse(stored);
        ZenithUser._currentUser = new ZenithUser(data);
        return ZenithUser._currentUser;
      } catch (e) {
        // Corrupted storage
        await ZenithStorage.removeItem(`Zenith/${Zenith.getConfig().appId}/currentUser`);
      }
    }
    return null;
  }

  /**
   * Fetches the user from the server using the current session token to validate it,
   * updates the local cache, and returns it.
   */
  public static async fetchCurrent(): Promise<ZenithUser | null> {
    const token = Zenith.sessionToken;
    if (!token) return null;
    try {
      const res = await RESTController.request("GET", "/users/me");
      const user = new ZenithUser(res);
      await user._saveCurrentUser();
      return user;
    } catch (e) {
      await ZenithUser.logOut();
      return null;
    }
  }

  /**
   * Authenticates as a user by their session token directly.
   * Useful for server-side authentication flows.
   */
  public static async become(sessionToken: string): Promise<ZenithUser> {
    const res = await RESTController.request("GET", "/users/me", undefined, { sessionToken });
    const user = new ZenithUser(res);
    user.set("sessionToken", sessionToken);
    await user._saveCurrentUser();
    return user;
  }

  /**
   * Logs out the current user and clears the local session and storage.
   */
  public static async logOut(): Promise<void> {
    try {
      await RESTController.request("POST", "/logout");
    } catch(e) {
      // Ignore network errors on logout
    } finally {
      ZenithUser._currentUser = null;
      await Zenith.setSessionTokenAsync(undefined);
      const { ZenithStorage } = await import('../core/StorageController.js');
      await ZenithStorage.removeItem(`Zenith/${Zenith.getConfig().appId}/currentUser`);
    }
  }

  // ─── Password Management ──────────────────────────────────────────────────

  /**
   * Sends a password reset email to the given address.
   * Silent success even if email doesn't exist (prevents enumeration).
   */
  public static async requestPasswordReset(email: string): Promise<void> {
    await RESTController.request("POST", "/requestPasswordReset", { email });
  }

  /**
   * Verifies a user's email using the token from the verification email.
   */
  public static async verifyEmail(token: string): Promise<void> {
    await RESTController.request("POST", "/verifyEmail", { token });
  }

  // ─── OAuth / Third-party Auth ─────────────────────────────────────────────

  /**
   * Links (or signs up) a user via third-party OAuth authData.
   * Compatible with Parse Server's authData format.
   *
   * @example
   * await ZenithUser.linkWith("google", {
   *   id: googleProfile.id,
   *   access_token: googleProfile.token,
   * });
   */
  public static async linkWith(
    provider: string,
    authData: Record<string, any>
  ): Promise<ZenithUser> {
    const res = await RESTController.request("POST", "/users", {
      authData: { [provider]: authData },
    });
    const user = new ZenithUser(res);
    await user._saveCurrentUser();
    return user;
  }
}
