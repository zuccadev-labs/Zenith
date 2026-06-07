# WebRTC Media Integration & Resiliency

This document outlines the architecture, integration patterns, and best practices for implementing Real-Time Communication (WebRTC) using the Zenith Cloud Functions and the Zenith React SDK. 

The Zenith Media framework is designed to provide enterprise-grade reliability, including automatic exponential backoff reconnection, seamless peer lifecycle management, and blind Selective Forwarding Unit (SFU) signaling for Zero-Knowledge architectures (Strict SFrame).

## 1. Cloud Infrastructure (Backend Interception)

The Zenith Media orchestrator (`SFrameSignalingTrait`) is designed with a strict Separation of Concerns (SoC). The underlying WebRTC signaling logic is handled automatically, but critical lifecycle events are bubbled up to the Zenith Cloud Functions engine. 

This architecture allows DevOps and Backend Engineering teams to implement business logic, access control, and auditing without modifying the underlying real-time transport layer.

### Example: Enforcing Access Control via Cloud Functions

To intercept WebRTC signaling events and enforce business rules (e.g., restricting access to premium rooms), developers can register an event handler using `ZenithCloud.onStreamEvent`.

```typescript
// zenith-backend/src/cloud/main.ts
import { ZenithCloud } from "@zenith/core";

/**
 * Intercepts WebRTC signaling events before they are broadcasted to the room.
 */
ZenithCloud.onStreamEvent("signal_received", async (request) => {
  const { roomId, senderId, ctx } = request;
  
  // Retrieve the authenticated user context
  const user = await ctx.user();
  
  if (!user) {
    throw new Error("Unauthorized: Access denied to media room.");
  }
  
  // Implement Business Logic: Enforce premium role requirements
  if (roomId.startsWith("premium-") && user.get("role") !== "premium") {
    // Throwing an error aborts the SDP exchange, effectively 
    // preventing the WebRTC connection from being established.
    throw new Error("Forbidden: Subscription required for premium rooms.");
  }

  console.log(`[Security Audit] Media signaling authorized for ${user.get("username")} in room ${roomId}`);
});
```

## 2. Client SDK (Frontend Integration)

The Zenith React SDK abstracts the complexity of `RTCPeerConnection` negotiation, ICE Candidate queuing, cryptographic token handling, and WebSocket reconnection strategies.

The SDK implements a Zero-Touch UX philosophy. Developers only need to invoke the `useZenithMedia` hook and bind the resulting media streams to the DOM.

### Example: Implementing a Resilient Video Room

```tsx
// frontend/src/components/EnterpriseVideoRoom.tsx
import React, { useEffect } from 'react';
import { useZenithMedia, useZenithUser } from '@zenith/react-sdk';

interface VideoRoomProps {
  roomId: string;
}

export const EnterpriseVideoRoom: React.FC<VideoRoomProps> = ({ roomId }) => {
  const { user } = useZenithUser();
  
  // 1. Initialize the Zenith Media SDK Hook
  const {
    join, 
    leave, 
    localStream, 
    remoteStreams, 
    connectionState, 
    toggleAudio, 
    isAudioEnabled
  } = useZenithMedia({
    roomId: roomId,
    userId: user?.id,
    username: user?.get('username'),
    mode: "strict_sframe", // Enforces End-to-End Encryption (E2EE)
    audio: true,
    video: true
  });

  // 2. Automate Room Lifecycle
  useEffect(() => {
    join().catch(err => console.error("Failed to join room:", err.message));
    
    // Ensure hardware tracks are released and memory is cleared on unmount
    return () => leave();
  }, [join, leave]);

  // 3. Render the UI Elements
  return (
    <div className="video-room-container">
      <h2>Room: {roomId}</h2>
      
      {/* Network Resiliency Indicator */}
      {connectionState === "reconnecting" && (
        <div className="alert-warning">
          ⚠️ Network instability detected. Restoring secure connection...
        </div>
      )}

      <div className="video-grid">
        {/* Local Hardware Stream */}
        {localStream && (
          <div className="video-card local-video">
            <video 
              autoPlay 
              playsInline 
              muted // Always mute local video to prevent feedback loops
              ref={el => { if(el) el.srcObject = localStream; }}
            />
            <p>You (Microphone {isAudioEnabled ? 'ON' : 'OFF'})</p>
          </div>
        )}

        {/* Dynamic Remote Streams Mapping */}
        {remoteStreams.map(([peerId, meta]) => (
          <div key={peerId} className="video-card remote-video">
            <video 
              autoPlay 
              playsInline
              ref={el => { if(el) el.srcObject = meta.stream; }}
            />
            <p>Participant: {meta.username || peerId}</p>
          </div>
        ))}
      </div>

      {/* Hardware Controls */}
      <div className="controls">
        <button onClick={() => toggleAudio(!isAudioEnabled)}>
          {isAudioEnabled ? 'Mute Microphone' : 'Unmute Microphone'}
        </button>
        <button onClick={leave}>
          Disconnect
        </button>
      </div>
    </div>
  );
};
```

## Architectural Highlights

1. **Hardware Resource Management:** The `leave()` lifecycle method guarantees that all underlying `MediaStreamTrack` instances are properly stopped. This prevents memory leaks and ensures device activity indicators (e.g., webcam LEDs) turn off immediately, complying with strict privacy standards.
2. **Exponential Backoff Reconnection:** The SDK implements an enterprise-grade reconnection engine. In the event of a WebSocket drop, the SDK silently attempts to reconnect using an exponential backoff strategy (up to 30 seconds). During this phase, the `connectionState` flag is updated to `reconnecting`, allowing the UI to react gracefully without requiring developer intervention.
3. **Ghost Peer Prevention:** The framework proactively manages peer lifecycles. When an existing peer drops and reconnects abruptly, the SDK performs an automatic "Cleanup and Replace" operation, destroying stale `RTCPeerConnection` objects to prevent "black screen" artifacts.
