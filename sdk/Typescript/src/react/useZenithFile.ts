import { useState } from "react";
import { Zenith } from "../core/Zenith.js";
import { RESTController } from "../rest/RESTController.js";
import { useZenithContext } from "./ZenithProvider.js";

export function useZenithFile() {
  const { isInitialized } = useZenithContext();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  const upload = async (file: File) => {
    if (!isInitialized) throw new Error("Zenith SDK not initialized");
    
    setIsUploading(true);
    setProgress(0);
    setError(null);

    try {
      // Basic implementation without real progress events yet.
      // In a real military-grade SDK, we would use XMLHttpRequest to get upload progress.
      // For now we simulate it.
      setProgress(50);
      
      // We should send raw body, wait, RESTController expects JSON. Let's do raw fetch:
      const config = Zenith.getConfig();
      const headers: Record<string, string> = {
        "Content-Type": file.type,
        "Zen-Application-Id": config.appId,
      };
      
      const sessionToken = Zenith.sessionToken;
      if (sessionToken) headers["Zen-Session-Token"] = sessionToken;

      const response = await fetch(`${config.serverURL}/files/${file.name}`, {
        method: "POST",
        headers,
        body: file
      });
      
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const data = await response.json();
      setProgress(100);
      setIsUploading(false);
      return data;
    } catch (e: any) {
      setError(e);
      setIsUploading(false);
      throw e;
    }
  };

  return { upload, isUploading, progress, error };
}
