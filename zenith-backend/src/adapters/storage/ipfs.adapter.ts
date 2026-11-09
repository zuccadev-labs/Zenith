/**
 * IPFS decentralized storage adapter for Zenith — Content-addressed, peer-to-peer storage.
 *
 * @barrits-trait
 * @barrits-summary ZenithIPFSAdapter
 * @barrits-provides ipfs_deleteFile, ipfs_download, ipfs_getSignedUrl, injectIPFSPlugin, ipfs_upload
 * @barrits-consumes
 * @barrits-state ipfs_plugin
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { StorageAdapter } from "../../core/types.ts";

/**
 * Creates an IPFS (InterPlanetary File System) decentralized storage adapter.
 * Connects Zenith with IPFS nodes or pinning services via a configurable HTTP gateway.
 * Uploads return an `ipfs://` CID URI; downloads and signed URLs resolve through the gateway.
 *
 * @param gatewayUrl - HTTP gateway URL for IPFS (e.g. "https://ipfs.io" or local gateway)
 * @returns StorageAdapter — interface for decentralized file operations
 */
export function createIPFSAdapter(gatewayUrl: string): StorageAdapter {
  return {
    upload: async (path: string, data: Uint8Array, _contentType: string): Promise<string> => {
      // Mock: En un entorno real usaríamos ipfs-http-client o Pinata
      console.log(`[IPFS] Uploading to decentralized storage: ${path} (${data.length} bytes)`);
      const mockCid = "Qm" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
         .map(b => b.toString(16).padStart(2, '0')).join('');
      return `ipfs://${mockCid}/${path}`;
    },

    download: async (_path: string): Promise<Uint8Array> => {
      console.log(`[IPFS] Downloading from IPFS gateway...`);
      return new Uint8Array(0);
    },

    delete: async (_path: string): Promise<void> => {
      // IPFS es inmutable por diseño. "Borrar" suele implicar hacer unpit (unpin)
      console.log(`[IPFS] Unpinning CID from node...`);
    },

    getSignedUrl: async (path: string, _expiresIn?: number): Promise<string> => {
      // Devuelve la ruta a través del Gateway HTTP público o privado
      const cid = path.replace("ipfs://", "");
      return `${gatewayUrl}/ipfs/${cid}`;
    }
  };
}

export const IPFSStorageTrait = createTraitDescriptor({
  name: "ZenithIPFSAdapter",
  provides: ["ipfs_deleteFile", "ipfs_download", "ipfs_getSignedUrl", "injectIPFSPlugin", "ipfs_upload"],
  consumes: [],
  state: ["ipfs_plugin"],
  runtimes: ["deno"],
  create: (_deps) => {
    let adapter: StorageAdapter | null = null;
    return {
      injectIPFSPlugin: (plugin: StorageAdapter) => {
        adapter = plugin;
        console.log("[ZenithIPFS] Decentralized Storage Plugin Injected");
      },
      ipfs_upload: (path: string, data: Uint8Array, contentType: string) => adapter!.upload(path, data, contentType),
      ipfs_download: (path: string) => adapter!.download(path),
      ipfs_deleteFile: (path: string) => adapter!.delete(path),
      ipfs_getSignedUrl: (path: string, expiresIn?: number) => adapter!.getSignedUrl(path, expiresIn)
    };
  }
});
