// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const CryptoTrait = createTraitDescriptor({
  name: "ZenithCrypto",
  provides: ["crypto-routes", "hash", "hmac", "encrypt", "decrypt"],
  consumes: [],
  state: ["cryptoKeys"],
  runtimes: ["deno"],
  summary: "Argon2id password hashing, HMAC-SHA256 signing, AES-256-GCM symmetric encryption (Fortune 500-grade).",
  create: (deps: Record<string, any>) => {
    const traitApi: any = {
      hash: {
        argon2id: async (password: string, salt?: Uint8Array): Promise<string> => {
          const argon2 = await import("@node-rs/argon2");
          const result = await argon2.hash(password, { algorithm: 2 });
          return result;
        },
        verifyArgon2id: async (hash: string, password: string): Promise<boolean> => {
          const argon2 = await import("@node-rs/argon2");
          return await argon2.verify(hash, password);
        },
        sha256: async (input: string | Uint8Array): Promise<string> => {
          const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
          const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
          const hash = await crypto.subtle.digest("SHA-256", buffer);
          return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
        },
        sha512: async (input: string | Uint8Array): Promise<string> => {
          const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
          const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
          const hash = await crypto.subtle.digest("SHA-512", buffer);
          return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
        },
      },
      hmac: {
        sign: async (key: string, message: string, algorithm: "SHA-256" | "SHA-512" = "SHA-256"): Promise<string> => {
          const cryptoKey = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(key),
            { name: "HMAC", hash: algorithm },
            false,
            ["sign"]
          );
          const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
          return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
        },
        verify: async (key: string, message: string, signature: string, algorithm: "SHA-256" | "SHA-512" = "SHA-256"): Promise<boolean> => {
          const cryptoKey = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(key),
            { name: "HMAC", hash: algorithm },
            false,
            ["verify"]
          );
          const sigBytes = new Uint8Array(signature.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
          return await crypto.subtle.verify("HMAC", cryptoKey, sigBytes, new TextEncoder().encode(message));
        },
      },
      encrypt: {
        aes256gcm: async (plaintext: string, keyBase64: string): Promise<{ iv: string; ciphertext: string; tag: string }> => {
          const key = await crypto.subtle.importKey(
            "raw",
            Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0)),
            { name: "AES-GCM" },
            false,
            ["encrypt"]
          );
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encoded = new TextEncoder().encode(plaintext);
          const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
          const ciphertext = new Uint8Array(ct);
          return {
            iv: btoa(String.fromCharCode(...iv)),
            ciphertext: btoa(String.fromCharCode(...ciphertext.slice(0, -16))),
            tag: btoa(String.fromCharCode(...ciphertext.slice(-16))),
          };
        },
        aes256gcmDecrypt: async (ivBase64: string, ciphertextBase64: string, tagBase64: string, keyBase64: string): Promise<string> => {
          const key = await crypto.subtle.importKey(
            "raw",
            Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0)),
            { name: "AES-GCM" },
            false,
            ["decrypt"]
          );
          const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
          const ciphertext = new Uint8Array([
            ...Uint8Array.from(atob(ciphertextBase64), c => c.charCodeAt(0)),
            ...Uint8Array.from(atob(tagBase64), c => c.charCodeAt(0)),
          ]);
          const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
          return new TextDecoder().decode(pt);
        },
      },
      decrypt: {
        aes256gcm: async (ivBase64: string, ciphertextBase64: string, tagBase64: string, keyBase64: string): Promise<string> => {
          return traitApi.encrypt.aes256gcmDecrypt(ivBase64, ciphertextBase64, tagBase64, keyBase64);
        },
      },
      random: {
        bytes: (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n)),
        hex: (n: number): string => {
          const arr = crypto.getRandomValues(new Uint8Array(n));
          return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
        },
        base64: (n: number): string => {
          const arr = crypto.getRandomValues(new Uint8Array(n));
          return btoa(String.fromCharCode(...arr));
        },
      },
    };

    const crypto_routes = [
      {
        method: "POST" as const,
        path: "/crypto/hash",
        _openapi: {
          summary: "Hash password with Argon2id",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { password: { type: "string" } }, required: ["password"] } } } },
        },
        handler: async (req: Request) => {
          const body = await req.json() as { password: string };
          if (!body?.password) return new Response(JSON.stringify({ error: "password required" }), { status: 400, headers: { "content-type": "application/json" } });
          const hash = await traitApi.hash.argon2id(body.password);
          return new Response(JSON.stringify({ hash }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/crypto/hmac",
        _openapi: {
          summary: "Sign message with HMAC-SHA256/512",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { key: { type: "string" }, message: { type: "string" }, algorithm: { type: "string", enum: ["SHA-256", "SHA-512"] } }, required: ["key", "message"] } } } },
        },
        handler: async (req: Request) => {
          const body = await req.json() as { key: string; message: string; algorithm?: "SHA-256" | "SHA-512" };
          if (!body?.key || !body?.message) return new Response(JSON.stringify({ error: "key and message required" }), { status: 400, headers: { "content-type": "application/json" } });
          const sig = await traitApi.hmac.sign(body.key, body.message, body.algorithm);
          return new Response(JSON.stringify({ signature: sig }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "crypto-routes": crypto_routes,
      "hash": traitApi.hash,
      "hmac": traitApi.hmac,
      "encrypt": traitApi.encrypt,
      "decrypt": traitApi.decrypt,
    };
  },
});
