/**
 * WebRTC SFrame selective-encryption signaling: per-participant key distribution for selective forward secrecy, room-based key rotation, sender/receiver scope negotiation.
 *
 * @barrits-trait
 * @barrits-summary ZenithSFrameSignaling
 * @barrits-provides sframe-signaling-routes, sframe-signaling, signaling
 * @barrits-consumes db, acl, e2ee-keys, telemetry
 * @barrits-state activeRooms
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const SFrameSignalingTrait = createTraitDescriptor({
  name: "ZenithSFrameSignaling",
  provides: ["sframe-signaling-routes", "sframe-signaling", "signaling"],
  consumes: ["db", "acl", "e2ee-keys", "telemetry"],
  state: ["activeRooms"],
  runtimes: ["deno"],
  summary: "WebRTC SFrame selective-encryption signaling: per-participant key distribution for selective forward secrecy, room-based key rotation, sender/receiver scope negotiation.",
  create: (deps: Record<string, any>) => {
    const db = deps["db"];

    const traitApi: any = {
      activeRooms: new Map<string, { roomId: string; participants: Map<string, { keyId: string; joinedAt: number }>; createdAt: number }>(),

      createRoom: async (roomId: string, options: { maxParticipants?: number; keyRotationSec?: number } = {}) => {
        const room = {
          roomId,
          maxParticipants: options.maxParticipants || 50,
          keyRotationSec: options.keyRotationSec || 3600,
          participants: new Map(),
          createdAt: Date.now(),
        };
        traitApi.activeRooms.set(roomId, room);
        await db.create("_SFrameRoom", { roomId, maxParticipants: room.maxParticipants, keyRotationSec: room.keyRotationSec, createdAt: new Date().toISOString() });
        return { roomId, maxParticipants: room.maxParticipants, keyRotationSec: room.keyRotationSec };
      },

      joinRoom: async (roomId: string, userId: string) => {
        const room = traitApi.activeRooms.get(roomId);
        if (!room) throw new Error("room not found");
        if (room.participants.size >= room.maxParticipants) throw new Error("room full");
        const keyId = crypto.randomUUID();
        room.participants.set(userId, { keyId, joinedAt: Date.now() });
        return {
          roomId,
          userId,
          keyId,
          participants: Array.from(room.participants.keys()),
        };
      },

      rotateRoomKeys: async (roomId: string) => {
        const room = traitApi.activeRooms.get(roomId);
        if (!room) throw new Error("room not found");
        const newKeys: any[] = [];
        for (const userId of room.participants.keys()) {
          const newKeyId = crypto.randomUUID();
          room.participants.set(userId, { keyId: newKeyId, joinedAt: Date.now() });
          newKeys.push({ userId, keyId: newKeyId });
        }
        return { rotated: true, newKeys };
      },
    };

    const sframe_signaling_routes = [
      {
        method: "POST" as const,
        path: "/sframe/rooms",
        _openapi: { summary: "Create an SFrame room for selective encryption" },
        handler: async (req: Request) => {
          const body = await req.json() as { roomId: string; maxParticipants?: number; keyRotationSec?: number };
          const room = await traitApi.createRoom(body.roomId, body);
          return new Response(JSON.stringify(room), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/sframe/rooms/:roomId/join",
        _openapi: { summary: "Join an SFrame room", parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const roomId = new URL(req.url).pathname.split("/")[3];
          const body = await req.json() as { userId: string };
          const result = await traitApi.joinRoom(roomId, body.userId);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "POST" as const,
        path: "/sframe/rooms/:roomId/rotate",
        _openapi: { summary: "Rotate all keys in an SFrame room", parameters: [{ name: "roomId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const roomId = new URL(req.url).pathname.split("/")[3];
          const result = await traitApi.rotateRoomKeys(roomId);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "sframe-signaling-routes": sframe_signaling_routes,
      "sframe-signaling": traitApi,
      "signaling": traitApi,
    };
  },
});
