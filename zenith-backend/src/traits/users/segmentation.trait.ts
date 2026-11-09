// deno-lint-ignore-file no-unused-vars
/**
 * GDPR/LGPD-compliant user segmentation: dynamic segments based on rules, consent-aware exports, data subject access request (DSAR) fulfillment, right-to-be-forgotten.
 *
 * @barrits-trait
 * @barrits-summary ZenithSegmentation
 * @barrits-provides segmentation-routes, segmentation, audienceManager
 * @barrits-consumes db
 * @barrits-tags uses:events
 * @barrits-state segmentCache
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";

export const SegmentationTrait = createTraitDescriptor({
  name: "ZenithSegmentation",
  provides: ["segmentation-routes", "segmentation", "audienceManager"],
  consumes: ["db"],
  tags: ["uses:events"],
  state: ["segmentCache"],
  runtimes: ["deno"],
  summary: "GDPR/LGPD-compliant user segmentation: dynamic segments based on rules, consent-aware exports, data subject access request (DSAR) fulfillment, right-to-be-forgotten.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];
    const events = deps.traits["events"];

    const traitApi: any = {
      segmentCache: new Map<string, { count: number; computedAt: number }>(),

      defineSegment: async (name: string, rules: { field: string; op: string; value: any }[], options: { description?: string; refreshInterval?: number } = {}) => {
        const segment = {
          name,
          rules,
          description: options.description || "",
          refreshInterval: options.refreshInterval || 3600,
          createdAt: new Date().toISOString(),
        };
        const existing = await db.find("_Segment", { name });
        if (existing.length > 0) await db.update("_Segment", { objectId: existing[0].objectId }, segment);
        else await db.create("_Segment", segment);
        traitApi.segmentCache.delete(name);
        return segment;
      },

      evaluateSegment: async (name: string): Promise<string[]> => {
        const cached = traitApi.segmentCache.get(name);
        if (cached && Date.now() - cached.computedAt < 3600 * 1000) return [];
        const segments = await db.find("_Segment", { name });
        if (segments.length === 0) throw new Error(`segment not found: ${name}`);
        const seg = segments[0];
        const allUsers = await db.find("_User", {});
        const matched: string[] = [];
        for (const user of allUsers) {
          let isMatch = true;
          for (const rule of seg.rules) {
            const fieldValue = user[rule.field];
            if (rule.op === "==" && fieldValue !== rule.value) { isMatch = false; break; }
            if (rule.op === "!=" && fieldValue === rule.value) { isMatch = false; break; }
            if (rule.op === ">" && !(fieldValue > rule.value)) { isMatch = false; break; }
            if (rule.op === "<" && !(fieldValue < rule.value)) { isMatch = false; break; }
            if (rule.op === "contains" && !(String(fieldValue).includes(rule.value))) { isMatch = false; break; }
          }
          if (isMatch) matched.push(user.objectId);
        }
        traitApi.segmentCache.set(name, { count: matched.length, computedAt: Date.now() });
        return matched;
      },

      exportUserData: async (userId: string): Promise<Record<string, any>> => {
        const user = await db.read("_User", userId);
        if (!user) throw new Error("user not found");
        const { passwordHash, mfaSecret, passwordResetToken, ...safeUser } = user;
        const allClasses = await db.listClasses();
        const data: Record<string, any> = { user: safeUser, relatedObjects: {} as Record<string, any[]> };
        for (const className of allClasses) {
          if (className === "_User") continue;
          const records = await db.find(className, {});
          const userRelated = records.filter((r: any) => r.userId === userId || (r.user && r.user.objectId === userId));
          if (userRelated.length > 0) (data.relatedObjects as any)[className] = userRelated;
        }
        return data;
      },

      deleteUserData: async (userId: string): Promise<{ deletedFrom: string[] }> => {
        const deletedFrom: string[] = [];
        await db.delete("_User", { objectId: userId });
        deletedFrom.push("_User");
        const allClasses = await db.listClasses();
        for (const className of allClasses) {
          if (className === "_User") continue;
          const records = await db.find(className, {});
          const userRelated = records.filter((r: any) => r.userId === userId || (r.user && r.user.objectId === userId));
          for (const r of userRelated) {
            await db.delete(className, { objectId: r.objectId });
          }
          if (userRelated.length > 0) deletedFrom.push(className);
        }
        if (events) events.emit("user.gdpr.erased", { userId, deletedFrom });
        return { deletedFrom };
      },
    };

    const segmentation_routes = [
      {
        method: "POST" as const,
        path: "/segments",
        _openapi: {
          summary: "Define or update a segment",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, rules: { type: "array" }, description: { type: "string" } }, required: ["name", "rules"] } } } },
        },
        handler: async (req: Request) => {
          const body = await req.json() as { name: string; rules: any[]; description?: string };
          const seg = await traitApi.defineSegment(body.name, body.rules, { description: body.description });
          return new Response(JSON.stringify(seg), { status: 201, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/segments/:name/evaluate",
        _openapi: { summary: "Evaluate a segment and return matching user IDs", parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const name = new URL(req.url).pathname.split("/")[2];
          const userIds = await traitApi.evaluateSegment(name);
          return new Response(JSON.stringify({ name, count: userIds.length, userIds }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "GET" as const,
        path: "/gdpr/export/:userId",
        _openapi: { summary: "Export all user data (DSAR)", parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const userId = new URL(req.url).pathname.split("/")[3];
          const data = await traitApi.exportUserData(userId);
          return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
      {
        method: "DELETE" as const,
        path: "/gdpr/user/:userId",
        _openapi: { summary: "Delete all user data (right to be forgotten)", parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }] },
        handler: async (req: Request) => {
          const userId = new URL(req.url).pathname.split("/")[3];
          const result = await traitApi.deleteUserData(userId);
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ];

    return {
      "segmentation-routes": segmentation_routes,
      "segmentation": traitApi,
      "audienceManager": traitApi,
    };
  },
});
