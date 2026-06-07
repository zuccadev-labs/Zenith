import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const ACLTrait = createTraitDescriptor({
  name: "ZenithACL",
  provides: ["acl-routes", "acl", "aclEnforcer"],
  consumes: ["db", "telemetry"],
  state: ["roleCache"],
  runtimes: ["deno"],
  summary: "Parse Server-compatible ACL (Access Control List) and CLP (Class-Level Permissions) enforcement. Role inheritance, public read/write, per-user grants, master key bypass.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];

    const traitApi: any = {
      roleCache: new Map<string, Set<string>>(),

      checkRead: (aclPolicy: any, user: any): boolean => {
        if (!aclPolicy) return true;
        if (user?.masterKey) return true;
        if (aclPolicy["*"]?.r === true) return true;
        if (!user) return false;
        if (aclPolicy[user.objectId]?.r === true) return true;
        if (user.roles) {
          for (const role of user.roles) {
            if (aclPolicy[`role:${role}`]?.r === true) return true;
          }
        }
        return false;
      },

      checkWrite: (aclPolicy: any, user: any): boolean => {
        if (!aclPolicy) return true;
        if (user?.masterKey) return true;
        if (aclPolicy["*"]?.w === true) return true;
        if (!user) return false;
        if (aclPolicy[user.objectId]?.w === true) return true;
        if (user.roles) {
          for (const role of user.roles) {
            if (aclPolicy[`role:${role}`]?.w === true) return true;
          }
        }
        return false;
      },

      checkFieldRead: (aclPolicy: any, fieldName: string, user: any): boolean => {
        const protectedFields = aclPolicy?.protectedFields?.[fieldName];
        if (!protectedFields) return true;
        if (user?.masterKey) return true;
        if (protectedFields["*"] === true) return true;
        if (user && protectedFields[user.objectId] === true) return true;
        return false;
      },

      hasPublicWriteRestriction: (className: string): boolean => {
        if (className === "_User" || className === "_Role") return true;
        return false;
      },

      resolveRoles: async (userId: string): Promise<string[]> => {
        if (traitApi.roleCache.has(userId)) return Array.from(traitApi.roleCache.get(userId)!);
        const roles = await db.find("_Role", { users: { __type: "Pointer", className: "_User", objectId: userId } });
        const roleNames: string[] = [];
        for (const role of roles) {
          roleNames.push(role.name);
          if (role.roles) {
            for (const sub of role.roles) roleNames.push(sub.name || sub);
          }
        }
        traitApi.roleCache.set(userId, new Set(roleNames));
        return roleNames;
      },

      clearCache: (userId?: string) => {
        if (userId) traitApi.roleCache.delete(userId);
        else traitApi.roleCache.clear();
      },

      createRole: async (name: string, acl: any = { "*": { r: true } }, roles: string[] = []) => {
        const role = await db.create("_Role", { name, ACL: acl, roles: roles.map((r) => ({ __type: "Pointer", className: "_Role", objectId: r })) });
        traitApi.clearCache();
        return role;
      },

      addUserToRole: async (roleName: string, userId: string) => {
        const roles = await db.find("_Role", { name: roleName });
        if (roles.length === 0) throw new Error(`role not found: ${roleName}`);
        const role = roles[0];
        const users = role.users || [];
        if (!users.find((u: any) => u.objectId === userId)) {
          users.push({ __type: "Pointer", className: "_User", objectId: userId });
          await db.update("_Role", { objectId: role.objectId }, { users });
        }
        traitApi.clearCache(userId);
      },
    };

    const acl_routes = [
      {
        method: "POST" as const,
        path: "/roles",
        _openapi: {
          summary: "Create a new role",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, ACL: { type: "object" } }, required: ["name"] } } } },
        },
        handler: async (req: Request) => {
          const body = await req.json() as { name: string; ACL?: any };
          const role = await traitApi.createRole(body.name, body.ACL);
          return new Response(JSON.stringify(role), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/roles",
        _openapi: { summary: "List all roles" },
        handler: async () => {
          const roles = await db.find("_Role", {});
          return new Response(JSON.stringify({ results: roles }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/roles/:roleName/users/:userId",
        _openapi: {
          summary: "Add a user to a role",
          parameters: [{ name: "roleName", in: "path", required: true, schema: { type: "string" } }, { name: "userId", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request) => {
          const parts = new URL(req.url).pathname.split("/");
          const roleName = decodeURIComponent(parts[2]);
          const userId = parts[4];
          await traitApi.addUserToRole(roleName, userId);
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "acl-routes": acl_routes,
      "acl": traitApi,
      "aclEnforcer": traitApi,
    };
  },
});
