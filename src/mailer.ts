import nodemailer from 'nodemailer';
import { Pool } from 'pg';
import { log } from './logger';

export type Mail = { to: string; subject: string; text: string };

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function createSmtpMailer(): Mailer | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'PennyBid <no-reply@localhost>';
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: pass || '' } : undefined,
  });
  return {
    async send(mail) {
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

/** Always stores the message in the admin outbox, then tries SMTP when configured. */
export async function deliverMail(pool: Pool, mailer: Mailer | null, mail: Mail): Promise<void> {
  await pool.query(
    'INSERT INTO mail_outbox (to_email, subject, body, created_at) VALUES ($1, $2, $3, $4)',
    [mail.to, mail.subject, mail.text, Date.now()],
  );
  if (!mailer) return;
  try {
    await mailer.send(mail);
  } catch (err) {
    log('error', 'smtp send failed', { err: err instanceof Error ? err.message : String(err), to: mail.to });
  }
}
