// deno-lint-ignore-file no-unused-vars
/**
 * Parse Server-compatible file storage: multipart upload, download, delete, with content-type detection, ACL, cloud triggers (beforeSaveFile/afterSaveFile), presigned URLs.
 *
 * @barrits-trait
 * @barrits-summary ZenithFileStorage
 * @barrits-provides storage-routes, storage, fileStore
 * @barrits-consumes acl, cloud, db
 * @barrits-state defaultBucket
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import { hmacSha256Hex, signingKey, timingSafeEqualString } from "../../core/crypto.ts";

/** Longest life of a signed file URL (the limit of AWS SigV4 presigned URLs). */
export const MAX_SIGNED_URL_SECONDS = 7 * 24 * 3600;

/** Where file contents live (`ZENITH_FILES_DIR`, default `./.zenith-storage`). */
export function filesDir(): string {
  try {
    return Deno.env.get("ZENITH_FILES_DIR") || "./.zenith-storage";
  } catch {
    return "./.zenith-storage";
  }
}

/** The content of a `_File`: by its storageKey (older records used their objectId). */
const contentPath = (file: { storageKey?: string; objectId: string }) => `${filesDir()}/${file.storageKey ?? file.objectId}`;

/** HMAC-SHA256 of `objectId:expires`, truncated to 128 bits (hex). */
export async function signFile(objectId: string, expiresMs: number): Promise<string> {
  return (await hmacSha256Hex(signingKey("FILE_SIGNING_KEY"), `${objectId}:${expiresMs}`)).slice(0, 32);
}

/**
 * Whether a signed URL's `expires` and `sig` are valid for `objectId` now. Constant-time comparison;
 * an expired, malformed or far-future (beyond MAX_SIGNED_URL_SECONDS) URL is refused.
 */
export async function verifyFileSignature(objectId: string, expires: string | null, sig: string | null, nowMs = Date.now()): Promise<boolean> {
  if (!expires || !sig || !/^\d{1,16}$/.test(expires) || !/^[0-9a-f]{32}$/.test(sig)) return false;
  const at = Number(expires);
  if (at <= nowMs || at - nowMs > MAX_SIGNED_URL_SECONDS * 1000) return false;
  return await timingSafeEqualString(await signFile(objectId, at), sig);
}

export const FileStorageTrait = createTraitDescriptor({
  name: "ZenithFileStorage",
  provides: ["storage-routes", "storage", "fileStore"],
  consumes: ["acl", "cloud", "db"],
  state: ["defaultBucket"],
  runtimes: ["deno"],
  summary: "Parse Server-compatible file storage: multipart upload, download, delete, with content-type detection, ACL, cloud triggers (beforeSaveFile/afterSaveFile), presigned URLs.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const acl = deps.traits["acl"];
    const cloud = deps.traits["cloud"];

    const traitApi: any = {
      defaultBucket: "zenith-files",

      detectContentType: (filename: string, bytes: Uint8Array): string => {
        const ext = filename.split(".").pop()?.toLowerCase();
        const map: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
          pdf: "application/pdf", json: "application/json", txt: "text/plain", html: "text/html",
          mp4: "video/mp4", mp3: "audio/mpeg", zip: "application/zip",
        };
        if (ext && map[ext]) return map[ext];
        if (bytes.length >= 4) {
          if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
          if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
          if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
        }
        return "application/octet-stream";
      },

      upload: async (filename: string, data: Uint8Array, options: { contentType?: string; acl?: any; metadata?: Record<string, any> } = {}) => {
        const contentType = options.contentType || traitApi.detectContentType(filename, data);
        // The content gets its own key: the database assigns the record's objectId.
        const storageKey = crypto.randomUUID();
        const file = {
          __type: "File",
          name: filename,
          url: `/files/${encodeURIComponent(filename)}`,
          contentType,
          size: data.length,
          storageKey,
          metadata: options.metadata || {},
          createdAt: new Date().toISOString(),
        };
        const aclPolicy = options.acl || { "*": { r: true, w: false } };
        if (cloud?.runFileTrigger) await cloud.runFileTrigger("beforeWrite", { file, data, user: options.metadata?.user });
        // Content first, record after: a failed write must not leave a _File without data (before, the
        // error was swallowed and the directory was never created, so every upload lost its content).
        await Deno.mkdir(filesDir(), { recursive: true });
        await Deno.writeFile(`${filesDir()}/${storageKey}`, data);
        let fileRecord;
        try {
          fileRecord = await db.create("_File", { ...file, ACL: aclPolicy });
        } catch (e) {
          await Deno.remove(`${filesDir()}/${storageKey}`).catch(() => {});
          throw e;
        }
        if (cloud?.runFileTrigger) await cloud.runFileTrigger("afterWrite", { file: fileRecord, user: options.metadata?.user });
        return fileRecord;
      },

      download: async (name: string): Promise<{ data: Uint8Array; contentType: string } | null> => {
        const files = await db.find("_File", { name });
        if (files.length === 0) return null;
        const file = files[0];
        try {
          const data = await Deno.readFile(contentPath(file));
          return { data, contentType: file.contentType };
        } catch (_e) { return null; }
      },

      delete: async (name: string): Promise<boolean> => {
        const files = await db.find("_File", { name });
        if (files.length === 0) return false;
        const file = files[0];
        if (cloud?.runFileTrigger) await cloud.runFileTrigger("beforeDelete", { file, user: null });
        await db.delete("_File", { objectId: file.objectId });
        await Deno.remove(contentPath(file)).catch(() => {});
        if (cloud?.runFileTrigger) await cloud.runFileTrigger("afterDelete", { file, user: null });
        return true;
      },

      /**
       * A URL anyone can use to download the file until it expires (`expiresIn` seconds, 1 to 7 days
       * max). Served by GET /files/:objectId/:filename, which checks the signature.
       */
      presignedUrl: async (name: string, expiresIn: number = 3600): Promise<string | null> => {
        if (!Number.isFinite(expiresIn) || expiresIn < 1 || expiresIn > MAX_SIGNED_URL_SECONDS) {
          throw Object.assign(new Error(`expiresIn: 1 to ${MAX_SIGNED_URL_SECONDS} seconds.`), { httpStatus: 400, code: 142 });
        }
        const files = await db.find("_File", { name });
        if (files.length === 0) return null;
        const file = files[0];
        const expires = Date.now() + Math.floor(expiresIn) * 1000;
        // HMAC-SHA256 truncated to 128 bits (core/crypto.ts). Before: sha256(data + key) with the key
        // "default" when FILE_SIGNING_KEY was missing, so anyone could sign a URL.
        return `/files/${file.objectId}/${encodeURIComponent(name)}?expires=${expires}&sig=${await signFile(file.objectId, expires)}`;
      },

      /** The file a signed URL points to, or null if the signature, expiry or name do not match. */
      downloadSigned: async (objectId: string, name: string, expires: string | null, sig: string | null) => {
        if (!(await verifyFileSignature(objectId, expires, sig))) return null;
        const file = await db.read("_File", objectId);
        if (!file || file.name !== name) return null;
        try {
          return { data: await Deno.readFile(contentPath(file)), contentType: file.contentType as string, name: file.name as string };
        } catch (_e) {
          return null;
        }
      },
    };

    const storage_routes = [
      {
        method: "POST" as const,
        path: "/files/:filename",
        _openapi: {
          summary: "Upload a file",
          parameters: [{ name: "filename", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        },
        handler: async (req: Request) => {
          const filename = decodeURIComponent(new URL(req.url).pathname.split("/")[2]);
          const data = new Uint8Array(await req.arrayBuffer());
          const file = await traitApi.upload(filename, data, { contentType: req.headers.get("content-type") || undefined });
          return new Response(JSON.stringify(file), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/files/:filename",
        _openapi: { summary: "Download a file by name", parameters: [{ name: "filename", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const filename = decodeURIComponent(new URL(req.url).pathname.split("/")[2]);
          const result = await traitApi.download(filename);
          if (!result) return new Response(JSON.stringify({ error: "file not found" }), { status: 404, headers: { "content-type": "application/json" } });
          return new Response(result.data, { status: 200, headers: { "content-type": result.contentType, "content-length": String(result.data.length) } });
        },
      },
      {
        method: "GET" as const,
        path: "/files/:objectId/:filename",
        access: "public" as const,
        _openapi: {
          summary: "Download a file through a signed URL (expires, sig); 403 if the signature is invalid or expired",
          parameters: [
            { name: "expires", in: "query", required: true, schema: { type: "string" } },
            { name: "sig", in: "query", required: true, schema: { type: "string" } },
          ],
        },
        handler: async (req: Request, ctx: any) => {
          const url = new URL(req.url);
          const objectId = String(ctx?.params?.objectId ?? "");
          const name = decodeURIComponent(String(ctx?.params?.filename ?? ""));
          const result = await traitApi.downloadSigned(objectId, name, url.searchParams.get("expires"), url.searchParams.get("sig"));
          // One answer for a bad signature and a missing file: the URL reveals nothing.
          if (!result) return new Response(JSON.stringify({ code: 119, error: "Invalid or expired signed URL." }), { status: 403, headers: { "content-type": "application/json" } });
          return new Response(result.data, {
            status: 200,
            headers: {
              "content-type": result.contentType || "application/octet-stream",
              "content-length": String(result.data.length),
              "x-content-type-options": "nosniff",
              "cache-control": "private, max-age=0",
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
            },
          });
        },
      },
      {
        method: "GET" as const,
        path: "/zen/files/:filename/url",
        access: "master" as const,
        _openapi: { summary: "Create a signed download URL (?expiresIn=seconds, default 3600, max 7 days)", tags: ["Files"] },
        handler: async (req: Request, ctx: any) => {
          const raw = new URL(req.url).searchParams.get("expiresIn");
          const expiresIn = raw === null ? 3600 : Number(raw);
          try {
            const path = await traitApi.presignedUrl(decodeURIComponent(String(ctx?.params?.filename ?? "")), expiresIn);
            if (!path) return new Response(JSON.stringify({ code: 101, error: "file not found" }), { status: 404, headers: { "content-type": "application/json" } });
            // Usable as is: with the prefix the app is mounted under (/parse in the multi-app server,
            // which sends it as X-Forwarded-Prefix). Only a plain path prefix is accepted.
            const prefix = req.headers.get("x-forwarded-prefix") ?? "";
            const mount = /^(\/[A-Za-z0-9._~-]+)+$/.test(prefix) ? prefix : "";
            return new Response(JSON.stringify({ url: `${mount}${path}`, expiresIn }), { status: 200, headers: { "content-type": "application/json" } });
          } catch (e) {
            return new Response(JSON.stringify({ code: 142, error: (e as Error).message }), { status: 400, headers: { "content-type": "application/json" } });
          }
        },
      },
      {
        method: "DELETE" as const,
        path: "/files/:filename",
        _openapi: { summary: "Delete a file by name", parameters: [{ name: "filename", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const filename = decodeURIComponent(new URL(req.url).pathname.split("/")[2]);
          const ok = await traitApi.delete(filename);
          return new Response(null, { status: ok ? 204 : 404 });
        },
      },
    ];

    return {
      "storage-routes": storage_routes,
      "storage": traitApi,
      "fileStore": traitApi,
    };
  },
});
