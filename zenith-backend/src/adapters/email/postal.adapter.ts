import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { EmailAdapter, EmailOptions } from "./types.ts";

export interface PostalAdapterOptions {
  serverUrl: string; // e.g. https://postal.yourdomain.com
  apiKey: string;
  defaultFrom: string;
}

/**
 * Adaptador puro para Postal Server
 */
export function createPostalAdapter(options: PostalAdapterOptions): EmailAdapter {
  const sendViaPostal = async (mailOptions: EmailOptions) => {
    const payload = {
      to: [mailOptions.to],
      from: mailOptions.from || options.defaultFrom,
      subject: mailOptions.subject,
      plain_body: mailOptions.text,
      html_body: mailOptions.html,
      reply_to: mailOptions.replyTo
    };

    const res = await fetch(`${options.serverUrl}/api/v1/send/message`, {
      method: "POST",
      headers: {
        "X-Server-API-Key": options.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Postal API error: ${res.status} ${errorText}`);
    }
  };

  return {
    sendMail: async (mailOptions: EmailOptions) => {
      await sendViaPostal(mailOptions);
    },

    sendPasswordResetEmail: async ({ appName, link, user }) => {
      await sendViaPostal({
        to: user.email,
        subject: `Password Reset for ${appName}`,
        text: `Hi ${user.username},\n\nYou requested to reset your password for ${appName}.\n\nClick here to reset it: ${link}`,
        html: `<p>Hi ${user.username},</p><p>You requested to reset your password for ${appName}.</p><p><a href="${link}">Click here to reset it</a></p>`
      });
    },

    sendVerificationEmail: async ({ appName, link, user }) => {
      await sendViaPostal({
        to: user.email,
        subject: `Please verify your e-mail for ${appName}`,
        text: `Hi ${user.username},\n\nPlease verify your email address for ${appName} by clicking this link:\n\n${link}`,
        html: `<p>Hi ${user.username},</p><p>Please verify your email address for ${appName} by clicking this link:</p><p><a href="${link}">Verify Email</a></p>`
      });
    }
  };
}

/**
 * Trait para inyectar el adaptador de Email en Zenith
 */
export const EmailPostalTrait = createTraitDescriptor({
  name: "ZenithEmailPostal",
  provides: ["injectPlugin", "sendMail", "sendPasswordResetEmail", "sendVerificationEmail"],
  consumes: [],
  state: ["plugin"],
  runtimes: ["deno"],
  create: (_deps: Record<string, unknown>) => {
    let adapter: EmailAdapter | null = null;
    return {
      injectPlugin: (plugin: EmailAdapter) => {
        adapter = plugin;
        console.log("[EmailTrait] Postal Email Plugin Injected");
      },
      sendMail: (options: EmailOptions) => adapter?.sendMail(options),
      sendPasswordResetEmail: (options: any) => adapter?.sendPasswordResetEmail(options),
      sendVerificationEmail: (options: any) => adapter?.sendVerificationEmail(options)
    };
  }
});
