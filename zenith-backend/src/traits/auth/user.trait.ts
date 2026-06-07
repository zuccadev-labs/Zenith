// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const UserManagementTrait = createTraitDescriptor({
  name: "ZenithUserManagement",
  provides: ["user-routes", "user-manager"],
  consumes: ["db", "crypto", "schema", "acl", "ratelimit", "telemetry"],
  state: ["usersCollection", "sessionTokens"],
  runtimes: ["deno"],
  summary: "User registration, login, password reset, email verification, MFA, session tokens (Parse Server-compatible).",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const crypto = deps["crypto"];
    const schema = deps["schema"];

    const traitApi: any = {
      usersCollection: "_User",
      sessionTokens: new Map<string, { userId: string; expiresAt: number }>(),

      signUp: async (username: string, password: string, email?: string, attributes: Record<string, any> = {}) => {
        if (!username || !password) throw new Error("username and password required");
        const existing = await db.find("_User", { username });
        if (existing.length > 0) throw new Error("username already taken");
        const hash = await crypto.hash.argon2id(password);
        const user = await db.create("_User", {
          username,
          email: email || null,
          passwordHash: hash,
          emailVerified: false,
          ...attributes,
        });
        return { objectId: user.objectId, username: user.username, email: user.email };
      },

      logIn: async (username: string, password: string) => {
        const users = await db.find("_User", { username });
        if (users.length === 0) throw new Error("invalid username/password");
        const user = users[0];
        const ok = await crypto.hash.verifyArgon2id(user.passwordHash, password);
        if (!ok) throw new Error("invalid username/password");
        const tokenBytes = crypto.random.bytes(32);
        const token = crypto.random.hex(32);
        const expiresAt = Date.now() + (1000 * 60 * 60 * 24 * 365);
        traitApi.sessionTokens.set(token, { userId: user.objectId, expiresAt });
        return {
          objectId: user.objectId,
          username: user.username,
          sessionToken: token,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      },

      logOut: async (sessionToken: string) => {
        traitApi.sessionTokens.delete(sessionToken);
        return { success: true };
      },

      getCurrentUser: async (sessionToken: string) => {
        const session = traitApi.sessionTokens.get(sessionToken);
        if (!session || session.expiresAt < Date.now()) {
          throw new Error("invalid session token");
        }
        const user = await db.read("_User", session.userId);
        if (!user) throw new Error("user not found");
        const { passwordHash, ...safe } = user;
        return safe;
      },

      requestPasswordReset: async (email: string) => {
        const users = await db.find("_User", { email });
        if (users.length === 0) return { success: true };
        const user = users[0];
        const resetToken = crypto.random.hex(32);
        const expiresAt = Date.now() + (1000 * 60 * 60);
        await db.update("_User", { objectId: user.objectId }, { passwordResetToken: resetToken, passwordResetExpires: expiresAt });
        return { success: true, resetToken: process.env.NODE_ENV === "test" ? resetToken : undefined };
      },

      verifyEmail: async (objectId: string) => {
        await db.update("_User", { objectId }, { emailVerified: true });
        return { success: true };
      },

      enableMfa: async (objectId: string) => {
        const secret = crypto.random.base64(20);
        await db.update("_User", { objectId }, { mfaSecret: secret, mfaEnabled: true });
        return { secret };
      },

      verifyMfa: async (objectId: string, code: string) => {
        const users = await db.find("_User", { objectId });
        if (users.length === 0) throw new Error("user not found");
        const user = users[0];
        if (!user.mfaEnabled || !user.mfaSecret) throw new Error("MFA not enabled");
        const totp = await import("otpauth");
        const totpInstance = new totp.TOTP({ secret: user.mfaSecret, algorithm: "SHA1", digits: 6, period: 30 });
        const delta = totpInstance.validate({ token: code, window: 1 });
        if (delta === null) throw new Error("invalid MFA code");
        return { verified: true };
      },
    };

    const user_routes = [
      {
        method: "POST" as const,
        path: "/users",
        _openapi: {
          summary: "Sign up new user",
          tags: ["User Management"],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" }, email: { type: "string" } }, required: ["username", "password"] } } } },
        },
        handler: async (req: Request) => {
          try {
            const body = await req.json() as any;
            const result = await traitApi.signUp(body.username, body.password, body.email, body);
            return new Response(JSON.stringify(result), { status: 201, headers: { "content-type": "application/json" } });
          } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { "content-type": "application/json" } });
          }
        },
      },
      {
        method: "GET" as const,
        path: "/login",
        _openapi: {
          summary: "Log in user (Parse Server GET /login for browser compat)",
          parameters: [{ name: "username", in: "query", required: true, schema: { type: "string" } }, { name: "password", in: "query", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request) => {
          const url = new URL(req.url);
          const username = url.searchParams.get("username");
          const password = url.searchParams.get("password");
          if (!username || !password) return new Response(JSON.stringify({ error: "username and password required" }), { status: 400, headers: { "content-type": "application/json" } });
          try {
            const result = await traitApi.logIn(username, password);
            return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
          } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: { "content-type": "application/json" } });
          }
        },
      },
      {
        method: "POST" as const,
        path: "/login",
        _openapi: {
          summary: "Log in user (POST)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" } }, required: ["username", "password"] } } } },
        },
        handler: async (req: Request) => {
          const body = await req.json() as any;
          try {
            const result = await traitApi.logIn(body.username, body.password);
            return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
          } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: { "content-type": "application/json" } });
          }
        },
      },
      {
        method: "POST" as const,
        path: "/logout",
        _openapi: { summary: "Log out (invalidate session token)" },
        handler: async (req: Request) => {
          const token = req.headers.get("x-parse-session-token") || (await req.text());
          await traitApi.logOut(token);
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/users/me",
        _openapi: { summary: "Get current user by session token" },
        handler: async (req: Request) => {
          const token = req.headers.get("x-parse-session-token") || "";
          try {
            const user = await traitApi.getCurrentUser(token);
            return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } });
          } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: { "content-type": "application/json" } });
          }
        },
      },
      {
        method: "POST" as const,
        path: "/requestPasswordReset",
        _openapi: {
          summary: "Request password reset email",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } } } },
        },
        handler: async (req: Request) => {
          const body = await req.json() as { email: string };
          const result = await traitApi.requestPasswordReset(body.email);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "user-routes": user_routes,
      "user-manager": traitApi,
    };
  },
});
