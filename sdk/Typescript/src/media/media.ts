import { Zenith } from "../core/Zenith.js";
import { ZenithObject } from "../objects/ZenithObject.js";

export type MediaRoomOptions = {
  roomId: string;
  e2eeMode?: "strict_sframe" | "off";
  username?: string;
  onLocalStream?: (stream: MediaStream) => void;
  onRemoteStream?: (participantId: string, stream: MediaStream, username?: string) => void;
  onPeerLeft?: (participantId: string) => void;
  onSignalData?: (data: any) => void;
};

export class ZenithMediaRoom {
  private roomId: string;
  private e2eeMode: string;
  private localStream: MediaStream | null = null;
  private peers: Map<string, RTCPeerConnection> = new Map();
  private peerUsernames: Map<string, string> = new Map();
  private ws: WebSocket | null = null;
  private callbacks: Partial<MediaRoomOptions>;
  private isLeaving = false;
  private reconnectAttempts = 0;
  private reconnectTimeout: number | null = null;
  private iceQueues: Map<string, RTCIceCandidate[]> = new Map();
  private remoteDescriptionsSet: Set<string> = new Set();

  constructor(options: MediaRoomOptions) {
    this.roomId = options.roomId;
    this.e2eeMode = options.e2eeMode || "off";
    this.callbacks = options;
  }

  public async join() {
    const config = Zenith.getConfig();
    let wsUrl = config.serverURL.replace(/^http/, "ws") + "/media/" + this.roomId + "?appId=" + config.appId;
    if (Zenith.sessionToken) {
       wsUrl += "&sessionToken=" + Zenith.sessionToken;
    }
    
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        // Enviar handshake inicial
        this.ws?.send(JSON.stringify({
          type: "join",
          appId: config.appId,
          sessionToken: Zenith.sessionToken,
          e2eeMode: this.e2eeMode,
          username: this.callbacks.username,
        }));
        
        // Reset reconnect attempts on success
        this.reconnectAttempts = 0;
        if (this.callbacks.onSignalData) {
          this.callbacks.onSignalData({ type: "reconnect_success" });
        }
        resolve();
      };

      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = this.handleSignalingMessage.bind(this);
      
      this.ws.onclose = () => {
        if (!this.isLeaving) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect() {
    if (this.isLeaving) return;
    
    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    if (this.callbacks.onSignalData) {
      this.callbacks.onSignalData({ type: "reconnecting", attempts: this.reconnectAttempts });
    }
    
    console.warn(`[ZenithMediaRoom] WebSocket disconnected. Reconnecting in ${delay}ms (Attempt ${this.reconnectAttempts})`);
    
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = window.setTimeout(async () => {
      try {
        await this.join();
        // If we have a local stream, re-publish it so we renegotiate with everyone in the room
        if (this.localStream) {
           await this.publishLocalStream(
             this.localStream.getVideoTracks().length > 0,
             this.localStream.getAudioTracks().length > 0,
             false // skip acquiring new getUserMedia
           );
        }
      } catch (err) {
        // Will retry on the next ws.onclose triggered by join() failure
      }
    }, delay);
  }

  private async handleSignalingMessage(evt: MessageEvent) {
    let data = JSON.parse(evt.data);
    if (this.callbacks.onSignalData) {
      this.callbacks.onSignalData(data);
    }

    let senderId = "";
    // Unwrap signal if it comes encapsulated from the backend SFrameSignalingTrait
    if (data.type === "standard_signal" || data.type === "e2ee_signal") {
      senderId = data.senderId;
      data = data.payload;
    }

    const { type, participantId, sdp, candidate, username } = data;
    // For peer_joined, participantId is in the payload. For others, the sender is senderId.
    const peerId = participantId || senderId;

    if (username && peerId) {
       this.peerUsernames.set(peerId, username);
    }

    if (type === "peer_joined") {
      // If the peer already exists, close it to avoid ghost tracks
      this.removePeer(peerId);
      await this.createPeerConnection(peerId, true);
    } else if (type === "offer") {
      this.removePeer(peerId);
      const pc = await this.createPeerConnection(peerId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.ws?.send(JSON.stringify({ type: "answer", target: peerId, sdp: answer, username: this.callbacks.username }));
      this.remoteDescriptionsSet.add(peerId);
      this.drainIceQueue(peerId, pc);
    } else if (type === "answer") {
      const pc = this.peers.get(peerId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        this.remoteDescriptionsSet.add(peerId);
        this.drainIceQueue(peerId, pc);
      }
    } else if (type === "candidate") {
      const pc = this.peers.get(peerId);
      if (pc) {
        if (this.remoteDescriptionsSet.has(peerId)) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          // Queue candidate until remote description is set
          if (!this.iceQueues.has(peerId)) this.iceQueues.set(peerId, []);
          this.iceQueues.get(peerId)!.push(new RTCIceCandidate(candidate));
        }
      }
    } else if (type === "peer_left") {
      this.removePeer(peerId);
    }
  }

  private async drainIceQueue(peerId: string, pc: RTCPeerConnection) {
    const queue = this.iceQueues.get(peerId);
    if (queue) {
      for (const candidate of queue) {
        await pc.addIceCandidate(candidate).catch(e => console.error("Error adding queued ICE", e));
      }
      this.iceQueues.delete(peerId);
    }
  }

  private async createPeerConnection(participantId: string, isInitiator: boolean): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    this.remoteDescriptionsSet.delete(participantId);
    this.iceQueues.delete(participantId);
    this.peers.set(participantId, pc);

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this.ws?.send(JSON.stringify({
          type: "candidate",
          target: participantId,
          candidate: evt.candidate
        }));
      }
    };

    pc.ontrack = (evt) => {
      if (this.callbacks.onRemoteStream) {
        this.callbacks.onRemoteStream(participantId, evt.streams[0], this.peerUsernames.get(participantId));
      }
    };

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream!);
      });
    }

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.ws?.send(JSON.stringify({ type: "offer", target: participantId, sdp: offer, username: this.callbacks.username }));
    }

    return pc;
  }

  public async publishLocalStream(video: boolean, audio: boolean, acquireNew = true) {
    if (acquireNew) {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ video, audio });
      } catch (err: any) {
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          if (video) {
            console.warn('[ZenithMediaRoom] Requested video device not found, falling back to audio only.');
            try {
              this.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio });
            } catch (audioErr: any) {
              throw new Error('Dispositivo de audio/video no encontrado en esta computadora.');
            }
          } else {
            throw new Error('Dispositivo de audio no encontrado en esta computadora.');
          }
        } else {
          throw err;
        }
      }
    }

    if (this.localStream && this.callbacks.onLocalStream) {
      this.callbacks.onLocalStream(this.localStream);
    }
    
    // Renegotiate with all peers
    this.peers.forEach(async (pc, participantId) => {
      this.localStream!.getTracks().forEach(track => pc.addTrack(track, this.localStream!));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.ws?.send(JSON.stringify({ type: "offer", target: participantId, sdp: offer }));
    });
  }

  public leave() {
    this.isLeaving = true;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.localStream?.getTracks().forEach(track => track.stop());
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.peerUsernames.clear();
    this.iceQueues.clear();
    this.remoteDescriptionsSet.clear();
    this.ws?.close();
  }

  private removePeer(participantId: string) {
    this.iceQueues.delete(participantId);
    this.remoteDescriptionsSet.delete(participantId);
    const pc = this.peers.get(participantId);
    if (pc) {
      pc.close();
      this.peers.delete(participantId);
      if (this.callbacks.onPeerLeft) {
        this.callbacks.onPeerLeft(participantId);
      }
    }
  }
}
