// deno-lint-ignore-file no-unused-vars
/**
 * End-to-end encryption key server: ephemeral key distribution for WebRTC insertable streams, MLS-like ratchet key updates, per-user key pairs, signed pre-keys.
 *
 * @barrits-trait
 * @barrits-summary ZenithE2EEKeys
 * @barrits-provides e2ee-keys-routes, e2ee-keys, keyServer
 * @barrits-consumes db, acl, telemetry
 * @barrits-state keyServer
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const E2EEKeysTrait = createTraitDescriptor({
  name: "ZenithE2EEKeys",
  provides: ["e2ee-keys-routes", "e2ee-keys", "keyServer"],
  consumes: ["db", "acl", "telemetry"],
  state: ["keyServer"],
  runtimes: ["deno"],
  summary: "End-to-end encryption key server: ephemeral key distribution for WebRTC insertable streams, MLS-like ratchet key updates, per-user key pairs, signed pre-keys.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];

    const traitApi: any = {
      keyServer: { type: "mls-lite", rotationPolicy: "per-session" },

      generateKeyPair: async (userId: string): Promise<{ keyId: string; publicKey: string; createdAt: string }> => {
        const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        const publicKeyBuf = await crypto.subtle.exportKey("spki", keyPair.publicKey);
        const publicKey = btoa(String.fromCharCode(...new Uint8Array(publicKeyBuf)));
        const keyId = crypto.randomUUID();
        const record = {
          userId,
          keyId,
          publicKey,
          algorithm: "ECDSA-P256",
          createdAt: new Date().toISOString(),
        };
        await db.create("_E2EEKey", record);
        return { keyId, publicKey, createdAt: record.createdAt };
      },

      getPublicKey: async (userId: string): Promise<string | null> => {
        const keys = await db.find("_E2EEKey", { userId });
        if (keys.length === 0) return null;
        return keys[keys.length - 1].publicKey;
      },

      rotateKey: async (userId: string) => {
        const newKey = await traitApi.generateKeyPair(userId);
        return newKey;
      },
    };

    const e2ee_keys_routes = [
      {
        method: "POST" as const,
        path: "/e2ee/keys",
        _openapi: { summary: "Generate a new key pair for the current user" },
        handler: async (req: Request, ctx: any) => {
          const userId = ctx?.user?.objectId || "anonymous";
          const kp = await traitApi.generateKeyPair(userId);
          return new Response(JSON.stringify(kp), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/e2ee/keys/:userId",
        _openapi: { summary: "Get public key for a user", parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const userId = new URL(req.url).pathname.split("/")[3];
          const pk = await traitApi.getPublicKey(userId);
          if (!pk) return new Response(JSON.stringify({ error: "no key found" }), { status: 404, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ userId, publicKey: pk }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "e2ee-keys-routes": e2ee_keys_routes,
      "e2ee-keys": traitApi,
      "keyServer": traitApi,
    };
  },
});
