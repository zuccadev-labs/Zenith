import type { ZenithConfig, ZenithContext } from "../types/ZenithConfig.js";
import { ZenithStorage } from "./StorageController.js";
import { ZenithCloud } from "../objects/ZenithCloud.js";
import { ZenithFile } from "../objects/ZenithFile.js";

/**
 * @class ZenithAIWrapper
 * Wrapper for enterprise AI orchestration in the Zenith backend.
 */
class ZenithAIWrapper {
  /**
   * Dispatches a prompt to an AI agent configured in the Zenith Cloud.
   * @param agentId The identifier of the AI agent model to use.
   * @param input The text prompt to process.
   */
  public async prompt(agentId: string, input: string): Promise<string> {
    const res = await ZenithCloud.run("ai_prompt", { agentId, input });
    return res.response || res;
  }
}

/**
 * @class ZenithWeb3Wrapper
 * Wrapper for native Web3 interactions securely brokered by Zenith Cloud.
 */
class ZenithWeb3Wrapper {
  /**
   * Executes a smart contract read/write via the backend to avoid exposing client RPCs.
   * @param contract The contract address.
   * @param method The ABI method to invoke.
   * @param args The arguments for the method.
   */
  public async call(contract: string, method: string, args: any[]): Promise<any> {
    return await ZenithCloud.run("web3_call", { contract, method, args });
  }
}

const ZenithAI = new ZenithAIWrapper();
const ZenithWeb3 = new ZenithWeb3Wrapper();

class ZenithCore {
  private config: ZenithConfig | null = null;
  private ctx: ZenithContext = {};

  // Namespaces (DX Parity)
  public Cloud = ZenithCloud;
  public File = ZenithFile;
  public AI = ZenithAI;
  public Web3 = ZenithWeb3;

  /**
   * EN: Initializes the Zenith SDK. Must be called before using any features.
   * ES: Inicializa el SDK de Zenith. Debe llamarse antes de usar cualquier característica.
   * 
   * @param config The server configuration
   */
  public initialize(config: ZenithConfig) {
    // Strip trailing slash from server URL
    if (config.serverURL.endsWith('/')) {
      config.serverURL = config.serverURL.slice(0, -1);
    }
    this.config = config;
    
    // We synchronously read from WebStorage if available to prevent flashes,
    // but the proper way is ZenithUser.currentAsync()
    if (typeof window !== "undefined" && window.localStorage) {
      const storedToken = window.localStorage.getItem(`Zenith/${config.appId}/sessionToken`);
      if (storedToken) {
        this.ctx.sessionToken = storedToken;
      }
    } else {
      // Async hydration for non-web platforms triggered in background
      ZenithStorage.getItem(`Zenith/${config.appId}/sessionToken`).then(token => {
        if (token) this.ctx.sessionToken = token;
      }).catch(() => {});
    }
  }

  public getConfig(): ZenithConfig {
    if (!this.config) {
      throw new Error("Zenith SDK is not initialized. Call Zenith.initialize() first.");
    }
    return this.config;
  }

  public getContext(): ZenithContext {
    return this.ctx;
  }

  public async setSessionTokenAsync(token: string | undefined): Promise<void> {
    this.ctx.sessionToken = token;
    if (this.config) {
      if (token) {
        await ZenithStorage.setItem(`Zenith/${this.config.appId}/sessionToken`, token);
      } else {
        await ZenithStorage.removeItem(`Zenith/${this.config.appId}/sessionToken`);
      }
    }
  }

  public setSessionToken(token: string | undefined) {
    // Legacy synchronous method, delegates to async in background
    this.setSessionTokenAsync(token).catch(err => console.error("[Zenith] Error setting session token:", err));
  }

  public get sessionToken(): string | undefined {
    return this.ctx.sessionToken;
  }
}

export const Zenith = new ZenithCore();
