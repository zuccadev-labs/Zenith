/**
 * Push notifications: device installation registry, channel-based subscriptions, FCM/APNs adapter, Parse Server-compatible /push endpoint, scheduled delivery.
 *
 * Delivery goes through zutool's engine-push (`enginePush`, by its socket) when it answers: one
 * subscription per installation (owner `zenith:<app>:installation:<id>`, provider `fcm`/`apns`, the
 * device token as target) and `push/send` to it. Without engine-push, `send` records the delivery
 * (`_PushDelivery`) without sending, as before.
 *
 * @barrits-trait
 * @barrits-summary ZenithPush
 * @barrits-provides push-routes, push, pushManager
 * @barrits-consumes db
 * @barrits-tags uses:enginePush
 * @barrits-state installations, pushChannels
 * @barrits-stability experimental
 * @barrits-runtime deno
 */
import { type AnyTraitDescriptor, createTraitDescriptor } from "@zuccadev-labs/barrits";

export const PushTrait: AnyTraitDescriptor = createTraitDescriptor({
  name: "ZenithPush",
  provides: ["push-routes", "push", "pushManager"],
  consumes: ["db"],
  tags: ["uses:enginePush"],
  state: ["installations", "pushChannels"],
  runtimes: ["deno"],
  summary:
    "Push notifications: device installation registry, channel-based subscriptions, FCM/APNs adapter, Parse Server-compatible /push endpoint, scheduled delivery.",
  create: (deps: Record<string, any>) => {
    const db = deps.traits["db"];

    const traitApi: any = {
      installations: new Map<
        string,
        {
          installationId: string;
          deviceToken: string;
          pushType: "fcm" | "apns";
          channels: string[];
        }
      >(),
      channels: new Map<string, Set<string>>(),

      registerInstallation: async (
        installationId: string,
        deviceToken: string,
        pushType: "fcm" | "apns",
        channels: string[] = [],
      ) => {
        const inst = { installationId, deviceToken, pushType, channels };
        traitApi.installations.set(installationId, inst);
        await db.upsert("_Installation", { installationId }, {
          ...inst,
          createdAt: new Date().toISOString(),
        });
        for (const ch of channels) {
          if (!traitApi.channels.has(ch)) traitApi.channels.set(ch, new Set());
          traitApi.channels.get(ch)!.add(installationId);
        }
        return inst;
      },

      subscribe: async (installationId: string, channel: string) => {
        const inst = traitApi.installations.get(installationId);
        if (!inst) throw new Error("installation not found");
        if (!inst.channels.includes(channel)) inst.channels.push(channel);
        if (!traitApi.channels.has(channel)) traitApi.channels.set(channel, new Set());
        traitApi.channels.get(channel)!.add(installationId);
        await db.update("_Installation", { installationId }, { channels: inst.channels });
        return { subscribed: true };
      },

      unsubscribe: async (installationId: string, channel: string) => {
        const inst = traitApi.installations.get(installationId);
        if (!inst) return { unsubscribed: false };
        inst.channels = inst.channels.filter((c: string) => c !== channel);
        traitApi.channels.get(channel)?.delete(installationId);
        await db.update("_Installation", { installationId }, { channels: inst.channels });
        return { unsubscribed: true };
      },

      send: async (data: { channels?: string[]; where?: any; data: Record<string, any> }) => {
        const targets: string[] = [];
        if (data.channels) {
          for (const ch of data.channels) {
            const subs = traitApi.channels.get(ch);
            if (subs) targets.push(...Array.from(subs) as string[]);
          }
        }
        const deliveryLog: any[] = [];
        for (const instId of targets) {
          const inst = traitApi.installations.get(instId);
          if (!inst) continue;
          deliveryLog.push({
            installationId: instId,
            pushType: inst.pushType,
            deviceToken: inst.deviceToken.slice(0, 8) + "...",
            payload: data.data,
          });
        }
        // engine-push when it answers; otherwise the delivery is only recorded, as before.
        const enginePush = deps.traits["enginePush"];
        let via: "engine-push" | "none" = "none";
        let delivered = 0;
        if (enginePush && deliveryLog.length && await enginePush.available()) {
          via = "engine-push";
          const payload = data.data ?? {};
          const message = enginePush.message({
            title: payload.title,
            body: payload.alert ?? payload.body,
            kind: "zenith-push",
            urgency: payload.priority === "high" ? "high" : "normal",
            collapseKey: payload.collapseKey,
            data: payload,
          });
          await Promise.all(deliveryLog.map(async (entry) => {
            const inst = traitApi.installations.get(entry.installationId)!;
            try {
              const r = await enginePush.deliver(
                await enginePush.installationOwner(inst.installationId),
                inst.pushType,
                inst.deviceToken,
                message,
              );
              const bad = (r.results ?? []).find((x: { ok: boolean }) => !x.ok);
              entry.ok = r.delivered > 0 && !bad;
              if (!entry.ok) entry.error = bad?.error ?? "engine-push has no subscription for it";
            } catch (e) {
              entry.ok = false;
              entry.error = (e as Error).message;
            }
            if (entry.ok) delivered++;
          }));
        }
        await db.create("_PushDelivery", {
          targetCount: targets.length,
          payload: data.data,
          via,
          ...(via === "engine-push" ? { delivered } : {}),
          sentAt: new Date().toISOString(),
        });
        return {
          sent: targets.length,
          deliveryLog,
          via,
          ...(via === "engine-push" ? { delivered } : {}),
        };
      },
    };

    const push_routes = [
      {
        method: "POST" as const,
        path: "/installations",
        _openapi: { summary: "Register a device installation" },
        handler: async (req: Request) => {
          const body = await req.json() as {
            installationId: string;
            deviceToken: string;
            pushType: "fcm" | "apns";
            channels?: string[];
          };
          const inst = await traitApi.registerInstallation(
            body.installationId,
            body.deviceToken,
            body.pushType,
            body.channels,
          );
          return new Response(JSON.stringify(inst), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      },
      {
        method: "POST" as const,
        path: "/push",
        _openapi: { summary: "Send a push notification" },
        handler: async (req: Request) => {
          const body = await req.json();
          const result = await traitApi.send(body);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    ];

    return {
      "push-routes": push_routes,
      "push": traitApi,
      "pushManager": traitApi,
    };
  },
});
