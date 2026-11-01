import { Zen } from "@zuccadev-labs/zenith";
import { verifyMessage } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";

// ─── Web3 Authentication (EVM / Metamask) ──────────────────────────────────

Zen.Cloud.define("web3Login", async (request) => {
  const { address, signature, nonce } = request.params as {
    address: string;
    signature: string;
    nonce: string; // The plaintext message that was signed
  };

  if (!address || !signature || !nonce) {
    throw new Error("Missing Web3 credentials (address, signature, nonce).");
  }

  // 1. Verify EIP-191 Signature
  const isValid = await verifyMessage({
    address: address as `0x${string}`,
    message: nonce,
    signature: signature as `0x${string}`,
  });

  if (!isValid) {
    throw new Error("Invalid EVM Signature.");
  }

  // 2. Find or Create User
  const db = Zen.DB.getAdapter();
  let user = await db.findOne("_User", { where: { ethAddress: address.toLowerCase() } });

  if (!user) {
    // Generate a random username or use address
    user = await db.insert("_User", {
      username: `eth_${address.slice(0, 8)}`,
      ethAddress: address.toLowerCase(),
      authData: { web3: { address } },
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }

  // 3. Issue Session Token
  const sessionToken = crypto.randomUUID();
  await db.insert("_Session", {
    sessionToken,
    user: { __type: "Pointer", className: "_User", objectId: user._id || user.objectId },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) // 30 days
  });

  return {
    user: { ...user, objectId: user._id || user.objectId },
    sessionToken
  };
});

// ─── Web3 Authentication (Solana / Phantom) ────────────────────────────────

Zen.Cloud.define("web3LoginSolana", async (request) => {
  const { publicKey, signature, nonce } = request.params as {
    publicKey: string;
    signature: string;
    nonce: string;
  };

  if (!publicKey || !signature || !nonce) {
    throw new Error("Missing Solana credentials.");
  }

  // 1. Verify Ed25519 Signature
  const messageBytes = new TextEncoder().encode(nonce);
  const signatureBytes = bs58.decode(signature);
  const publicKeyBytes = bs58.decode(publicKey);

  const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);

  if (!isValid) {
    throw new Error("Invalid Solana Signature.");
  }

  // 2. Find or Create User
  const db = Zen.DB.getAdapter();
  let user = await db.findOne("_User", { where: { solAddress: publicKey } });

  if (!user) {
    user = await db.insert("_User", {
      username: `sol_${publicKey.slice(0, 8)}`,
      solAddress: publicKey,
      authData: { solana: { publicKey } },
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }

  // 3. Issue Session Token
  const sessionToken = crypto.randomUUID();
  await db.insert("_Session", {
    sessionToken,
    user: { __type: "Pointer", className: "_User", objectId: user._id || user.objectId },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
  });

  return {
    user: { ...user, objectId: user._id || user.objectId },
    sessionToken
  };
});
