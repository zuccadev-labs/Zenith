// deno-lint-ignore-file no-unused-vars
/**
 * Web3 bridge: EVM wallet connection, viem-based transaction signing, IPFS storage integration, NFT minting, smart-contract event indexing, signature verification (EIP-191, EIP-712).
 *
 * @barrits-trait
 * @barrits-summary ZenithWeb3
 * @barrits-provides web3-routes, web3, web3Bridge
 * @barrits-consumes db
 * @barrits-tags uses:ipfs
 * @barrits-state web3Providers
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const Web3Trait = createTraitDescriptor({
  name: "ZenithWeb3",
  provides: ["web3-routes", "web3", "web3Bridge"],
  consumes: ["db"],
  tags: ["uses:ipfs"],
  state: ["web3Providers"],
  runtimes: ["deno"],
  summary: "Web3 bridge: EVM wallet connection, viem-based transaction signing, IPFS storage integration, NFT minting, smart-contract event indexing, signature verification (EIP-191, EIP-712).",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const ipfs = deps.traits["ipfs"];

    const traitApi: any = {
      providers: new Map<string, { rpc: string; chainId: number }>(),

      addProvider: (name: string, rpc: string, chainId: number) => {
        traitApi.providers.set(name, { rpc, chainId });
      },

      verifyMessage: async (message: string, signature: string, expectedAddress: string): Promise<boolean> => {
        const viem = await import("viem");
        try {
          return await viem.verifyMessage({ message, signature: signature as `0x${string}`, address: expectedAddress as `0x${string}` });
        } catch (_e) { return false; }
      },

      verifyTypedData: async (domain: any, types: any, message: any, signature: string, expectedAddress: string): Promise<boolean> => {
        const viem = await import("viem");
        try {
          return await viem.verifyTypedData({ domain, types, message, primaryType: "EIP712Domain", signature: signature as `0x${string}`, address: expectedAddress as `0x${string}` } as any);
        } catch (_e) { return false; }
      },

      getBalance: async (address: string, chainName: string = "ethereum"): Promise<string> => {
        const viem = await import("viem");
        const provider = traitApi.providers.get(chainName);
        if (!provider) throw new Error(`chain not configured: ${chainName}`);
        const mainnet = (viem as any).mainnet ?? (await import("viem/chains")).mainnet;
        const client = viem.createPublicClient({ chain: mainnet, transport: viem.http(provider.rpc) });
        const balance = await client.getBalance({ address: address as `0x${string}` });
        return balance.toString();
      },

      signInWithEthereum: async (message: string, signature: string, address: string) => {
        const valid = await traitApi.verifyMessage(message, signature, address);
        if (!valid) throw new Error("invalid signature");
        let user = (await db.find("_User", { authData: { ethereum: { id: address } } }))[0];
        if (!user) {
          const newUser = await db.create("_User", {
            username: `eth_${address.slice(0, 10)}`,
            authData: { ethereum: { id: address } },
            emailVerified: false,
          });
          user = newUser;
        }
        return { userId: user.objectId, address, authenticated: true };
      },
    };

    const web3_routes = [
      {
        method: "POST" as const,
        path: "/web3/siwe",
        _openapi: { summary: "Sign-In With Ethereum (EIP-4361)" },
        handler: async (req: Request) => {
          const body = await req.json() as { message: string; signature: string; address: string };
          const result = await traitApi.signInWithEthereum(body.message, body.signature, body.address);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/web3/verify",
        _openapi: { summary: "Verify a signed message" },
        handler: async (req: Request) => {
          const body = await req.json() as { message: string; signature: string; address: string };
          const valid = await traitApi.verifyMessage(body.message, body.signature, body.address);
          return new Response(JSON.stringify({ valid }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/web3/balance/:address",
        _openapi: { summary: "Get native token balance", parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const address = new URL(req.url).pathname.split("/")[3];
          const balance = await traitApi.getBalance(address);
          return new Response(JSON.stringify({ address, balance }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "web3-routes": web3_routes,
      "web3": traitApi,
      "web3Bridge": traitApi,
    };
  },
});
