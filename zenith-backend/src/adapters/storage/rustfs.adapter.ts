/**
 * RustFS / S3-compatible storage adapter for Zenith — Object storage integration.
 *
 * @barrits-trait
 * @barrits-summary ZenithRustFSAdapter
 * @barrits-provides file-storage, injectRustFSPlugin
 * @barrits-consumes
 * @barrits-state rustfs_plugin
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { StorageAdapter } from "../../core/types.ts";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Creates a RustFS / S3-compatible storage adapter implementing the StorageAdapter interface.
 * Uses the official @aws-sdk/client-s3, compatible with any S3-compatible service
 * (RustFS, MinIO, Garage, AWS S3, etc.). Supports resumable multipart uploads.
 *
 * @param client - Configured S3Client instance
 * @param bucket - Target S3 bucket name
 * @returns StorageAdapter — upload, download, delete, signed URL, and resumable upload interface
 */
export function createRustFSAdapter(client: S3Client, bucket: string): StorageAdapter {
  return {
    upload: async (path: string, data: Uint8Array, contentType: string): Promise<string> => {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: path,
          Body: data,
          ContentType: contentType,
        }),
      );
      return path;
    },

    download: async (path: string): Promise<Uint8Array> => {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: path,
        }),
      );
      const body = await result.Body?.transformToByteArray();
      if (!body) throw new Error(`[RustFS] File not found: ${path}`);
      return body;
    },

    delete: async (path: string): Promise<void> => {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: path,
        }),
      );
    },

    getSignedUrl: async (path: string, expiresIn = 3600): Promise<string> => {
      const command = new GetObjectCommand({ Bucket: bucket, Key: path });
      const url = await getSignedUrl(client, command, { expiresIn });
      return url;
    },

    startResumableUpload: async (path: string, contentType: string): Promise<string> => {
      const { CreateMultipartUploadCommand } = await import("@aws-sdk/client-s3");
      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: path,
          ContentType: contentType,
        }),
      );
      if (!result.UploadId) throw new Error("Failed to create multipart upload.");
      return result.UploadId;
    },

    uploadChunk: async (
      path: string,
      uploadId: string,
      partNumber: number,
      data: Uint8Array,
    ): Promise<string> => {
      const { UploadPartCommand } = await import("@aws-sdk/client-s3");
      const result = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: path,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: data,
        }),
      );
      if (!result.ETag) throw new Error("Failed to upload chunk.");
      return result.ETag;
    },

    completeResumableUpload: async (
      path: string,
      uploadId: string,
      parts: { PartNumber: number; ETag: string }[],
    ): Promise<void> => {
      const { CompleteMultipartUploadCommand } = await import("@aws-sdk/client-s3");
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: path,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts,
          },
        }),
      );
    },
  };
}

/**
 * TRAIT BARRITS: Inyector del plugin de almacenamiento en el ecosistema Zenith
 */
export const StorageRustfsTrait = createTraitDescriptor({
  name: "ZenithRustFSAdapter",
  provides: ["file-storage", "injectRustFSPlugin"],
  consumes: [],
  state: ["rustfs_plugin"],
  runtimes: ["deno"],
  create: (_deps: Record<string, unknown>) => {
    let adapter: StorageAdapter | null = null;

    return {
      injectRustFSPlugin: (plugin: StorageAdapter) => {
        adapter = plugin;
        console.log("[RustFSTrait] RustFS/S3 Plugin Injected");
      },
      // Exponemos la interfaz estándar bajo la llave "file-storage"
      "file-storage": {
        upload: (path: string, data: Uint8Array, contentType: string) =>
          adapter!.upload(path, data, contentType),
        download: (path: string) => adapter!.download(path),
        delete: (path: string) => adapter!.delete(path),
        getSignedUrl: (path: string, expiresIn?: number) => adapter!.getSignedUrl(path, expiresIn),
        startResumableUpload: (path: string, contentType: string) =>
          adapter!.startResumableUpload?.(path, contentType) as Promise<string>,
        uploadChunk: (path: string, uploadId: string, partNumber: number, data: Uint8Array) =>
          adapter!.uploadChunk?.(path, uploadId, partNumber, data) as Promise<string>,
        completeResumableUpload: (
          path: string,
          uploadId: string,
          parts: { PartNumber: number; ETag: string }[],
        ) => adapter!.completeResumableUpload?.(path, uploadId, parts) as Promise<void>,
      },
    };
  },
});
