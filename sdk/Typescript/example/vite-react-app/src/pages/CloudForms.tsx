import React, { useState, useEffect } from 'react';
import { Box, Button, Typography, Paper, TextField, Alert, CircularProgress, Divider, Chip, List, ListItem, ListItemText, IconButton } from '@mui/material';
import { useZenithUser } from '@zuccadev-labs/zenith-client/react';
import { Send, CloudCog, Trash2, Edit2, X } from 'lucide-react';
import { FrontendEngine } from '../domain/engine';
import { ZenithObject } from '@zuccadev-labs/zenith-client';

export default function CloudForms() {
  const { user } = useZenithUser();
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  
  const [forms, setForms] = useState<any[]>([]);
  
  // Form State
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      loadForms();
    }
  }, [user]);

  const loadForms = async () => {
    try {
      setLoadingList(true);
      const data = await FrontendEngine.getForms();
      setForms(data);
    } catch (err: any) {
      setError("Error loading forms: " + err.message);
    } finally {
      setLoadingList(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setTitle('');
    setDescription('');
  };

  const handleEdit = (form: any) => {
    setEditingId(form._id || form.objectId);
    setTitle(form.title);
    setDescription(form.description);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure?")) return;
    try {
      setLoadingList(true);
      await FrontendEngine.deleteForm(id);
      await loadForms();
      setResult({ mode: 'Cloud Function', msg: `Deleted ${id}` });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingList(false);
    }
  };

  const handleSubmitREST = async () => {
    try {
      setLoading(true);
      setError(null);
      setResult(null);

      // REST Create
      const entry = new ZenithObject("FormEntry");
      entry.set("title", title);
      entry.set("description", description);
      const saved = await entry.save();
      setResult({ mode: 'REST POST', msg: `Created ID: ${saved.objectId}` });
      handleCancelEdit();
      loadForms();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitCloud = async () => {
    try {
      setLoading(true);
      setError(null);
      setResult(null);

      // Cloud Logic via Barrits
      if (editingId) {
        await FrontendEngine.updateForm(editingId, title, description);
        setResult({ mode: 'Barrits Engine -> Cloud Update', msg: `Updated ${editingId}` });
      } else {
        const objectId = await FrontendEngine.createForm(title, description);
        setResult({ mode: 'Barrits Engine -> Cloud Create', msg: `Created ${objectId}` });
      }
      handleCancelEdit();
      loadForms();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
        <Alert severity="warning">Por favor, inicia sesión (Auth o Web3) para usar Cloud Forms.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <Typography variant="h4" sx={{ fontWeight: '800' }}>Dumb Client vs Smart Cloud (CRUD)</Typography>
      <Typography color="text.secondary" sx={{ textAlign: 'center', maxWidth: 600 }}>
        Demostración de inserción directa (REST CRUD) vs ciclo CRUD completo delegando lógica empresarial a Cloud Functions.
      </Typography>

      <Paper sx={{ p: 4, width: '100%', maxWidth: 500, display: 'flex', flexDirection: 'column', gap: 3, borderRadius: 3, background: 'rgba(30, 41, 59, 0.7)' }}>
        <Typography variant="h6">{editingId ? 'Edit Form' : 'New Form'}</Typography>
        
        <TextField 
          label="Título (Mínimo 3 caracteres)" 
          variant="outlined" 
          fullWidth
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        
        <TextField 
          label="Descripción" 
          variant="outlined" 
          fullWidth
          multiline
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {error && <Alert severity="error">{error}</Alert>}
        {result && (
          <Alert severity="success" icon={false}>
            <Chip size="small" label={result.mode} color="primary" sx={{ mr: 1 }} />
            {result.msg}
          </Alert>
        )}

        <Box sx={{ display: 'flex', gap: 2 }}>
          {editingId ? (
            <>
              <Button 
                variant="outlined" color="error" fullWidth onClick={handleCancelEdit} startIcon={<X size={18} />}>
                Cancel
              </Button>
              <Button 
                variant="contained" color="primary" fullWidth onClick={handleSubmitCloud} disabled={loading} startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <CloudCog size={18} />} sx={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
                Cloud Update
              </Button>
            </>
          ) : (
            <>
              <Button 
                variant="outlined" color="secondary" fullWidth onClick={handleSubmitREST} disabled={loading} startIcon={<Send size={18} />}>
                Direct REST
              </Button>
              <Button 
                variant="contained" color="primary" fullWidth onClick={handleSubmitCloud} disabled={loading} startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <CloudCog size={18} />} sx={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
                Cloud Create
              </Button>
            </>
          )}
        </Box>
      </Paper>

      {/* List of My Forms */}
      <Paper sx={{ p: 4, width: '100%', maxWidth: 500, borderRadius: 3, background: 'rgba(30, 41, 59, 0.7)' }}>
        <Typography variant="h6" sx={{ mb: 2 }}>My Entries (Cloud Read)</Typography>
        {loadingList ? <CircularProgress /> : forms.length === 0 ? (
          <Typography color="text.secondary">No entries found.</Typography>
        ) : (
          <List>
            {forms.map(f => (
              <ListItem 
                key={f._id || f.objectId} 
                secondaryAction={
                  <Box>
                    <IconButton edge="end" onClick={() => handleEdit(f)} color="info"><Edit2 size={16} /></IconButton>
                    <IconButton edge="end" onClick={() => handleDelete(f._id || f.objectId)} color="error"><Trash2 size={16} /></IconButton>
                  </Box>
                }
              >
                <ListItemText primary={f.title} secondary={f.description} />
              </ListItem>
            ))}
          </List>
        )}
      </Paper>
    </Box>
  );
}
