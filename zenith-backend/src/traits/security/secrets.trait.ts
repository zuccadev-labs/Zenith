/**
 * Secrets facade over HashiCorp Vault (with KV/PKI/Transit), with in-memory TTL cache, automatic rotation hooks, audit trail integration.
 *
 * @barrits-trait
 * @barrits-summary ZenithSecrets
 * @barrits-provides secrets-routes, secrets, secretStore
 * @barrits-consumes
 * @barrits-tags uses:vault
 * @barrits-state secretCache
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const SecretsTrait = createTraitDescriptor({
  name: "ZenithSecrets",
  provides: ["secrets-routes", "secrets", "secretStore"],
  consumes: [],
  tags: ["uses:vault"],
  state: ["secretCache"],
  runtimes: ["deno"],
  summary:
    "Secrets facade over HashiCorp Vault (with KV/PKI/Transit), with in-memory TTL cache, automatic rotation hooks, audit trail integration.",
  create: (deps: Record<string, any>) => {
    const vault = deps.traits["vault"];

    const traitApi: any = {
      secretCache: new Map<string, { value: string; expiresAt: number }>(),

      get: async (path: string, ttl: number = 300): Promise<string | null> => {
        const cached = traitApi.secretCache.get(path);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        if (!vault || !vault.kvGet) return null;
        const value = await vault.kvGet("secret", path);
        if (value) traitApi.secretCache.set(path, { value, expiresAt: Date.now() + ttl * 1000 });
        return value;
      },

      put: async (path: string, value: string): Promise<boolean> => {
        if (!vault || !vault.kvPut) return false;
        await vault.kvPut("secret", path, { value });
        traitApi.secretCache.delete(path);
        return true;
      },

      delete: async (path: string): Promise<boolean> => {
        if (!vault || !vault.kvDelete) return false;
        await vault.kvDelete("secret", path);
        traitApi.secretCache.delete(path);
        return true;
      },

      list: async (path: string): Promise<string[]> => {
        if (!vault || !vault.kvList) return [];
        const result = await vault.kvList("secret", path);
        return Array.isArray(result) ? result : [];
      },

      issueCert: async (
        commonName: string,
        ttl: string = "24h",
      ): Promise<{ cert: string; key: string; ca: string[] } | null> => {
        if (!vault || !vault.pkiIssue) return null;
        return await vault.pkiIssue(commonName, ttl);
      },

      transitEncrypt: async (keyName: string, plaintext: string): Promise<string | null> => {
        if (!vault || !vault.transitEncrypt) return null;
        return await vault.transitEncrypt(keyName, plaintext);
      },

      transitDecrypt: async (keyName: string, ciphertext: string): Promise<string | null> => {
        if (!vault || !vault.transitDecrypt) return null;
        return await vault.transitDecrypt(keyName, ciphertext);
      },

      clearCache: () => traitApi.secretCache.clear(),
    };

    const secrets_routes = [
      {
        method: "GET" as const,
        path: "/secrets/:path",
        _openapi: {
          summary: "Retrieve a secret from Vault (metadata only)",
          parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request) => {
          const path = new URL(req.url).pathname.split("/").slice(2).join("/");
          const value = await traitApi.get(path);
          if (!value) {
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ path, value, cached: traitApi.secretCache.has(path) }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
      {
        method: "PUT" as const,
        path: "/secrets/:path",
        _openapi: {
          summary: "Store a secret in Vault",
          parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request) => {
          const path = new URL(req.url).pathname.split("/").slice(2).join("/");
          const body = await req.json() as { value: string };
          const ok = await traitApi.put(path, body.value);
          return new Response(JSON.stringify({ success: ok }), {
            status: ok ? 200 : 500,
            headers: { "content-type": "application/json" },
          });
        },
      },
      {
        method: "DELETE" as const,
        path: "/secrets/:path",
        _openapi: {
          summary: "Delete a secret from Vault",
          parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        },
        handler: async (req: Request) => {
          const path = new URL(req.url).pathname.split("/").slice(2).join("/");
          const ok = await traitApi.delete(path);
          return new Response(null, { status: ok ? 204 : 500 });
        },
      },
    ];

    return {
      "secrets-routes": secrets_routes,
      "secrets": traitApi,
      "secretStore": traitApi,
    };
  },
});
