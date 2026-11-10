import React, { useState, useEffect } from 'react';
import {
  Container, Typography, Box, Button, Paper, Alert, Chip, IconButton,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  FormControlLabel, Checkbox, Tooltip, CircularProgress
} from '@mui/material';
import { Key, Plus, Trash2, Copy, CheckCheck, AlertTriangle } from 'lucide-react';
import { useZenithUser } from '@zuccadev-labs/zenith/react';
import { ZenithAPIKey } from '@zuccadev-labs/zenith';

// ─── Scope selector ───────────────────────────────────────────────────────────

const AVAILABLE_SCOPES = [
  { value: "*",          label: "Full Access (Admin)",   desc: "All read/write permissions" },
  { value: "read:*",     label: "Read All",              desc: "Read any class" },
  { value: "write:*",    label: "Write All",             desc: "Create/update any class" },
  { value: "functions",  label: "Cloud Functions",       desc: "Call cloud functions" },
  { value: "files",      label: "File Storage",          desc: "Upload/download files" },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function APIKeysPage() {
  const { user } = useZenithUser();
  const [keys, setKeys] = useState<ZenithAPIKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: number; message: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["read:*"]);
  const [creating, setCreating] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await ZenithAPIKey.list();
      setKeys(list);
    } catch (err: any) {
      setError({ code: err.code, message: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const key = await ZenithAPIKey.create(newKeyName.trim(), selectedScopes);
      setNewKeyValue(key.value!);
      setKeys(prev => [key, ...prev]);
      setNewKeyName("");
      setSelectedScopes(["read:*"]);
    } catch (err: any) {
      setError({ code: err.code, message: err.message });
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: ZenithAPIKey) => {
    setRevoking(key.keyId);
    try {
      await key.revoke();
      setKeys(prev => prev.filter(k => k.keyId !== key.keyId));
    } catch (err: any) {
      setError({ code: err.code, message: err.message });
    } finally {
      setRevoking(null);
    }
  };

  const handleCopy = () => {
    if (newKeyValue) {
      navigator.clipboard.writeText(newKeyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes(prev =>
      prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]
    );
  };

  return (
    <Container maxWidth="lg" sx={{ mt: 6, mb: 8 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Key size={28} color="#6366f1" />
          <Typography sx={{ fontWeight: 800 }} variant="h4">API Keys</Typography>
        </Box>
        <Button
          id="create-apikey-btn"
          variant="contained"
          startIcon={<Plus size={18} />}
          onClick={() => setCreateOpen(true)}
          sx={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', borderRadius: 2, fontWeight: 700 }}
        >
          Create API Key
        </Button>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        API keys allow machine-to-machine (M2M) integrations. Use scopes to restrict access. 
        <strong> Keys are shown only once.</strong>
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 3, fontFamily: 'monospace' }}>
          {error.code !== undefined && <Chip label={`Error ${error.code}`} size="small" color="error" sx={{ mr: 1 }} />}
          {error.message}
        </Alert>
      )}

      {/* New key reveal */}
      {newKeyValue && (
        <Alert
          severity="warning"
          icon={<AlertTriangle />}
          sx={{ mb: 3, '& .MuiAlert-message': { width: '100%' } }}
          onClose={() => setNewKeyValue(null)}
        >
          <Typography sx={{ fontWeight: 700 }} gutterBottom>⚠️ Copy your key now — it won't be shown again.</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, background: '#1e293b', borderRadius: 1, p: 1 }}>
            <Typography sx={{ fontFamily: "monospace", fontSize: "0.8rem", flexGrow: 1, wordBreak: 'break-all' }}>
              {newKeyValue}
            </Typography>
            <Tooltip title={copied ? "Copied!" : "Copy to clipboard"}>
              <IconButton size="small" onClick={handleCopy}>
                {copied ? <CheckCheck size={16} color="#4ade80" /> : <Copy size={16} />}
              </IconButton>
            </Tooltip>
          </Box>
        </Alert>
      )}

      {/* Keys table */}
      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell><strong>Name</strong></TableCell>
              <TableCell><strong>Scopes</strong></TableCell>
              <TableCell><strong>Created</strong></TableCell>
              <TableCell><strong>Last Used</strong></TableCell>
              <TableCell align="right"><strong>Actions</strong></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} align="center">
                  <CircularProgress size={24} sx={{ m: 2 }} />
                </TableCell>
              </TableRow>
            ) : keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">No API keys yet. Create your first key above.</Typography>
                </TableCell>
              </TableRow>
            ) : keys.map(key => (
              <TableRow key={key.keyId} hover>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Key size={14} color="#6366f1" />
                    <Typography sx={{ fontWeight: 600 }}>{key.name}</Typography>
                  </Box>
                  <Typography sx={{ fontFamily: "monospace" }} variant="caption" color="text.secondary">
                    {key.keyId.substring(0, 16)}...
                  </Typography>
                </TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {key.scopes.map(s => (
                      <Chip key={s} label={s} size="small" variant="outlined" color={s === "*" ? "warning" : "primary"} />
                    ))}
                  </Box>
                </TableCell>
                <TableCell>
                  <Typography variant="body2">{new Date(key.createdAt).toLocaleDateString()}</Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" color={key.lastUsedAt ? "text.primary" : "text.secondary"}>
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "Never"}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title="Revoke key permanently">
                    <IconButton
                      id={`revoke-key-${key.keyId}`}
                      color="error"
                      size="small"
                      disabled={revoking === key.keyId}
                      onClick={() => handleRevoke(key)}
                    >
                      {revoking === key.keyId ? <CircularProgress size={16} /> : <Trash2 size={16} />}
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>Create New API Key</DialogTitle>
        <DialogContent>
          <TextField
            id="new-key-name"
            label="Key Name"
            fullWidth
            value={newKeyName}
            onChange={e => setNewKeyName(e.target.value)}
            helperText="A human-readable name to identify this key (e.g. 'Mobile App v2')"
            sx={{ mt: 1 }}
          />
          <Typography variant="subtitle2" sx={{ mt: 3, mb: 1, fontWeight: 700 }}>Permissions</Typography>
          {AVAILABLE_SCOPES.map(scope => (
            <FormControlLabel
              key={scope.value}
              control={
                <Checkbox
                  checked={selectedScopes.includes(scope.value)}
                  onChange={() => toggleScope(scope.value)}
                  size="small"
                />
              }
              label={
                <Box>
                  <Typography sx={{ fontWeight: 600 }} variant="body2">{scope.label}</Typography>
                  <Typography variant="caption" color="text.secondary">{scope.desc}</Typography>
                </Box>
              }
              sx={{ display: 'flex', mb: 0.5 }}
            />
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            id="confirm-create-key-btn"
            variant="contained"
            disabled={!newKeyName.trim() || creating || selectedScopes.length === 0}
            onClick={async () => { await handleCreate(); setCreateOpen(false); }}
            sx={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
          >
            {creating ? <CircularProgress size={18} color="inherit" /> : "Create Key"}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
