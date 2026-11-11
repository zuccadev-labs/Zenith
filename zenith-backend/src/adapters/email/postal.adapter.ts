/**
 * Postal mail server adapter for Zenith — Self-hosted email delivery.
 *
 * @barrits-trait
 * @barrits-summary ZenithEmailPostal
 * @barrits-provides injectPostalPlugin, sendMail, sendPasswordResetEmail, sendVerificationEmail
 * @barrits-consumes
 * @barrits-state plugin
 * @barrits-stability stable
 * @barrits-runtime deno
 */
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { EmailAdapter, EmailOptions } from "./types.ts";

/**
 * Configuration options for the Postal mail server adapter.
 */
export interface PostalAdapterOptions {
  /** Postal server URL (e.g. https://postal.yourdomain.com) */
  serverUrl: string;
  /** Postal API key with send permissions */
  apiKey: string;
  /** Default from address for outgoing emails */
  defaultFrom: string;
}

/**
 * Creates a Postal mail server adapter implementing the EmailAdapter interface.
 * Uses the Postal HTTP API for transactional email delivery including password resets
 * and email verification.
 *
 * @param options - PostalAdapterOptions with server URL, API key, and default sender
 * @returns EmailAdapter — sendMail, sendPasswordResetEmail, and sendVerificationEmail interface
 */
export function createPostalAdapter(options: PostalAdapterOptions): EmailAdapter {
  const sendViaPostal = async (mailOptions: EmailOptions) => {
    const payload = {
      to: [mailOptions.to],
      from: mailOptions.from || options.defaultFrom,
      subject: mailOptions.subject,
      plain_body: mailOptions.text,
      html_body: mailOptions.html,
      reply_to: mailOptions.replyTo,
    };

    const res = await fetch(`${options.serverUrl}/api/v1/send/message`, {
      method: "POST",
      headers: {
        "X-Server-API-Key": options.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
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
        text:
          `Hi ${user.username},\n\nYou requested to reset your password for ${appName}.\n\nClick here to reset it: ${link}`,
        html:
          `<p>Hi ${user.username},</p><p>You requested to reset your password for ${appName}.</p><p><a href="${link}">Click here to reset it</a></p>`,
      });
    },

    sendVerificationEmail: async ({ appName, link, user }) => {
      await sendViaPostal({
        to: user.email,
        subject: `Please verify your e-mail for ${appName}`,
        text:
          `Hi ${user.username},\n\nPlease verify your email address for ${appName} by clicking this link:\n\n${link}`,
        html:
          `<p>Hi ${user.username},</p><p>Please verify your email address for ${appName} by clicking this link:</p><p><a href="${link}">Verify Email</a></p>`,
      });
    },
  };
}

/**
 * Trait para inyectar el adaptador de Email en Zenith
 */
export const EmailPostalTrait = createTraitDescriptor({
  name: "ZenithEmailPostal",
  provides: ["injectPostalPlugin", "sendMail", "sendPasswordResetEmail", "sendVerificationEmail"],
  consumes: [],
  state: ["plugin"],
  runtimes: ["deno"],
  create: (_deps: Record<string, unknown>) => {
    let adapter: EmailAdapter | null = null;
    return {
      injectPostalPlugin: (plugin: EmailAdapter) => {
        adapter = plugin;
        console.log("[EmailTrait] Postal Email Plugin Injected");
      },
      sendMail: (options: EmailOptions) => adapter?.sendMail(options),
      sendPasswordResetEmail: (options: any) => adapter?.sendPasswordResetEmail(options),
      sendVerificationEmail: (options: any) => adapter?.sendVerificationEmail(options),
    };
  },
});
