/**
 * @hook useZenithMedia
 *
 * Enterprise-grade hook for WebRTC media rooms (audio/video calls).
 *
 * Corporate best practices:
 * - Explicit join/leave — component controls session lifecycle, not mount/unmount.
 *   This avoids the "leave is not a function" crash when React StrictMode
 *   double-invokes effects and the room object hasn't been assigned yet.
 * - Options object API — avoids argument-order bugs and supports future options.
 * - Stable roomId validation — guards against [object Object] in WS URL.
 * - Ref-based room instance — survives re-renders without triggering effects.
 * - toggleAudio/toggleVideo accept explicit `enabled` boolean — no toggle-blindness.
 * - Returns remoteStreams as Array<[peerId, MediaStream]> for easy .map() in JSX.
 */

import { useState, useRef, useCallback } from "react";
import { ZenithMediaRoom } from "../media/media.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UseZenithMediaOptions {
  /** Room identifier — must be a non-empty string */
  roomId: string;
  /** User identifier for presence tracking */
  userId: string;
  /** Username for display */
  username?: string;
  /** E2EE mode: strict_sframe = client-side E2EE, hop_by_hop = server-encrypted */
  mode: "strict_sframe" | "hop_by_hop";
  /** Request microphone access on join */
  audio?: boolean;
  /** Request camera access on join */
  video?: boolean;
}

export interface RemoteStreamMetadata {
  stream: MediaStream;
  username?: string;
}

export interface UseZenithMediaResult {
  /** Call to join the room and request media permissions */
  join: () => Promise<void>;
  /** Call to leave the room and stop all local tracks */
  leave: () => void;
  /** Local camera/mic stream — null until join() resolves */
  localStream: MediaStream | null;
  /** Remote peer streams as [peerId, metadata] pairs */
  remoteStreams: [string, RemoteStreamMetadata][];
  /** True while the WebSocket handshake is in progress */
  isConnecting: boolean;
  /** Enable or disable microphone track explicitly */
  toggleAudio: (enabled: boolean) => void;
  /** Enable or disable camera track explicitly */
  toggleVideo: (enabled: boolean) => void;
  /** Current requested state of the microphone */
  isAudioEnabled: boolean;
  /** Current requested state of the camera */
  isVideoEnabled: boolean;
  /** High-level connection state for the UI */
  connectionState: "disconnected" | "connecting" | "connected" | "reconnecting";
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useZenithMedia(options: UseZenithMediaOptions): UseZenithMediaResult {
  const { roomId, userId, username, mode, audio = true, video = false } = options;

  // Validate roomId early — prevents [object Object] in WebSocket URL
  if (!roomId || typeof roomId !== "string") {
    console.error(`[useZenithMedia] Invalid roomId: ${JSON.stringify(roomId)}. Must be a non-empty string.`);
  }

  // Storage Key for Media Prefs
  const prefsKey = `Zenith/mediaPrefs`;
  
  // Read initial prefs synchronously if possible (LocalStorage), otherwise fallback to props
  const getInitialPref = (key: 'audio' | 'video', defaultVal: boolean) => {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = window.localStorage.getItem(prefsKey);
      if (stored) {
        try {
          const prefs = JSON.parse(stored);
          if (prefs[key] !== undefined) return prefs[key];
        } catch(e) {}
      }
    }
    return defaultVal;
  };

  const initialAudio = getInitialPref('audio', audio);
  const initialVideo = getInitialPref('video', video);

  const roomRef = useRef<ZenithMediaRoom | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteStreamMetadata>>(new Map());
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionState, setConnectionState] = useState<"disconnected" | "connecting" | "connected" | "reconnecting">("disconnected");

  // Sync state explicitly to avoid toggle desyncs
  const [isAudioEnabled, setIsAudioEnabled] = useState(initialAudio);
  const [isVideoEnabled, setIsVideoEnabled] = useState(initialVideo);

  // Save pref helper
  const savePref = (key: 'audio'|'video', val: boolean) => {
    import('../core/StorageController.js').then(({ ZenithStorage }) => {
      ZenithStorage.getItem(prefsKey).then(stored => {
        const prefs = stored ? JSON.parse(stored) : {};
        prefs[key] = val;
        ZenithStorage.setItem(prefsKey, JSON.stringify(prefs));
      }).catch(()=>{});
    });
  };

  const join = useCallback(async () => {
    if (roomRef.current) return; // already joined
    if (!roomId || typeof roomId !== "string") {
      throw new Error(`[useZenithMedia] Cannot join: roomId must be a string, got ${typeof roomId}`);
    }

    setIsConnecting(true);
    setConnectionState("connecting");

    const room = new ZenithMediaRoom({
      roomId,
      e2eeMode: mode === "strict_sframe" ? "strict_sframe" : "off",
      username,
      onLocalStream: (stream) => {
        stream.getAudioTracks().forEach(t => t.enabled = initialAudio);
        stream.getVideoTracks().forEach(t => t.enabled = initialVideo);
        setLocalStream(stream);
      },
      onRemoteStream: (peerId, stream, peerUsername) => {
        setRemoteStreams(prev => {
          const next = new Map(prev);
          next.set(peerId, { stream, username: peerUsername });
          return next;
        });
      },
      onPeerLeft: (peerId) => {
        setRemoteStreams(prev => {
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
      },
      onSignalData: (data) => {
        if (data.type === "reconnecting") {
          setConnectionState("reconnecting");
        } else if (data.type === "reconnect_success") {
          setConnectionState("connected");
        }
      }
    });

    try {
      if ((video || audio) && !navigator.mediaDevices) {
        throw new Error('navigator.mediaDevices is undefined. WebRTC requires a Secure Context (HTTPS or localhost).');
      }
      await room.join();
      await room.publishLocalStream(video, audio);
      roomRef.current = room;
      setConnectionState("connected");
    } catch (e: any) {
      console.error('[useZenithMedia] Join error:', e);
      setConnectionState("disconnected");
      throw e;
    } finally {
      setIsConnecting(false);
    }
  }, [roomId, mode, audio, video, userId, username, initialAudio, initialVideo]);

  const leave = useCallback(() => {
    if (!roomRef.current) return;
    roomRef.current.leave();
    roomRef.current = null;
    setLocalStream(null);
    setRemoteStreams(new Map());
    setIsConnecting(false);
    setConnectionState("disconnected");
  }, []);

  const toggleAudio = useCallback((enabled: boolean) => {
    setIsAudioEnabled(enabled);
    savePref('audio', enabled);
    localStream?.getAudioTracks().forEach(t => { t.enabled = enabled; });
  }, [localStream]);

  const toggleVideo = useCallback((enabled: boolean) => {
    setIsVideoEnabled(enabled);
    savePref('video', enabled);
    localStream?.getVideoTracks().forEach(t => { t.enabled = enabled; });
  }, [localStream]);

  // Convert Map to stable array for JSX .map()
  const remoteStreamsArray: [string, RemoteStreamMetadata][] = Array.from(remoteStreams.entries());

  return { 
    join, leave, localStream, remoteStreams: remoteStreamsArray, isConnecting, 
    toggleAudio, toggleVideo, 
    isAudioEnabled, isVideoEnabled,
    connectionState
  };
}
