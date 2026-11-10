import { useState } from "react";
import { ZenithFile } from "../objects/ZenithFile.js";
import { useZenithContext } from "./ZenithProvider.js";

/**
 * Uploads files with the session of the signed-in user.
 *
 * @example
 * const { upload, isUploading } = useZenithFile();
 * const file = await upload(input.files[0]);      // ZenithFile
 * message.set("attachment", file.toJSON());
 * console.log(file.url);
 */
export function useZenithFile() {
  const { isInitialized } = useZenithContext();
  const [isUploading, setIsUploading] = useState(false);
  // 0 before, 100 when done: fetch does not report upload progress.
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  /** Uploads `data` as `name` (default: the file's own name) and returns the saved ZenithFile. */
  const upload = async (data: File | Blob, name?: string): Promise<ZenithFile> => {
    if (!isInitialized) throw new Error("Zenith SDK not initialized");
    const fileName = name ?? (data instanceof File ? data.name : undefined);
    if (!fileName) throw new Error("useZenithFile.upload: a Blob needs a name.");

    setIsUploading(true);
    setProgress(0);
    setError(null);
    try {
      const saved = await new ZenithFile(fileName, data).save();
      setProgress(100);
      return saved;
    } catch (e) {
      setError(e as Error);
      throw e;
    } finally {
      setIsUploading(false);
    }
  };

  return { upload, isUploading, progress, error };
}
