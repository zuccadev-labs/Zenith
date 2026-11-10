/**
 * @module @zenith/traits/auth/engine-auth
 *
 * Parse Server users and sessions on top of engine-auth (the ecosystem's single issuer).
 *
 * Who you are is decided by engine-auth: passwords, LDAP/FreeIPA, OIDC providers, lockout, key
 * rotation. Zenith keeps what Parse clients expect:
 *
 * - **`sessionToken`** (`r:<64 hex>`): an opaque handle. `_Session` stores only its SHA-256, the
 *   engine-auth refresh token sealed with AES-256-GCM (`engineAuth.sessionKey`), and the identity of
 *   the last verified access token. A Parse client never sees an engine-auth token.
 * - **Requests** with a handle are answered from `_Session` (cached 5 s per instance, as Parse
 *   Server does) while the access token is fresh (15 min by default); after that one instance refreshes it under a lease (`updateIf`), so two requests
 *   at once never present the same refresh token (engine-auth would take that as theft and end the
 *   session). A revoked or disabled account stops working at the next refresh.
 * - **`Authorization: Bearer <access token>`** from any service or agent of the ecosystem is
 *   verified locally through FFI (`@zuccadev-labs/zutool-ffi`, `auth.verify`) against the cached
 *   JWKS: issuer, audience (`engineAuth.audience`), `typ: at+jwt`, expiry and the key's algorithm.
 * - **`_User`** is the Parse profile, keyed by the engine-auth subject (`objectId = sub`), so ACLs
 *   and pointers keep working. It holds no password.
 *
 * Not yet in engine-auth, so refused explicitly (501) instead of half-working: password reset,
 * e-mail verification, MFA.
 */

import { openFeature, type Feature } from "@zuccadev-labs/zutool-ffi";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface EngineAuthConfig {
  /** `iss` of the tokens, e.g. `https://auth.example.com`. */
  readonly issuer: string;
  /** Where Zenith reaches engine-auth when it is not the issuer URL (e.g. `http://engine-auth:8470`). */
  readonly url?: string;
  /** First-party client registered in engine-auth (`firstParty: true`). */
  readonly clientId: string;
  /** This Zenith's resource indicator: tokens must carry it in `aud`. */
  readonly audience: string;
  /** 32 random bytes, base64 or base64url: seals refresh tokens in `_Session`. Same on every instance. */
  readonly sessionKey: string;
  /** Directory of `libzutool_auth` (default `$ZUTOOL_LIB_DIR`). */
  readonly libDir?: string;
  /** Password provider for `/login`: `local` (default) or the id of an LDAP provider. */
  readonly provider?: string;
  /** Upper bound of a Parse session in seconds (default 90 days, engine-auth's own maximum). */
  readonly sessionLength?: number;
}

/** The subset of `database-crud` the facade needs. `updateIf` is required: it is the lease. */
export interface AuthCrud {
  find(collection: string, query: { where?: Record<string, unknown>; limit?: number }): Promise<Record<string, unknown>[]>;
  findOne(collection: string, query: { where?: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  insert(collection: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(collection: string, objectId: string, data: Record<string, unknown>): Promise<unknown>;
  updateIf?(collection: string, objectId: string, conditions: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown | null>;
  delete(collection: string, objectId: string): Promise<void>;
}

/** What a verified request carries (`ctx.auth`). */
export interface Identity {
  readonly sub: string;
  readonly roles: string[];
  readonly groups: string[];
  readonly scope: string;
  readonly clientId: string;
  readonly sessionId?: string;
  readonly actor?: string;
  /** `session` (Parse handle) or `bearer` (an access token presented directly). */
  readonly via: "session" | "bearer";
}

/** Parse Server error: `{code, error}` with an HTTP status. */
export class ParseError extends Error {
  constructor(readonly code: number, message: string, readonly status = 400) {
    super(message);
    this.name = "ParseError";
  }
}

// Parse Server error codes (parse-server/src/ParseError).
export const P = {
  OTHER_CAUSE: -1,
  INTERNAL_SERVER_ERROR: 1,
  CONNECTION_FAILED: 100,
  OBJECT_NOT_FOUND: 101,
  INVALID_JSON: 107,
  VALIDATION_ERROR: 142,
  INVALID_EMAIL_ADDRESS: 125,
  USERNAME_MISSING: 200,
  PASSWORD_MISSING: 201,
  USERNAME_TAKEN: 202,
  EMAIL_MISSING: 204,
  INVALID_SESSION_TOKEN: 209,
} as const;

const SESSIONS = "_Session";
const USERS = "_User";
const LEASE_MS = 30_000;
const LEASE_WAIT_MS = 5_000;
const JWKS_TTL_MS = 300_000;
const JWKS_MIN_REFETCH_MS = 30_000;
// Like Parse Server's cacheTTL: a logout on one instance reaches the others within 5 s.
const CACHE_MS = 5_000;
const CACHE_MAX = 10_000;
const HTTP_TIMEOUT_MS = 10_000;
const HANDLE = /^r:[0-9a-f]{64}$/;

/** Fields a client may never set on its own profile at sign-up. */
const RESERVED = new Set([
  "objectId", "createdAt", "updatedAt", "className", "ACL", "_id",
  "username", "password", "email", "emailVerified", "sessionToken", "authData", "authSub",
]);

// ─── Small helpers ────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const nowS = () => Math.floor(Date.now() / 1000);
const looksLikeJwt = (t: string) => t.startsWith("eyJ") && t.split(".").length === 3;

/** engine-auth error codes → Parse codes. Messages come from engine-auth and are user-facing. */
function fromEngine(status: number, body: { error?: string; error_description?: string }): ParseError {
  const msg = body.error_description ?? body.error ?? `engine-auth answered ${status}`;
  switch (body.error) {
    case "invalid_credentials":
      return new ParseError(P.OBJECT_NOT_FOUND, "Invalid username/password.", 404);
    case "account_exists":
      return new ParseError(P.USERNAME_TAKEN, "Account already exists for this username or email.", 400);
    case "slow_down":
      return new ParseError(P.CONNECTION_FAILED, msg, 429);
    case "signup_closed":
      return new ParseError(P.OTHER_CAUSE, msg, 403);
    case "too_short": case "too_long": case "contextual": case "repetitive": case "empty_password": case "breached":
      return new ParseError(P.VALIDATION_ERROR, msg, 400);
    case "invalid_request":
      return new ParseError(/e-mail/i.test(msg) ? P.INVALID_EMAIL_ADDRESS : P.VALIDATION_ERROR, msg, 400);
    default:
      return new ParseError(P.INTERNAL_SERVER_ERROR, status >= 500 ? "The authentication service failed." : msg, status >= 500 ? 502 : 400);
  }
}

// ─── The facade ───────────────────────────────────────────────────────────────

export interface FacadeOptions {
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Injected for tests; defaults to `openFeature("auth", {dir: libDir})`. */
  readonly feature?: Pick<Feature, "call">;
  readonly log?: (msg: string) => void;
}

type SessionDoc = {
  objectId: string;
  tokenHash: string;
  user: { __type: "Pointer"; className: "_User"; objectId: string };
  sub: string;
  sid?: string;
  refresh: string;
  accessExp: number;
  groups: string[];
  scope: string;
  clientId: string;
  leaseUntil: number;
  expiresAt: number;
  installationId?: string;
  createdWith: { action: string; authProvider: string };
};

type Tokens = { access_token: string; refresh_token: string; expires_in: number };

export class EngineAuthFacade {
  readonly #cfg: Required<Pick<EngineAuthConfig, "issuer" | "clientId" | "audience" | "provider" | "sessionLength">> & { url: string };
  readonly #db: AuthCrud & { updateIf: NonNullable<AuthCrud["updateIf"]> };
  readonly #fetch: typeof fetch;
  readonly #ffi: Pick<Feature, "call">;
  readonly #log: (msg: string) => void;
  #key: CryptoKey | null = null;
  readonly #rawKey: Uint8Array;
  #jwks: { keys: unknown[] } | null = null;
  #jwksAt = 0;
  readonly #cache = new Map<string, { id: Identity; until: number }>();

  constructor(cfg: EngineAuthConfig, db: AuthCrud, opts: FacadeOptions = {}) {
    for (const k of ["issuer", "clientId", "audience", "sessionKey"] as const) {
      if (!cfg?.[k]) throw new Error(`engineAuth.${k} is required`);
    }
    if (typeof db?.updateIf !== "function") {
      throw new Error("engine-auth sessions need a database adapter with conditional updates (database-crud.updateIf)");
    }
    let raw: Uint8Array;
    try {
      raw = unb64u(cfg.sessionKey.trim());
    } catch {
      throw new Error("engineAuth.sessionKey must be base64 or base64url");
    }
    if (raw.length !== 32) throw new Error(`engineAuth.sessionKey must decode to 32 bytes (got ${raw.length})`);
    this.#rawKey = raw;
    this.#cfg = {
      issuer: cfg.issuer,
      url: (cfg.url ?? cfg.issuer).replace(/\/+$/, ""),
      clientId: cfg.clientId,
      audience: cfg.audience,
      provider: cfg.provider ?? "local",
      sessionLength: cfg.sessionLength ?? 90 * 86_400,
    };
    this.#db = db as AuthCrud & { updateIf: NonNullable<AuthCrud["updateIf"]> };
    this.#fetch = opts.fetch ?? fetch;
    this.#ffi = opts.feature ?? openFeature("auth", cfg.libDir ? { dir: cfg.libDir } : {});
    this.#log = opts.log ?? ((m) => console.warn(`[engine-auth] ${m}`));
  }

  // ── Public API (user-manager) ──────────────────────────────────────────────

  /** Parse `POST /users`. Returns the profile plus a new session token. */
  async signUp(body: Record<string, unknown>, ip: string, installationId?: string) {
    const password = typeof body.password === "string" ? body.password : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    if (!password) throw new ParseError(P.PASSWORD_MISSING, "A password is required.");
    if (!email) throw new ParseError(P.EMAIL_MISSING, "An email is required (engine-auth accounts are reached by email).");
    const tokens = await this.#engine<Tokens>("/api/signup", {
      clientId: this.#cfg.clientId, email, password, audience: [this.#cfg.audience],
      ...(username ? { username } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
    }, ip);
    const id = this.#verifyOrThrow(tokens.access_token);
    const extra = Object.fromEntries(Object.entries(body).filter(([k]) => !RESERVED.has(k)));
    const profile = await this.#ensureProfile(id.sub, { username: username || email, email: email.toLowerCase(), ...extra });
    const sessionToken = await this.#createSession(id, tokens, "signup", installationId);
    return { objectId: profile.objectId, createdAt: profile.createdAt, sessionToken };
  }

  /** Parse `POST /login` (`username` or `email`, and `password`). */
  async logIn(body: Record<string, unknown>, ip: string, installationId?: string) {
    const login = typeof body.username === "string" && body.username ? body.username : typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!login) throw new ParseError(P.USERNAME_MISSING, "A username or email is required.");
    if (!password) throw new ParseError(P.PASSWORD_MISSING, "A password is required.");
    const tokens = await this.#engine<Tokens>("/api/login", {
      clientId: this.#cfg.clientId, login, password, provider: this.#cfg.provider, audience: [this.#cfg.audience],
    }, ip);
    const id = this.#verifyOrThrow(tokens.access_token);
    const profile = await this.#ensureProfile(id.sub, login.includes("@") ? { email: login.toLowerCase(), username: login } : { username: login });
    const sessionToken = await this.#createSession(id, tokens, "login", installationId);
    return { ...this.#public(profile), sessionToken };
  }

  /** Parse `POST /logout`: ends the engine-auth session too. Always succeeds for the caller. */
  async logOut(sessionToken: string) {
    if (!HANDLE.test(sessionToken)) return;
    const hash = await sha256(sessionToken);
    this.#cache.delete(hash);
    const doc = await this.#session(hash);
    if (!doc) return;
    await this.#db.delete(SESSIONS, doc.objectId);
    try {
      const refresh = await this.#open(doc.refresh, hash);
      await this.#form("/oauth/revoke", { token: refresh, token_type_hint: "refresh_token" });
    } catch (e) {
      this.#log(`revocation of session ${doc.sid ?? "?"} failed: ${(e as Error).message}`);
    }
  }

  /** Parse `GET /users/me`. */
  async me(token: string) {
    const id = await this.verifySession(token);
    if (!id) throw new ParseError(P.INVALID_SESSION_TOKEN, "Invalid session token.", 400);
    const profile = await this.#ensureProfile(id.sub, {});
    return { ...this.#public(profile), ...(id.via === "session" ? { sessionToken: token } : {}) };
  }

  /**
   * The `authentication` capability: the pipeline calls it for every request with a token.
   * Returns the identity, or `null` (anonymous) for anything not proven right now.
   */
  async verifySession(token: string): Promise<(Identity & { userId: string }) | null> {
    if (!token) return null;
    const id = looksLikeJwt(token) ? await this.#verifyBearer(token) : HANDLE.test(token) ? await this.#verifyHandle(token) : null;
    return id ? { ...id, userId: id.sub } : null;
  }

  // ── Sessions ────────────────────────────────────────────────────────────────

  async #createSession(id: Identity, t: Tokens, action: string, installationId?: string): Promise<string> {
    const token = `r:${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const hash = await sha256(token);
    const exp = this.#exp(t.access_token);
    await this.#db.insert(SESSIONS, {
      tokenHash: hash,
      user: { __type: "Pointer", className: USERS, objectId: id.sub },
      sub: id.sub,
      sid: id.sessionId,
      refresh: await this.#seal(t.refresh_token, hash),
      accessExp: exp,
      groups: id.groups,
      scope: id.scope,
      clientId: id.clientId,
      leaseUntil: 0,
      expiresAt: Date.now() + this.#cfg.sessionLength * 1000,
      createdWith: { action, authProvider: this.#cfg.provider === "local" ? "password" : this.#cfg.provider },
      restricted: false,
      ...(installationId ? { installationId } : {}),
    });
    return token;
  }

  async #session(hash: string): Promise<SessionDoc | null> {
    return (await this.#db.findOne(SESSIONS, { where: { tokenHash: hash } })) as SessionDoc | null;
  }

  #identityOf(d: SessionDoc): Identity {
    return { sub: d.sub, roles: [], groups: d.groups ?? [], scope: d.scope ?? "", clientId: d.clientId ?? "", sessionId: d.sid, via: "session" };
  }

  async #verifyHandle(token: string): Promise<Identity | null> {
    const hash = await sha256(token);
    const hit = this.#cache.get(hash);
    if (hit && hit.until > Date.now()) return hit.id;
    this.#cache.delete(hash);

    let doc = await this.#session(hash);
    if (!doc) return null;
    if (doc.expiresAt <= Date.now()) {
      await this.#db.delete(SESSIONS, doc.objectId);
      return null;
    }
    if (doc.accessExp - 5 <= nowS()) {
      doc = await this.#refresh(doc, hash);
      if (!doc) return null;
    }
    const id = this.#identityOf(doc);
    this.#remember(hash, id, Math.min(Date.now() + CACHE_MS, doc.accessExp * 1000));
    return id;
  }

  /** Refreshes the engine-auth tokens behind a session; exactly one instance does it at a time. */
  async #refresh(doc: SessionDoc, hash: string): Promise<SessionDoc | null> {
    const lease = Date.now() + LEASE_MS;
    const won = await this.#db.updateIf(SESSIONS, doc.objectId, { tokenHash: hash, leaseUntil: { $lt: Date.now() } }, { leaseUntil: lease });
    if (!won) return await this.#awaitRefresh(hash);

    let tokens: Tokens;
    try {
      const refresh = await this.#open(doc.refresh, hash);
      tokens = await this.#form<Tokens>("/oauth/token", { grant_type: "refresh_token", client_id: this.#cfg.clientId, refresh_token: refresh });
    } catch (e) {
      if (e instanceof ParseError && e.status === 400) {
        // invalid_grant: the session ended in engine-auth (logout elsewhere, disabled account, reuse).
        await this.#db.delete(SESSIONS, doc.objectId);
      } else {
        // engine-auth unreachable: deny this request, keep the session for when it is back.
        await this.#db.updateIf(SESSIONS, doc.objectId, { leaseUntil: lease }, { leaseUntil: 0 });
        this.#log(`refresh failed, request treated as anonymous: ${(e as Error).message}`);
      }
      return null;
    }
    const id = this.#verify(tokens.access_token);
    if (!id) {
      await this.#db.delete(SESSIONS, doc.objectId);
      return null;
    }
    const next = {
      refresh: await this.#seal(tokens.refresh_token, hash),
      accessExp: this.#exp(tokens.access_token),
      groups: id.groups,
      scope: id.scope,
      sid: id.sessionId,
      leaseUntil: 0,
    };
    const saved = await this.#db.updateIf(SESSIONS, doc.objectId, { leaseUntil: lease }, next);
    if (!saved) {
      // Our lease ran out mid-refresh and another instance took over: its result wins.
      this.#log(`lease of session ${doc.sid ?? "?"} expired during refresh`);
      return await this.#awaitRefresh(hash);
    }
    return { ...doc, ...next };
  }

  /** Lost the lease: wait for the winner's fresh access token, or for the session to disappear. */
  async #awaitRefresh(hash: string): Promise<SessionDoc | null> {
    const until = Date.now() + LEASE_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      const doc = await this.#session(hash);
      if (!doc) return null;
      if (doc.accessExp - 5 > nowS()) return doc;
    }
    return null;
  }

  #remember(hash: string, id: Identity, until: number) {
    if (this.#cache.size >= CACHE_MAX) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(hash, { id, until });
  }

  // ── Access tokens (FFI) ─────────────────────────────────────────────────────

  async #verifyBearer(token: string): Promise<Identity | null> {
    await this.#loadJwks(false);
    let r = this.#check(token);
    if (r === "unknown_key" && (await this.#loadJwks(true))) r = this.#check(token);
    return typeof r === "object" ? r : null;
  }

  /** For tokens engine-auth just gave us: JWKS refreshed on demand. */
  #verify(token: string): Identity | null {
    const r = this.#check(token);
    return typeof r === "object" ? r : null;
  }

  #verifyOrThrow(token: string): Identity {
    const id = this.#verify(token);
    if (!id) throw new ParseError(P.INTERNAL_SERVER_ERROR, "engine-auth returned a token Zenith cannot verify (check issuer, audience and JWKS).", 502);
    return id;
  }

  /** Identity, or the refusal code. */
  #check(token: string): Identity | string {
    if (!this.#jwks) return "no_jwks";
    const c = this.#ffi.call<Record<string, unknown>>("auth.verify", { token, jwks: this.#jwks, issuer: this.#cfg.issuer, audience: this.#cfg.audience });
    const refused = c.refused as { code?: string } | undefined;
    if (refused) return refused.code ?? "refused";
    const act = c.act as { sub?: string } | undefined;
    return {
      sub: String(c.sub),
      roles: [],
      groups: Array.isArray(c.groups) ? c.groups.map(String) : [],
      scope: typeof c.scope === "string" ? c.scope : "",
      clientId: typeof c.client_id === "string" ? c.client_id : "",
      sessionId: typeof c.sid === "string" ? c.sid : undefined,
      actor: act?.sub,
      via: "bearer",
    };
  }

  #exp(token: string): number {
    try {
      const exp = JSON.parse(new TextDecoder().decode(unb64u(token.split(".")[1]))).exp;
      return typeof exp === "number" ? exp : 0;
    } catch {
      return 0;
    }
  }

  /** Fetches the JWKS when stale (or `force`, at most every 30 s). True if a new set arrived. */
  async #loadJwks(force: boolean): Promise<boolean> {
    const age = Date.now() - this.#jwksAt;
    if (this.#jwks && (force ? age < JWKS_MIN_REFETCH_MS : age < JWKS_TTL_MS)) return false;
    try {
      const r = await this.#fetch(`${this.#cfg.url}/.well-known/jwks.json`, { redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j?.keys)) throw new Error("not a JWK set");
      this.#jwks = j;
      this.#jwksAt = Date.now();
      return true;
    } catch (e) {
      this.#log(`JWKS fetch failed: ${(e as Error).message}`);
      this.#jwksAt = Date.now() - JWKS_TTL_MS + JWKS_MIN_REFETCH_MS; // retry in 30 s, keep the old set
      return false;
    }
  }

  // ── engine-auth HTTP ────────────────────────────────────────────────────────

  async #engine<T>(path: string, body: unknown, ip: string): Promise<T> {
    const r = await this.#call(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
    // Tokens just minted: make sure their key is known before verifying them.
    await this.#loadJwks(false);
    const t = r as unknown as Tokens;
    if (this.#check(t.access_token) === "unknown_key") await this.#loadJwks(true);
    return r as T;
  }

  async #form<T = unknown>(path: string, form: Record<string, string>): Promise<T> {
    const r = await this.#call(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
    if (path === "/oauth/token") {
      await this.#loadJwks(false);
      const t = r as unknown as Tokens;
      if (this.#check(t.access_token) === "unknown_key") await this.#loadJwks(true);
    }
    return r as T;
  }

  async #call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let r: Response;
    try {
      r = await this.#fetch(`${this.#cfg.url}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch (e) {
      throw new ParseError(P.CONNECTION_FAILED, `The authentication service is unreachable (${(e as Error).message}).`, 503);
    }
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch { /* non-JSON error page */ }
    if (!r.ok) throw fromEngine(r.status, body as { error?: string; error_description?: string });
    return body;
  }

  // ── Profiles ────────────────────────────────────────────────────────────────

  /** The `_User` profile of a subject, created on first sight (accounts from LDAP/OIDC/CLI too). */
  async #ensureProfile(sub: string, seed: Record<string, unknown>): Promise<Record<string, unknown>> {
    const found = await this.#db.findOne(USERS, { where: { objectId: sub } });
    if (found) return found;
    const doc = { objectId: sub, emailVerified: false, ...seed, createdAt: new Date(), updatedAt: new Date() };
    try {
      await this.#db.insert(USERS, doc);
    } catch (e) {
      // Another request created it first (duplicate key): theirs is as good as ours.
      const again = await this.#db.findOne(USERS, { where: { objectId: sub } });
      if (again) return again;
      throw e;
    }
    return doc;
  }

  #public(p: Record<string, unknown>) {
    const { passwordHash: _h, _id, authData: _a, ...safe } = p as Record<string, unknown> & { passwordHash?: unknown; authData?: unknown };
    return safe;
  }

  // ── Sealing (AES-256-GCM, bound to the session) ─────────────────────────────

  async #aes(): Promise<CryptoKey> {
    this.#key ??= await crypto.subtle.importKey("raw", this.#rawKey as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
    return this.#key;
  }

  async #seal(plain: string, hash: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(hash) }, await this.#aes(), enc.encode(plain)));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return `v1.${b64u(out)}`;
  }

  async #open(sealed: string, hash: string): Promise<string> {
    if (!sealed?.startsWith("v1.")) throw new Error("unknown seal format");
    const b = unb64u(sealed.slice(3));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12), additionalData: enc.encode(hash) }, await this.#aes(), b.slice(12));
    return new TextDecoder().decode(pt);
  }
}

// ─── HTTP (Parse Server routes) ───────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const fail = (e: unknown) => {
  if (e instanceof ParseError) return json({ code: e.code, error: e.message }, e.status);
  console.error("[engine-auth] unexpected error:", e);
  return json({ code: P.INTERNAL_SERVER_ERROR, error: "Internal server error." }, 500);
};

const notYet = (what: string) => async () =>
  json({ code: P.OTHER_CAUSE, error: `${what} is not available yet: engine-auth does not offer it so far.` }, 501);

type Ctx = { sessionToken?: string; clientIp?: string; installationId?: string };

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new ParseError(P.INVALID_JSON, "The body must be a JSON object.");
}

const tokenOf = (req: Request, ctx: Ctx) =>
  ctx.sessionToken ?? req.headers.get("x-parse-session-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

/** Parse Server-compatible routes, all backed by `facade()` (resolved per request: it is configured after composition). */
export function userRoutes(facade: () => EngineAuthFacade) {
  // Only a real address is forwarded to engine-auth (the pipeline says "unknown" when it has none).
  const ip = (ctx: Ctx) => (ctx.clientIp && /^[0-9A-Fa-f:.]+$/.test(ctx.clientIp) ? ctx.clientIp : "0.0.0.0");
  return [
    {
      access: "public" as const,
      method: "POST" as const,
      path: "/users",
      _openapi: { summary: "Sign up (engine-auth account + Parse profile)", tags: ["User Management"] },
      handler: async (req: Request, ctx: Ctx) => {
        try {
          return json(await facade().signUp(await readJson(req), ip(ctx), ctx.installationId), 201);
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      access: "public" as const,
      method: "POST" as const,
      path: "/login",
      _openapi: { summary: "Log in (username or email, password)", tags: ["User Management"] },
      handler: async (req: Request, ctx: Ctx) => {
        try {
          return json(await facade().logIn(await readJson(req), ip(ctx), ctx.installationId));
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      // Credentials in a URL end up in access logs and browser history (OWASP). Parse SDKs use POST.
      access: "public" as const,
      method: "GET" as const,
      path: "/login",
      _openapi: { summary: "Refused: send the credentials with POST /login", tags: ["User Management"] },
      handler: async () => json({ code: P.OTHER_CAUSE, error: "Use POST /login: credentials are never accepted in the URL." }, 405),
    },
    {
      access: "public" as const,
      method: "POST" as const,
      path: "/logout",
      _openapi: { summary: "Log out (ends the engine-auth session too)", tags: ["User Management"] },
      handler: async (req: Request, ctx: Ctx) => {
        try {
          await facade().logOut(tokenOf(req, ctx));
          return json({});
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      access: "public" as const,
      method: "GET" as const,
      path: "/users/me",
      _openapi: { summary: "Current user", tags: ["User Management"] },
      handler: async (req: Request, ctx: Ctx) => {
        try {
          return json(await facade().me(tokenOf(req, ctx)));
        } catch (e) {
          return fail(e);
        }
      },
    },
    { access: "public" as const, method: "POST" as const, path: "/requestPasswordReset", _openapi: { summary: "Not available yet (501)" }, handler: notYet("Password reset") },
    { access: "public" as const, method: "POST" as const, path: "/verificationEmailRequest", _openapi: { summary: "Not available yet (501)" }, handler: notYet("E-mail verification") },
  ];
}
