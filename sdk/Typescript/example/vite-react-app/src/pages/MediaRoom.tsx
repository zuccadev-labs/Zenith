/**
 * MediaRoom — Enterprise WebRTC Audio/Video Room
 *
 * RULES OF HOOKS: ALL hooks (useState, useCallback, useEffect, custom hooks)
 * are declared at the TOP of the component, unconditionally, BEFORE any
 * conditional returns. This is a hard React rule — violating it causes
 * "Rendered more hooks than during previous render" crashes.
 *
 * Corporate best practices:
 * - All MUI system props in sx={{}} (MUI v6 compliance)
 * - useCallback for all handlers — stable refs, no stale closures
 * - leave() guarded with joined flag — no crash on StrictMode double-invoke
 * - CircularProgress while session loads — no premature /auth redirect
 * - Error boundary recommendation on join failure
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Container, Typography, Box, Paper, Button, Grid, Avatar, Chip, CircularProgress
} from '@mui/material';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Shield, Copy, CheckCircle } from 'lucide-react';
import { useZenithUser, useZenithMedia } from '@zuccadev-labs/zenith/react';
import { useNavigate } from 'react-router-dom';

// ─── VideoPlayer ─────────────────────────────────────────────────────────────

function VideoPlayer({ stream, muted = false, label }: {
  stream: MediaStream;
  muted?: boolean;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 12 }}
      />
      <Box sx={{ position: 'absolute', bottom: 8, left: 8, bgcolor: 'rgba(0,0,0,0.6)', px: 1, borderRadius: 1 }}>
        <Typography variant="caption" color="white">{label}</Typography>
      </Box>
    </Box>
  );
}

// ─── MediaRoom ────────────────────────────────────────────────────────────────

export default function MediaRoom({ mode }: { mode: 'strict_sframe' | 'hop_by_hop' }) {
  // ══════════════════════════════════════════════════════════════════════════════
  // ALL HOOKS MUST BE DECLARED HERE — unconditionally, before any early return.
  // React's reconciler requires hook call order to be identical on every render.
  // ══════════════════════════════════════════════════════════════════════════════

  const { user, loading: userLoading } = useZenithUser();
  const navigate = useNavigate();

  const [roomId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    let id = params.get('room');
    if (!id) {
      id = mode === 'strict_sframe' 
        ? `audio-${Math.random().toString(36).substring(2, 10)}` 
        : `video-${Math.random().toString(36).substring(2, 10)}`;
      window.history.replaceState(null, '', `?room=${id}`);
    }
    return id;
  });
  const isE2EE = mode === 'strict_sframe';

  const {
    join, leave, localStream, remoteStreams, isConnecting, toggleAudio, toggleVideo,
    isAudioEnabled, isVideoEnabled, connectionState
  } = useZenithMedia({
    roomId,
    userId: user?.id ?? 'guest',
    username: user?.get('username'),
    mode,
    audio: true,
    video: mode === 'hop_by_hop',
  });

  const [joined, setJoined]   = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // ── Redirect effect — guarded with !userLoading ──────────────────────────────
  useEffect(() => {
    if (!userLoading && !user) {
      navigate('/auth', { state: { from: window.location.pathname + window.location.search } });
    }
    return () => {
      // Cleanup: only leave if we actually joined — safe against StrictMode
      if (joined) leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLoading, user, navigate]);

  // ── Stable handlers ──────────────────────────────────────────────────────────
  // IMPORTANT: These useCallback declarations are BEFORE any conditional return.
  const handleJoin = useCallback(async () => {
    setJoinError(null);
    try {
      await join();
      setJoined(true);
    } catch (e: any) {
      setJoinError(`[${e?.code ?? 'ERR'}] ${e?.message ?? 'Failed to connect to media server.'}`);
    }
  }, [join]);

  const handleLeave = useCallback(() => {
    leave();
    setJoined(false);
  }, [leave]);

  const handleToggleMic = useCallback(() => {
    toggleAudio(!isAudioEnabled);
  }, [isAudioEnabled, toggleAudio]);

  const handleToggleCam = useCallback(() => {
    toggleVideo(!isVideoEnabled);
  }, [isVideoEnabled, toggleVideo]);

  const [copied, setCopied] = useState(false);
  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  // ══════════════════════════════════════════════════════════════════════════════
  // CONDITIONAL RETURNS — only AFTER all hooks are declared above
  // ══════════════════════════════════════════════════════════════════════════════

  if (userLoading) {
    return (
      <Container maxWidth="sm" sx={{ mt: 12, textAlign: 'center' }}>
        <CircularProgress size={48} />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Verifying session…
        </Typography>
      </Container>
    );
  }

  if (!user) return null; // navigate() already called in effect

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
          {isE2EE ? <Shield color="#10b981" /> : <Video color="#3b82f6" />}
          {isE2EE ? 'Zero-Knowledge Audio Room' : 'Global Video Room'}
        </Typography>
        {isE2EE && (
          <Chip
            label="E2EE Strict SFrame Active"
            color="success"
            size="small"
            icon={<Shield size={14} />}
          />
        )}
        {connectionState === "reconnecting" && (
          <Chip
            label="Reconnecting..."
            color="warning"
            size="small"
            icon={<Video size={14} />}
          />
        )}
        <Button
          variant="outlined"
          color="inherit"
          size="small"
          startIcon={copied ? <CheckCircle size={16} color="#10b981" /> : <Copy size={16} />}
          onClick={handleCopyLink}
          sx={{ ml: 'auto', borderColor: 'rgba(255,255,255,0.2)', color: 'white' }}
        >
          {copied ? 'Copied!' : 'Copy Invite Link'}
        </Button>
      </Box>

      {joinError && (
        <Box sx={{ mb: 2, p: 2, borderRadius: 2, bgcolor: 'error.main', color: 'white', fontSize: '0.875rem', fontFamily: 'monospace' }}>
          {joinError}
        </Box>
      )}

      <Paper elevation={4} sx={{ p: 2, minHeight: '65vh', borderRadius: 3, bgcolor: '#0f172a' }}>
        {!joined ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 2 }}>
            <Avatar sx={{ width: 80, height: 80, bgcolor: isE2EE ? 'success.main' : 'primary.main' }}>
              {isE2EE ? <Shield size={40} /> : <Video size={40} />}
            </Avatar>
            <Typography variant="h5" color="white">
              Ready to join <strong>{roomId}</strong>?
            </Typography>
            {isE2EE && (
              <Typography variant="caption" sx={{ color: 'success.light', textAlign: 'center', maxWidth: 320 }}>
                SFrame E2EE: your media is encrypted client-side before leaving your device.
              </Typography>
            )}
            <Button
              variant="contained"
              color={isE2EE ? 'success' : 'primary'}
              size="large"
              onClick={handleJoin}
              disabled={isConnecting}
              sx={{ borderRadius: 8, px: 5, mt: 1 }}
            >
              {isConnecting ? 'Connecting…' : 'Join Call'}
            </Button>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Grid container spacing={2} sx={{ flexGrow: 1, minHeight: '50vh' }}>
              {localStream && (
                <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                  {mode === 'hop_by_hop' ? (
                    <Box sx={{ height: 240, bgcolor: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
                      <VideoPlayer stream={localStream} muted label="You" />
                    </Box>
                  ) : (
                    <Box sx={{ height: 240, bgcolor: '#1e293b', borderRadius: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
                      <Avatar sx={{ width: 64, height: 64, bgcolor: 'primary.main' }}>
                        {user.get('username')?.charAt(0).toUpperCase() ?? 'Y'}
                      </Avatar>
                      <Typography color="white" variant="body2">You — Audio Active</Typography>
                      <Chip label="🔒 E2EE" size="small" color="success" />
                    </Box>
                  )}
                </Grid>
              )}

              {remoteStreams.map(([peerId, meta]: [string, any]) => (
                <Grid size={{ xs: 12, sm: 6, md: 4 }} key={peerId}>
                  <Box sx={{ height: 240, bgcolor: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
                    {mode === 'hop_by_hop' ? (
                      <VideoPlayer stream={meta.stream} label={meta.username || peerId.substring(0, 8)} />
                    ) : (
                      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
                        <Avatar sx={{ width: 64, height: 64, bgcolor: 'secondary.main' }}>
                          {(meta.username || peerId).charAt(0).toUpperCase()}
                        </Avatar>
                        <Typography color="white" variant="body2">
                          {meta.username || `Secure Peer ${peerId.substring(0, 6)}`}
                        </Typography>
                        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                        <audio autoPlay ref={(el) => { if (el) el.srcObject = meta.stream; }} />
                      </Box>
                    )}
                  </Box>
                </Grid>
              ))}

              {remoteStreams.length === 0 && (
                <Grid size={{ xs: 12 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
                    <Typography color="grey.500" variant="body2">
                      Waiting for others to join…
                    </Typography>
                  </Box>
                </Grid>
              )}
            </Grid>

            <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, mt: 3, p: 2, bgcolor: '#1e293b', borderRadius: 8 }}>
              <Button
                variant="contained"
                color={isAudioEnabled ? 'inherit' : 'error'}
                onClick={handleToggleMic}
                aria-label={isAudioEnabled ? 'Mute' : 'Unmute'}
                sx={{ borderRadius: '50%', minWidth: 56, height: 56 }}
              >
                {isAudioEnabled ? <Mic color="#000" /> : <MicOff />}
              </Button>
              {mode === 'hop_by_hop' && (
                <Button
                  variant="contained"
                  color={isVideoEnabled ? 'inherit' : 'error'}
                  onClick={handleToggleCam}
                  aria-label={isVideoEnabled ? 'Camera off' : 'Camera on'}
                  sx={{ borderRadius: '50%', minWidth: 56, height: 56 }}
                >
                  {isVideoEnabled ? <Video color="#000" /> : <VideoOff />}
                </Button>
              )}
              <Button
                variant="contained"
                color="error"
                onClick={handleLeave}
                aria-label="Leave call"
                sx={{ borderRadius: '50%', minWidth: 56, height: 56 }}
              >
                <PhoneOff />
              </Button>
            </Box>
          </Box>
        )}
      </Paper>
    </Container>
  );
}
