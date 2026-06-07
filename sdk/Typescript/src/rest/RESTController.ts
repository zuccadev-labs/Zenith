import { Zenith } from "../core/Zenith.js";
import { ZenithError } from "../core/ZenithError.js";

export class RESTController {
  
  /**
   * EN: Executes an HTTP request to the Zenith backend, automatically handling
   * authentication headers and dual-header compatibility (Parse / Zenith).
   */
  public static async request(
    method: string,
    path: string,
    data?: any,
    options: { useMasterKey?: boolean, sessionToken?: string } = {}
  ): Promise<any> {
    const config = Zenith.getConfig();
    const context = Zenith.getContext();
    const url = `${config.serverURL}${path.startsWith("/") ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Zen-Application-Id": config.appId,
      "X-Parse-Application-Id": config.appId, // Parity
    };

    if (options.useMasterKey && config.masterKey) {
      headers["Zen-Master-Key"] = config.masterKey;
      headers["X-Parse-Master-Key"] = config.masterKey;
    } else if (config.javascriptKey) {
      headers["Zen-JavaScript-Key"] = config.javascriptKey;
      headers["X-Parse-JavaScript-Key"] = config.javascriptKey;
    } else if (config.clientKey) {
      headers["Zen-Client-Key"] = config.clientKey;
      headers["X-Parse-Client-Key"] = config.clientKey;
    } else if (config.restApiKey) {
      headers["Zen-Api-Key"] = config.restApiKey;
      headers["X-Parse-REST-API-Key"] = config.restApiKey;
    }

    const token = options.sessionToken || context.sessionToken;
    if (token) {
      headers["Zen-Session-Token"] = token;
      headers["X-Parse-Session-Token"] = token;
      // Modern standard:
      headers["Authorization"] = `Bearer ${token}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (data && (method === "POST" || method === "PUT")) {
      fetchOptions.body = JSON.stringify(data);
    }

    // For GET queries
    let finalUrl = url;
    if (data && method === "GET") {
      const qs = new URLSearchParams();
      for (const key in data) {
        if (typeof data[key] === "object") {
          qs.append(key, JSON.stringify(data[key]));
        } else {
          qs.append(key, String(data[key]));
        }
      }
      finalUrl += `?${qs.toString()}`;
    }

    const response = await fetch(finalUrl, fetchOptions);
    const result = await response.json().catch(() => null);

    if (!response.ok) {
      const error = result?.error || result?.message || response.statusText;
      const code = result?.code || response.status;
      throw new ZenithError(code, error);
    }

    return result;
  }
}
