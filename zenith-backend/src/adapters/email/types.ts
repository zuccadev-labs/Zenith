/**
 * @module @zenith/adapters/email/types
 * 
 * Interfaz estándar para el envío de correos electrónicos en Zenith.
 * Siguiendo la arquitectura de adaptadores, el usuario puede inyectar
 * Mailgun, AWS SES, Resend, o un servidor propio como Postal.
 */

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
}

export interface EmailAdapter {
  /**
   * Envía un correo electrónico estándar
   */
  sendMail(options: EmailOptions): Promise<void>;

  /**
   * Envía el correo de reseteo de contraseña (Password Reset)
   */
  sendPasswordResetEmail(options: {
    appName: string;
    link: string;
    user: { username: string; email: string };
  }): Promise<void>;

  /**
   * Envía el correo de verificación de cuenta (Email Verification)
   */
  sendVerificationEmail(options: {
    appName: string;
    link: string;
    user: { username: string; email: string };
  }): Promise<void>;
}
