import React, { useEffect, useState } from 'react';
import {
  Container, Typography, Grid, Card, CardContent, CardActionArea, Box, Avatar,
  Chip, Alert, Button, Divider, LinearProgress, Paper, Tooltip
} from '@mui/material';
import {
  MessageSquare, CloudLightning, Database, Shield, Video, Key, Link2,
  AlertCircle, CheckCircle, Globe, Zap
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useZenithUser } from '@zuccadev-labs/zenith-client/react';

// ─── SDK Health Check ─────────────────────────────────────────────────────────

interface HealthItem {
  label: string;
  status: 'ok' | 'error' | 'loading';
  detail?: string;
}

async function runSDKHealthCheck(): Promise<HealthItem[]> {
  const results: HealthItem[] = [];

  // 1. Ping backend
  try {
    const { Zenith } = await import('@zuccadev-labs/zenith-client');
    const cfg = Zenith.getConfig();
    const res = await fetch(`${cfg.serverURL}/health`, {
      headers: { 'Zen-Application-Id': cfg.appId }
    });
    results.push({
      label: 'Backend Health',
      status: res.ok ? 'ok' : 'error',
      detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status}`
    });
  } catch (e: any) {
    results.push({ label: 'Backend Health', status: 'error', detail: e.message });
  }

  // 2. Object CRUD + Pointers
  try {
    const { ZenithObject } = await import('@zuccadev-labs/zenith-client');
    const obj = new ZenithObject('_HealthCheck');
    obj.set('ping', 'pong');
    obj.set('timestamp', new Date().toISOString());
    await obj.save();
    // Create pointer reference
    const ptr = ZenithObject.pointer('_HealthCheck', obj.objectId!);
    if (!ptr.__type || ptr.__type !== 'Pointer') throw new Error('Pointer creation failed');
    await obj.destroy();
    results.push({ label: 'CRUD + Pointers', status: 'ok', detail: `objectId: ${ptr.objectId.substring(0, 8)}...` });
  } catch (e: any) {
    results.push({ label: 'CRUD + Pointers', status: 'error', detail: e.message });
  }

  // 3. ZenithQuery operators
  try {
    const { ZenithQuery } = await import('@zuccadev-labs/zenith-client');
    const q = new ZenithQuery('_HealthCheck')
      .greaterThan('score', 0)
      .limit(1);
    await q.find();
    results.push({ label: 'Query Engine', status: 'ok', detail: 'find + greaterThan + limit ✓' });
  } catch (e: any) {
    results.push({ label: 'Query Engine', status: 'error', detail: e.message });
  }

  // 4. LiveQuery connection test
  try {
    const { LiveQueryClient, ZenithQuery } = await import('@zuccadev-labs/zenith-client');
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Timeout')), 3000);
      const query = new ZenithQuery('_HealthCheck');
      const sub = LiveQueryClient.subscribe(query);
      sub.on('error', (code: number, msg: string) => {
        clearTimeout(to);
        reject(new Error(`[${code}] ${msg}`));
      });
      sub.on('open', () => {
        clearTimeout(to);
        LiveQueryClient.unsubscribe(sub);
        resolve();
      });
    });
    results.push({ label: 'LiveQuery WebSocket', status: 'ok', detail: 'Connected ✓' });
  } catch (e: any) {
    results.push({ label: 'LiveQuery WebSocket', status: 'error', detail: e.message });
  }

  return results;
}

// ─── Feature Cards ────────────────────────────────────────────────────────────

const features = [
  {
    title: "Realtime LiveQuery",
    description: "Build reactive UIs with WebSocket-powered data sync and typed events.",
    icon: <MessageSquare size={28} color="#fff" />,
    gradient: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    path: "/chat",
    badge: "Live"
  },
  {
    title: "Identity & Auth",
    description: "Session-based auth with ACL/CLP, OAuth adapters, and password complexity enforcement.",
    icon: <Shield size={28} color="#fff" />,
    gradient: "linear-gradient(135deg, #16a34a, #15803d)",
    path: "/auth",
  },
  {
    title: "API Keys (M2M)",
    description: "Create scoped API keys for machine-to-machine integrations with one-time reveal.",
    icon: <Key size={28} color="#fff" />,
    gradient: "linear-gradient(135deg, #6366f1, #4f46e5)",
    path: "/apikeys",
    badge: "New"
  },
  {
    title: "E2EE Audio Call",
    description: "Zero-knowledge strict_sframe mode. Zenith routes encrypted packets without decrypting.",
    icon: <Shield size={28} color="#fff" />,
    gradient: "linear-gradient(135deg, #10b981, #059669)",
    path: "/media/secure",
  },
  {
    title: "Global Video Chat",
    description: "Hop-by-hop Media Signaling. Scalable SFU mode for video meetings.",
    icon: <Video size={28} color="#fff" />,
    gradient: "linear-gradient(135deg, #f43f5e, #e11d48)",
    path: "/media/video",
  },
  {
    title: "Cloud Functions",
    description: "Typed triggers (beforeSave, afterSave) and background jobs with auto OpenAPI doc.",
    icon: <CloudLightning size={28} color="#fff" />,
    gradient: "linear-gradient(135deg, #d97706, #b45309)",
    path: undefined,
    badge: "Swagger ✓"
  },
  {
    title: "REST CRUD + Pointers",
    description: "Full Parse-compatible API with pointer resolution, ACL, and LiveQuery broadcast.",
    icon: <Database size={28} color="#fff" />,
    gradient: "linear-gradient(135deg, #9333ea, #7e22ce)",
    path: undefined,
  },
];

// ─── Pointer Demo ─────────────────────────────────────────────────────────────

async function runPointerDemo(): Promise<string[]> {
  const { ZenithObject, ZenithQuery } = await import('@zuccadev-labs/zenith-client');
  const logs: string[] = [];

  // Create an Author object
  const author = new ZenithObject('Author');
  author.set('name', 'Alice Zenith');
  author.set('country', 'US');
  await author.save();
  logs.push(`✅ Author created: objectId=${author.objectId}`);

  // Create a Post that points to the Author
  const post = new ZenithObject('Post');
  post.set('title', 'Hello Zenith World!');
  post.set('author', author.toPointer());  // { __type: "Pointer", className: "Author", objectId: "..." }
  await post.save();
  logs.push(`✅ Post with pointer to Author: objectId=${post.objectId}`);

  // Query posts and resolve the pointer
  const q = new ZenithQuery('Post')
    .equalTo('objectId', post.objectId)
    .include('author');
  const results = await q.find();
  const resolved = results[0]?.get('author');
  logs.push(`✅ Pointer resolved: author.name = "${resolved?.name || 'N/A'}"`);

  // Cleanup
  await post.destroy();
  await author.destroy();
  logs.push('🧹 Demo objects cleaned up.');
  return logs;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useZenithUser();
  const [health, setHealth] = useState<HealthItem[] | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [pointerLogs, setPointerLogs] = useState<string[]>([]);
  const [pointerRunning, setPointerRunning] = useState(false);
  const [pointerError, setPointerError] = useState<string | null>(null);

  const handleRunHealth = async () => {
    setHealthLoading(true);
    const results = await runSDKHealthCheck();
    setHealth(results);
    setHealthLoading(false);
  };

  const handlePointerDemo = async () => {
    setPointerRunning(true);
    setPointerError(null);
    setPointerLogs([]);
    try {
      const logs = await runPointerDemo();
      setPointerLogs(logs);
    } catch (e: any) {
      setPointerError(`Error ${e.code ?? ''}: ${e.message}`);
    } finally {
      setPointerRunning(false);
    }
  };

  return (
    // Scrollable content area — fills the flex:1 shell, scrolls internally
    <Box sx={{ height: '100%', overflowY: 'auto' }}>
    <Container maxWidth="lg" sx={{ mt: 6, mb: 10 }}>
      {/* Header */}
      <Box sx={{ textAlign: 'center', mb: 6 }}>
        <Typography 
          variant="h3" 
          sx={{ 
            fontWeight: 800,
            background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            mb: 2
          }}
        >  ⚡ Zenith Platform
        </Typography>
        <Typography variant="h6" color="text.secondary" sx={{ maxWidth: 600, mx: 'auto' }}>
          Enterprise-grade BaaS — Parse Server compatible, real-time, secure, observable.
        </Typography>
        {user && (
          <Chip
            icon={<CheckCircle size={14} />}
            label={`Authenticated as ${user.get('username')}`}
            color="success"
            size="small"
            sx={{ mt: 2, fontWeight: 600 }}
          />
        )}
      </Box>

      {/* Feature Grid */}
      <Grid container spacing={3} sx={{ mb: 6 }}>
        {features.map((feat, idx) => (
          <Grid size={{ xs: 12, sm: 6, md: 4 }} key={idx}>
            <Card
              elevation={0}
              sx={{
                height: '100%',
                borderRadius: 3,
                border: '1px solid rgba(255,255,255,0.06)',
                background: '#0f172a',
                transition: 'all 0.25s ease',
                cursor: feat.path ? 'pointer' : 'default',
                '&:hover': feat.path ? {
                  transform: 'translateY(-4px)',
                  boxShadow: '0 12px 40px rgba(99,102,241,0.2)',
                  borderColor: 'rgba(99,102,241,0.4)',
                } : {},
              }}
              onClick={() => feat.path && navigate(feat.path)}
            >
              <CardContent sx={{ p: 3 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                  <Avatar sx={{ background: feat.gradient, width: 52, height: 52, borderRadius: 2 }}>
                    {feat.icon}
                  </Avatar>
                  {feat.badge && (
                    <Chip label={feat.badge} size="small" sx={{
                      background: 'rgba(99,102,241,0.15)',
                      color: '#a5b4fc',
                      fontWeight: 700,
                      fontSize: '0.65rem',
                    }} />
                  )}
                </Box>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 700, color: '#e2e8f0' }}>
                  {feat.title}
                </Typography>
                <Typography variant="body2" sx={{ color: 'rgba(226,232,240,0.5)', lineHeight: 1.6 }}>
                  {feat.description}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mb: 5 }} />

      {/* SDK Health Check Panel */}
      <Box sx={{ mb: 5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
          <Zap size={22} color="#6366f1" />
          <Typography variant="h5" sx={{ fontWeight: 800 }}>SDK Live Health Check</Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Tests Backend health, CRUD, Query operators, Pointers and LiveQuery in real time.
        </Typography>
        <Button
          id="run-health-btn"
          variant="contained"
          onClick={handleRunHealth}
          disabled={healthLoading}
          sx={{ mb: 2, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', fontWeight: 700, borderRadius: 2 }}
        >
          {healthLoading ? 'Running...' : 'Run Health Check'}
        </Button>
        {healthLoading && <LinearProgress sx={{ borderRadius: 4, mb: 2 }} />}
        {health && (
          <Grid container spacing={2}>
            {health.map((item, i) => (
              <Grid size={{ xs: 12, sm: 6 }} key={i} sx={{ width: { xs: '100%', sm: '50%' } }}>
                <Paper sx={{ p: 2, borderRadius: 2, display: 'flex', alignItems: 'center', gap: 2, background: '#0f172a', border: '1px solid rgba(255,255,255,0.06)' }}>
                  {item.status === 'ok'
                    ? <CheckCircle size={20} color="#4ade80" />
                    : <AlertCircle size={20} color="#f87171" />
                  }
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 700, color: '#e2e8f0' }}>{item.label}</Typography>
                    <Typography variant="caption" sx={{ color: item.status === 'ok' ? '#4ade80' : '#f87171', fontFamily: 'monospace' }}>
                      {item.detail}
                    </Typography>
                  </Box>
                </Paper>
              </Grid>
            ))}
          </Grid>
        )}
      </Box>

      {/* Pointer Demo Panel */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
          <Link2 size={22} color="#8b5cf6" />
          <Typography variant="h5" sx={{ fontWeight: 800 }}>Live Pointer / Relation Demo</Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Creates an <code>Author</code> object and a <code>Post</code> that points to it,
          then queries with <code>.include("author")</code> to resolve the pointer graph.
        </Typography>
        {!user && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <strong>Login required</strong> to run the pointer demo (ACL enforced).
          </Alert>
        )}
        <Button
          id="run-pointer-demo-btn"
          variant="outlined"
          onClick={handlePointerDemo}
          disabled={!user || pointerRunning}
          sx={{ mb: 2, borderColor: '#8b5cf6', color: '#a78bfa', fontWeight: 700, borderRadius: 2 }}
        >
          {pointerRunning ? 'Running demo...' : '▶ Run Pointer Demo'}
        </Button>
        {pointerRunning && <LinearProgress color="secondary" sx={{ borderRadius: 4, mb: 2 }} />}
        {pointerError && <Alert severity="error" sx={{ mb: 2, fontFamily: 'monospace' }}>{pointerError}</Alert>}
        {pointerLogs.length > 0 && (
          <Paper sx={{ p: 2, borderRadius: 2, background: '#020617', border: '1px solid rgba(139,92,246,0.2)' }}>
            {pointerLogs.map((log, i) => (
              <Typography key={i} variant="body2" sx={{ fontFamily: 'monospace', color: '#a5b4fc', lineHeight: 2 }}>
                {log}
              </Typography>
            ))}
          </Paper>
        )}
      </Box>
    </Container>
    </Box>
  );
}
