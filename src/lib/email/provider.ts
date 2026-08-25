/**
 * Email delivery.
 *
 * Provider-agnostic so the operator can pick whatever they already pay for.
 * Selected with EMAIL_PROVIDER; the API key never leaves the server.
 *
 *   resend   — POST https://api.resend.com/emails
 *   sendgrid — POST https://api.sendgrid.com/v3/mail/send
 *   postmark — POST https://api.postmarkapp.com/email
 *   smtp     — direct SMTP (requires the optional `nodemailer` dependency)
 *   console  — writes the message to the log; the default for local dev
 */

import { env } from '../env';
import { logger } from '../logger';
import { request } from '../http/fetch';

const log = logger.child({ component: 'email' });

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  provider: string;
  messageId: string | null;
  error?: string;
}

function fromHeader(): string {
  return env.email.fromName ? `${env.email.fromName} <${env.email.from}>` : env.email.from;
}

async function sendViaResend(message: EmailMessage): Promise<SendResult> {
  const { data } = await request<{ id?: string }>('https://api.resend.com/emails', {
    method: 'POST',
    label: 'resend',
    headers: { Authorization: `Bearer ${env.email.apiKey ?? ''}` },
    body: {
      from: fromHeader(),
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    },
  });
  return { ok: true, provider: 'resend', messageId: data?.id ?? null };
}

async function sendViaSendgrid(message: EmailMessage): Promise<SendResult> {
  const { headers } = await request<unknown>('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    label: 'sendgrid',
    headers: { Authorization: `Bearer ${env.email.apiKey ?? ''}` },
    body: {
      personalizations: [{ to: message.to.map((email) => ({ email })) }],
      from: { email: env.email.from, name: env.email.fromName },
      subject: message.subject,
      content: [
        { type: 'text/plain', value: message.text },
        { type: 'text/html', value: message.html },
      ],
    },
    // SendGrid answers 202 with an empty body on success.
    acceptStatuses: [202],
  });
  return { ok: true, provider: 'sendgrid', messageId: headers.get('x-message-id') };
}

async function sendViaPostmark(message: EmailMessage): Promise<SendResult> {
  const { data } = await request<{ MessageID?: string }>('https://api.postmarkapp.com/email', {
    method: 'POST',
    label: 'postmark',
    headers: { 'X-Postmark-Server-Token': env.email.apiKey ?? '' },
    body: {
      From: fromHeader(),
      To: message.to.join(','),
      Subject: message.subject,
      HtmlBody: message.html,
      TextBody: message.text,
      MessageStream: 'outbound',
    },
  });
  return { ok: true, provider: 'postmark', messageId: data?.MessageID ?? null };
}

async function sendViaSmtp(message: EmailMessage): Promise<SendResult> {
  // nodemailer is an optional dependency: only SMTP users need to install it.
  // Typed structurally rather than by import so the package's absence is not a
  // compile error for the HTTP-provider users who never install it.
  interface MailTransport {
    sendMail(options: Record<string, unknown>): Promise<{ messageId?: string }>;
  }
  interface NodemailerModule {
    createTransport(options: Record<string, unknown>): MailTransport;
  }

  let nodemailer: NodemailerModule;
  try {
    const specifier = 'nodemailer';
    nodemailer = (await import(/* webpackIgnore: true */ specifier)) as unknown as NodemailerModule;
  } catch {
    throw new Error(
      'EMAIL_PROVIDER=smtp requires the "nodemailer" package. Run `npm install nodemailer` or choose an HTTP provider.',
    );
  }

  const transport = nodemailer.createTransport({
    host: env.email.smtp.host ?? '',
    port: env.email.smtp.port,
    secure: env.email.smtp.port === 465,
    auth:
      env.email.smtp.user && env.email.smtp.password
        ? { user: env.email.smtp.user, pass: env.email.smtp.password }
        : undefined,
  });

  const info = await transport.sendMail({
    from: fromHeader(),
    to: message.to.join(','),
    subject: message.subject,
    html: message.html,
    text: message.text,
  });

  return { ok: true, provider: 'smtp', messageId: info.messageId ?? null };
}

function sendViaConsole(message: EmailMessage): SendResult {
  log.info('email (console provider — not actually delivered)', {
    to: message.to,
    subject: message.subject,
    textPreview: message.text.slice(0, 800),
  });
  return { ok: true, provider: 'console', messageId: null };
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  if (message.to.length === 0) {
    return { ok: false, provider: env.email.provider, messageId: null, error: 'No recipients configured (EMAIL_RECIPIENTS).' };
  }

  const provider = env.email.provider;
  const needsKey = ['resend', 'sendgrid', 'postmark'].includes(provider);
  if (needsKey && !env.email.apiKey) {
    return {
      ok: false,
      provider,
      messageId: null,
      error: `EMAIL_PROVIDER=${provider} requires EMAIL_PROVIDER_API_KEY.`,
    };
  }

  try {
    switch (provider) {
      case 'resend':
        return await sendViaResend(message);
      case 'sendgrid':
        return await sendViaSendgrid(message);
      case 'postmark':
        return await sendViaPostmark(message);
      case 'smtp':
        return await sendViaSmtp(message);
      case 'console':
        return sendViaConsole(message);
      default:
        return {
          ok: false,
          provider,
          messageId: null,
          error: `Unknown EMAIL_PROVIDER "${provider}". Use resend, sendgrid, postmark, smtp or console.`,
        };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('email delivery failed', { provider, error: err });
    return { ok: false, provider, messageId: null, error };
  }
}
