// deno-lint-ignore-file no-unused-vars
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const FileStorageTrait = createTraitDescriptor({
  name: "ZenithFileStorage",
  provides: ["storage-routes", "storage", "fileStore"],
  consumes: ["db", "acl", "cloud", "telemetry"],
  state: ["defaultBucket"],
  runtimes: ["deno"],
  summary: "Parse Server-compatible file storage: multipart upload, download, delete, with content-type detection, ACL, cloud triggers (beforeSaveFile/afterSaveFile), presigned URLs.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];
    const acl = deps["acl"];
    const cloud = deps["cloud"];

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
        const objectId = crypto.randomUUID();
        const file = {
          __type: "File",
          name: filename,
          url: `/files/${objectId}/${encodeURIComponent(filename)}`,
          contentType,
          size: data.length,
          objectId,
          metadata: options.metadata || {},
          createdAt: new Date().toISOString(),
        };
        const aclPolicy = options.acl || { "*": { r: true, w: false } };
        if (cloud?.runFileTrigger) await cloud.runFileTrigger("beforeWrite", { file, data, user: options.metadata?.user });
        const fileRecord = await db.create("_File", { ...file, ACL: aclPolicy });
        const dataBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        const blob = new Blob([dataBuffer], { type: contentType });
        await Deno.writeFile(`./.zenith-storage/${objectId}`, new Uint8Array(await blob.arrayBuffer())).catch(() => {});
        if (cloud?.runFileTrigger) await cloud.runFileTrigger("afterWrite", { file: fileRecord, user: options.metadata?.user });
        return fileRecord;
      },

      download: async (name: string): Promise<{ data: Uint8Array; contentType: string } | null> => {
        const files = await db.find("_File", { name });
        if (files.length === 0) return null;
        const file = files[0];
        try {
          const data = await Deno.readFile(`./.zenith-storage/${file.objectId}`);
          return { data, contentType: file.contentType };
        } catch (_e) { return null; }
      },

      delete: async (name: string): Promise<boolean> => {
        const files = await db.find("_File", { name });
        if (files.length === 0) return false;
        const file = files[0];
        if (cloud?.runFileTrigger) await cloud.runFileTrigger("beforeDelete", { file, user: null });
        await db.delete("_File", { objectId: file.objectId });
        await Deno.remove(`./.zenith-storage/${file.objectId}`).catch(() => {});
        if (cloud?.runFileTrigger) await cloud.runFileTrigger("afterDelete", { file, user: null });
        return true;
      },

      presignedUrl: async (name: string, expiresIn: number = 3600): Promise<string | null> => {
        const files = await db.find("_File", { name });
        if (files.length === 0) return null;
        const file = files[0];
        const expires = Date.now() + expiresIn * 1000;
        const sig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${file.objectId}:${expires}:${Deno.env.get("FILE_SIGNING_KEY") || "default"}`));
        const sigHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
        return `/files/${file.objectId}/${encodeURIComponent(name)}?expires=${expires}&sig=${sigHex}`;
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
