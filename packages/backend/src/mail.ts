import nodemailer, { Transporter } from 'nodemailer';

/**
 * Outgoing email. Only invitations use it for now.
 *
 * Mail is optional: without SMTP_URL every send is a no-op that reports
 * `enabled: false`, and the Studio keeps showing invite links to copy. When
 * it is configured, a failed send never fails the request that triggered it:
 * callers get `false` back, log it, and still return the link (fail silent,
 * never fail closed — an invitation that exists but wasn't mailed is strictly
 * better than no invitation).
 *
 *   SMTP_URL    smtp://user:pass@host:587, smtps://… (TLS), or json:// — a
 *               development/test transport that logs the message as JSON
 *               instead of sending it (and keeps it in `jsonOutbox`).
 *   MAIL_FROM   the From header, e.g. "Guide Engine <no-reply@example.com>".
 *   STUDIO_URL  the Studio's public origin, used to build links in emails.
 */
export interface MailConfig {
  /** Null when mail is off. */
  smtpUrl: string | null;
  from: string | null;
  /** Public Studio origin without a trailing slash, or null when not configured. */
  studioUrl: string | null;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  readonly enabled: boolean;
  /** Resolves true when the message was handed to the transport, false on any failure (logged). */
  send(message: MailMessage): Promise<boolean>;
}

const SMTP_SCHEMES = /^(smtp|smtps|json):\/\//;

/**
 * Validated once at boot (createApp) so a typo in SMTP_URL stops the process
 * instead of silently never sending invitations.
 */
export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const smtpUrl = env.SMTP_URL || null;
  const from = env.MAIL_FROM || null;
  if (smtpUrl && !SMTP_SCHEMES.test(smtpUrl)) {
    throw new Error('SMTP_URL must start with smtp://, smtps:// or json:// (development only).');
  }
  if (smtpUrl && !from) throw new Error('MAIL_FROM is required when SMTP_URL is set.');

  let studioUrl: string | null = null;
  if (env.STUDIO_URL) {
    let parsed: URL;
    try {
      parsed = new URL(env.STUDIO_URL);
    } catch {
      throw new Error('STUDIO_URL must be a URL, e.g. https://studio.example.com');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('STUDIO_URL must be an http(s) URL.');
    // Origin only: links are built as `${STUDIO_URL}/invite/<token>`.
    studioUrl = parsed.origin;
  }
  return { smtpUrl, from, studioUrl };
}

/**
 * Messages "sent" through the json:// transport, newest last (bounded).
 * For tests and local development only; a real transport keeps nothing.
 */
export const jsonOutbox: Array<MailMessage & { from: string }> = [];
const JSON_OUTBOX_MAX = 50;

const disabledMailer: Mailer = {
  enabled: false,
  send: async () => false,
};

function createMailer(config: MailConfig): Mailer {
  if (!config.smtpUrl || !config.from) return disabledMailer;
  const from = config.from;
  if (config.smtpUrl.startsWith('json://')) {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    return {
      enabled: true,
      async send(message) {
        const info = await transport.sendMail({ from, ...message });
        jsonOutbox.push({ from, ...message });
        if (jsonOutbox.length > JSON_OUTBOX_MAX) jsonOutbox.shift();
        console.log(`[mail json] ${info.message}`);
        return true;
      },
    };
  }
  const transport: Transporter = nodemailer.createTransport(config.smtpUrl);
  return {
    enabled: true,
    async send(message) {
      try {
        await transport.sendMail({ from, ...message });
        return true;
      } catch (err) {
        // The caller's request must succeed regardless; it reports emailSent: false.
        console.error(`mail: could not send "${message.subject}" to ${message.to}:`, err);
        return false;
      }
    },
  };
}

let cached: { key: string; mailer: Mailer } | null = null;

/**
 * The process-wide mailer. Built lazily from the environment and rebuilt if
 * the mail variables change (tests flip SMTP_URL between cases).
 */
export function getMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const config = loadMailConfig(env);
  const key = `${config.smtpUrl ?? ''}|${config.from ?? ''}`;
  if (!cached || cached.key !== key) cached = { key, mailer: createMailer(config) };
  return cached.mailer;
}

/** True when invitations can actually be emailed: a transport AND a Studio origin for the link. */
export function invitationMailAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = loadMailConfig(env);
  return Boolean(config.smtpUrl && config.from && config.studioUrl);
}

/** HTML-escapes text interpolated into an email body (names and org names are user input). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface InvitationMailInput {
  to: string;
  /** Display name (or email) of the admin who sent the invitation. */
  inviterName: string;
  orgName: string;
  /** Full invite link, `${STUDIO_URL}/invite/<token>`. */
  link: string;
  expiresInDays: number;
}

/** The invitation email: plain text plus a minimal HTML alternative. */
export function invitationMail(input: InvitationMailInput): MailMessage {
  const { to, inviterName, orgName, link, expiresInDays } = input;
  const subject = `${inviterName} invited you to ${orgName} on Guide Studio`;
  const text = [
    `${inviterName} invited you to ${orgName} on Guide Studio.`,
    '',
    'Open this link to accept the invitation:',
    link,
    '',
    `It expires in ${expiresInDays} days and can be used once. If you weren't expecting this, you can ignore this email.`,
  ].join('\n');
  const html = [
    '<!doctype html><html><body style="font-family: system-ui, sans-serif; line-height: 1.5">',
    `<p>${escapeHtml(inviterName)} invited you to <strong>${escapeHtml(orgName)}</strong> on Guide Studio.</p>`,
    `<p><a href="${escapeHtml(link)}">Accept the invitation</a></p>`,
    `<p style="color: #666; font-size: 13px">Or paste this link into your browser:<br>${escapeHtml(link)}</p>`,
    `<p style="color: #666; font-size: 13px">It expires in ${expiresInDays} days and can be used once. If you weren't expecting this, you can ignore this email.</p>`,
    '</body></html>',
  ].join('\n');
  return { to, subject, text, html };
}
