import React, { useState } from 'react';
import { Box, Button, Typography, Paper, Alert, CircularProgress } from '@mui/material';
import { useAccount, useConnect, useSignMessage } from 'wagmi';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import bs58 from 'bs58';
import { useZenithUser } from '@zuccadev-labs/zenith/react';
import { Zenith } from '@zuccadev-labs/zenith';

const NONCE_PREFIX = "Zenith Authentication Nonce: ";

export default function Web3Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setUser } = useZenithUser();

  // EVM (Wagmi) hooks
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { signMessageAsync } = useSignMessage();

  // Solana hooks
  const { publicKey, signMessage: signSolanaMessage } = useWallet();

  const handleEVMLogin = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const nonce = `${NONCE_PREFIX}${Date.now()}`;
      
      // 1. Sign message via Metamask
      const signature = await signMessageAsync({ message: nonce });
      
      // 2. Call Zenith Cloud Function
      const res = await Zenith.Cloud.run("web3Login", {
        address,
        signature,
        nonce
      });
      
      // 3. Hydrate session locally
      await Zenith.setSessionTokenAsync(res.sessionToken);
      
      // Update global context
      const { ZenithUser } = await import('@zuccadev-labs/zenith');
      const currentUser = await ZenithUser.currentAsync();
      setUser(currentUser);

    } catch (err: any) {
      setError(err.message || "Failed to authenticate via EVM.");
    } finally {
      setLoading(false);
    }
  };

  const handleSolanaLogin = async () => {
    try {
      setLoading(true);
      setError(null);
      
      if (!publicKey || !signSolanaMessage) {
        throw new Error("Solana wallet not fully connected.");
      }

      const nonce = `${NONCE_PREFIX}${Date.now()}`;
      const message = new TextEncoder().encode(nonce);

      // 1. Sign message via Phantom
      const signatureBytes = await signSolanaMessage(message);
      const signature = bs58.encode(signatureBytes);

      // 2. Call Zenith Cloud Function
      const res = await Zenith.Cloud.run("web3LoginSolana", {
        publicKey: publicKey.toString(),
        signature,
        nonce
      });

      // 3. Hydrate session locally
      await Zenith.setSessionTokenAsync(res.sessionToken);
      
      const { ZenithUser } = await import('@zuccadev-labs/zenith');
      const currentUser = await ZenithUser.currentAsync();
      setUser(currentUser);

    } catch (err: any) {
      setError(err.message || "Failed to authenticate via Solana.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <Typography variant="h4" sx={{ fontWeight: '800' }}>Web3 Cloud Login</Typography>
      <Typography color="text.secondary">
        Verificación de Firmas EIP-191 & Ed25519 directamente en Cloud Code.
      </Typography>

      {error && <Alert severity="error" sx={{ width: '100%', maxWidth: 400 }}>{error}</Alert>}

      <Paper sx={{ p: 4, width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 3, borderRadius: 3, background: 'rgba(30, 41, 59, 0.7)' }}>
        
        {/* EVM Section */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: '600' }}>EVM (Ethereum / Polygon)</Typography>
          {!isConnected ? (
            connectors.map((connector) => (
              <Button 
                key={connector.uid} 
                variant="outlined" 
                onClick={() => connect({ connector })}
              >
                Connect {connector.name}
              </Button>
            ))
          ) : (
            <Button 
              variant="contained" 
              color="primary"
              onClick={handleEVMLogin}
              disabled={loading}
              startIcon={loading && <CircularProgress size={16} color="inherit" />}
            >
              Firmar e Iniciar Sesión (EVM)
            </Button>
          )}
        </Box>

        {/* Divider */}
        <Box sx={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }} />

        {/* Solana Section */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: '600' }}>Solana</Typography>
          
          <WalletMultiButton style={{ width: '100%', justifyContent: 'center', borderRadius: 8, background: '#512da8' }} />
          
          {publicKey && (
            <Button 
              variant="contained" 
              sx={{ background: '#14F195', color: '#000', '&:hover': { background: '#0fe087' } }}
              onClick={handleSolanaLogin}
              disabled={loading}
              startIcon={loading && <CircularProgress size={16} color="inherit" />}
            >
              Firmar e Iniciar Sesión (Solana)
            </Button>
          )}
        </Box>

      </Paper>
    </Box>
  );
}
