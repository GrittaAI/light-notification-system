import nodemailer from 'nodemailer';
import type { Env } from './config.js';

export interface Alerts {
  /** Emails ALERT_EMAIL_TO. Throws if the SMTP send fails. */
  send(subject: string, text: string): Promise<void>;
}

type AlertEnv = Pick<Env, 'ALERT_EMAIL_TO' | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS'>;

export function createAlerts(env: AlertEnv): Alerts {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465, // 465 = implicit TLS; 587 upgrades with STARTTLS
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(subject, text) {
      await transport.sendMail({
        from: env.SMTP_USER,
        to: env.ALERT_EMAIL_TO,
        subject: `[pushup-reminders] ${subject}`,
        text,
      });
    },
  };
}
