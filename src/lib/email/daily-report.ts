/**
 * The 8:00 AM America/New_York shipping audit email.
 *
 * The spec requires the report to query our own database *after* a fresh sync
 * has happened, so the caller (the cron route) runs a sync first and passes the
 * result through. Delivery is recorded in email_deliveries either way, and a
 * duplicate send for the same report date is refused unless explicitly forced.
 */

import { env } from '../env';
import { logger } from '../logger';
import { query, queryOne } from '../database/pool';
import { getDailyReportData } from '../database/queries';
import { toLocalDateKey, localHourToUtc } from '../time';
import { renderDailyReport } from './render';
import { sendEmail } from './provider';

const log = logger.child({ component: 'daily-report' });

export interface DailyReportResult {
  sent: boolean;
  skipped: boolean;
  reason?: string;
  subject?: string;
  recipients: string[];
  summary: {
    confirmed: number;
    needsAttention: number;
    agingLabels: number;
    exceptions: number;
  };
}

export interface SendDailyReportOptions {
  /** Send even if a report has already gone out for this date. */
  force?: boolean;
  /** Override "now" — used by tests and by manual re-sends. */
  now?: Date;
  /** Send to these addresses instead of EMAIL_RECIPIENTS (preview/test sends). */
  overrideRecipients?: string[];
}

export async function sendDailyReport(
  options: SendDailyReportOptions = {},
): Promise<DailyReportResult> {
  const now = options.now ?? new Date();
  const reportDate = toLocalDateKey(now);
  const recipients = options.overrideRecipients ?? env.email.recipients;

  // The window covers the 24 hours since yesterday's 8 AM report, so the
  // success count reflects "what shipped since you last heard from me".
  const windowStart = new Date(localHourToUtc(now, 8).getTime() - 24 * 3_600_000);

  const data = await getDailyReportData(windowStart);
  const summary = {
    confirmed: data.confirmedCount,
    needsAttention: data.needsAttentionCount,
    agingLabels: data.agingLabels.length,
    exceptions: data.exceptions.length,
  };

  if (recipients.length === 0) {
    const reason = 'No recipients configured. Set EMAIL_RECIPIENTS.';
    log.warn(reason);
    await recordDelivery({ reportDate, status: 'skipped', recipients, error: reason, summary });
    return { sent: false, skipped: true, reason, recipients, summary };
  }

  if (!options.force) {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM email_deliveries
        WHERE report_date = $1 AND kind = 'daily_audit' AND status = 'sent'
        LIMIT 1`,
      [reportDate],
    );
    if (existing) {
      const reason = `A report has already been sent for ${reportDate}.`;
      log.info('daily report already sent; skipping', { reportDate });
      return { sent: false, skipped: true, reason, recipients, summary };
    }
  }

  const { subject, html, text } = renderDailyReport(data, now);
  const result = await sendEmail({ to: recipients, subject, html, text });

  await recordDelivery({
    reportDate,
    status: result.ok ? 'sent' : 'failed',
    recipients,
    subject,
    provider: result.provider,
    providerMessageId: result.messageId,
    error: result.error,
    summary,
  });

  if (!result.ok) {
    log.error('daily report delivery failed', { error: result.error, provider: result.provider });
    await query('INSERT INTO error_log (scope, message, detail) VALUES ($1, $2, $3)', [
      'email',
      `Daily report failed: ${result.error ?? 'unknown error'}`,
      JSON.stringify({ reportDate, provider: result.provider }),
    ]);
    return { sent: false, skipped: false, reason: result.error, subject, recipients, summary };
  }

  log.info('daily report sent', { reportDate, recipients: recipients.length, ...summary });
  return { sent: true, skipped: false, subject, recipients, summary };
}

async function recordDelivery(entry: {
  reportDate: string;
  status: 'sent' | 'failed' | 'skipped';
  recipients: string[];
  subject?: string;
  provider?: string;
  providerMessageId?: string | null;
  error?: string;
  summary: Record<string, number>;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO email_deliveries
         (report_date, kind, status, recipients, subject, provider, provider_message_id, error_message, summary)
       VALUES ($1, 'daily_audit', $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.reportDate,
        entry.status,
        entry.recipients,
        entry.subject ?? null,
        entry.provider ?? null,
        entry.providerMessageId ?? null,
        entry.error ?? null,
        JSON.stringify(entry.summary),
      ],
    );
  } catch (err) {
    log.error('failed to record email delivery', { error: err });
  }
}

export async function getRecentDeliveries(limit = 14) {
  return query<{
    report_date: string;
    status: string;
    subject: string | null;
    error_message: string | null;
    created_at: Date;
  }>(
    `SELECT report_date::text, status, subject, error_message, created_at
       FROM email_deliveries
      WHERE kind = 'daily_audit'
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
}
