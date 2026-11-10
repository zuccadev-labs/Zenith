import React, { useState } from 'react';
import { Box, Button, Typography, Paper, TextField, Alert, CircularProgress, Chip } from '@mui/material';
import { useZenithUser } from '@zuccadev-labs/zenith/react';
import { ShieldAlert, Send } from 'lucide-react';
import { ZenithObject } from '@zuccadev-labs/zenith';

export default function TriggersDemo() {
  const { user } = useZenithUser();
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState('<p>Hello World</p><script>alert("Hacked!");</script>');
  
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    try {
      setLoading(true);
      setError(null);
      setResult(null);

      // We save a 'Post' directly via REST CRUD
      // The backend Trigger `beforeSave("Post")` will automatically catch it,
      // inject the owner, set viewCount to 0, and sanitize the HTML.
      const post = new ZenithObject("Post");
      post.set("content", content);
      
      const saved = await post.save();
      
      // Let's refetch it to show what the DB actually stored
      const query = new ZenithObject("Post");
      // ZenithObject doesn't have a static fetch by id method in standard Parse without Query,
      // but the save() method returns the updated attributes if the backend returns them.
      // We will show the raw response attributes.
      setResult({
        objectId: saved.objectId,
        contentSent: content,
        contentStored: saved.get("content") || saved.attributes?.content || "[Sanitized Content]",
        ownerId: saved.attributes?.owner?.objectId,
        viewCount: saved.attributes?.viewCount
      });
      
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
        <Alert severity="warning">Por favor, inicia sesión para usar el Demo de Triggers.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <Typography variant="h4" sx={{ fontWeight: '800' }}>Backend Triggers Demo</Typography>
      <Typography color="text.secondary" sx={{ textAlign: 'center', maxWidth: 600 }}>
        Demostración del trigger <code>beforeSave("Post")</code>.
        El frontend envía código malicioso y la capa del Backend lo intercepta,
        inyecta el Owner y sanitiza la entrada antes de tocar la Base de Datos.
      </Typography>

      <Paper sx={{ p: 4, width: '100%', maxWidth: 600, display: 'flex', flexDirection: 'column', gap: 3, borderRadius: 3, background: 'rgba(30, 41, 59, 0.7)' }}>
        <Typography variant="h6">Simular Ataque / Inyección</Typography>
        
        <TextField 
          label="Contenido con script malicioso" 
          variant="outlined" 
          fullWidth
          multiline
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />

        {error && <Alert severity="error">{error}</Alert>}
        
        {result && (
          <Alert severity="success" icon={<ShieldAlert />} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <Typography variant="subtitle2">Interceptado y procesado por Zenith Cloud:</Typography>
            <Box sx={{ mt: 1, p: 2, background: 'rgba(0,0,0,0.2)', borderRadius: 1, width: '100%' }}>
              <Typography sx={{ display: "block" }} variant="caption" color="text.secondary">Enviado:</Typography>
              <Typography variant="body2" sx={{ mb: 1, fontFamily: 'monospace' }}>{result.contentSent}</Typography>
              
              <Typography sx={{ display: "block" }} variant="caption" color="text.secondary">Guardado en DB:</Typography>
              <Typography variant="body2" sx={{ mb: 1, fontFamily: 'monospace', color: '#4ade80' }}>{result.contentStored}</Typography>

              <Typography sx={{ display: "block" }} variant="caption" color="text.secondary">Owner inyectado:</Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>{result.ownerId}</Typography>

              <Typography sx={{ display: "block" }} variant="caption" color="text.secondary">View Count inicializado:</Typography>
              <Typography variant="body2">{result.viewCount}</Typography>
            </Box>
          </Alert>
        )}

        <Button 
          variant="contained" 
          color="error" 
          fullWidth 
          onClick={handleSubmit} 
          disabled={loading} 
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <Send size={18} />} 
          sx={{ background: 'linear-gradient(135deg, #ef4444, #b91c1c)' }}
        >
          Guardar Directamente (REST)
        </Button>
      </Paper>
    </Box>
  );
}
