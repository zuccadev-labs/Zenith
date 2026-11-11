import { Container, Typography, Box, Paper, Alert } from '@mui/material';
import { Key } from 'lucide-react';

// API keys are managed with the master key, which the server accepts only from localhost
// (ADR-015). A browser app must never hold it, so this page shows how to manage keys instead of
// doing it: with the CLI, or with ZenithAPIKey in a server-side script.

const CLI = `# Reads ZENITH_SERVER_URL, ZENITH_APP_ID and ZENITH_MASTER_KEY (or the .env of the directory)
zen api-keys list
zen api-keys create --name "crm sync" --scopes "data:read" --expires 90d
zen api-keys create --name ops --scopes "*" --allowed-ips "10.0.0.0/24" --expires 30d
zen api-keys revoke <id>
zen api-keys rotate <id>`;

const SERVER = `// Node script on the server: Zenith.initialize(appId, { serverURL, masterKey })
import { ZenithAPIKey } from '@zuccadev-labs/zenith-client';

const key = await ZenithAPIKey.create({ name: 'crm sync', scopes: ['data:read'], expiresIn: '90d' });
console.log(key.value); // shown once: put it in your secret manager

for (const k of await ZenithAPIKey.list()) console.log(k.keyId, k.name, k.scopes);`;

const Code = ({ children }: { children: string }) => (
  <Paper variant="outlined" sx={{ p: 2, mb: 3, fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre', overflowX: 'auto' }}>
    {children}
  </Paper>
);

export default function APIKeysPage() {
  return (
    <Container maxWidth="md" sx={{ mt: 6, mb: 8 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
        <Key size={28} color="#6366f1" />
        <Typography sx={{ fontWeight: 800 }} variant="h4">API Keys</Typography>
      </Box>

      <Alert severity="info" sx={{ mb: 3 }}>
        API keys are for machine-to-machine integrations and are managed with the master key, which
        the server accepts only from localhost. A browser app cannot manage them, and must never
        contain the master key.
      </Alert>

      <Typography variant="h6" sx={{ mb: 1 }}>With the CLI</Typography>
      <Code>{CLI}</Code>

      <Typography variant="h6" sx={{ mb: 1 }}>From a server-side script</Typography>
      <Code>{SERVER}</Code>

      <Typography variant="body2" color="text.secondary">
        Scopes: <code>data:read</code>, <code>data:write</code>, <code>users:read</code>,{' '}
        <code>functions:invoke</code>, <code>files:read</code>… A key with scope <code>*</code> equals
        the master key, so it requires an IP allowlist and an expiry of at most 90 days. Keys are shown
        only once; the server stores an Argon2id hash.
      </Typography>
    </Container>
  );
}
