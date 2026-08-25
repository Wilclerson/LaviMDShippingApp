/**
 * Morning audit email rendering.
 *
 * Structure mandated by the spec, in order:
 *   1. Summary counts
 *   2. 🚨 NEEDS ATTENTION
 *   3. 🚨 LABEL CREATED >24 HOURS AGO — NO UPS SCAN   (visually emphasised)
 *   4. ⚠️ LABEL CREATED — WAITING FOR UPS
 *   5. Carrier exceptions
 *   6. A one-line success summary — never dozens of successful rows
 *   7. "Open Shipping Dashboard" button
 *
 * Written as inline-styled tables because that is what email clients render
 * reliably; Outlook in particular ignores <style> blocks and flexbox.
 */

import { env } from '../env';
import { formatAge, formatDateTimeShort, formatLongDate, DISPLAY_TZ } from '../time';
import { WHOLESALE_SOURCE_LABEL, type ShipmentRow } from '../types';
import type { DailyReportData } from '../database/queries';

const COLORS = {
  critical: '#b42318',
  criticalBg: '#fef3f2',
  criticalBorder: '#fda29b',
  warning: '#b54708',
  warningBg: '#fffaeb',
  warningBorder: '#fec84b',
  success: '#027a48',
  successBg: '#ecfdf3',
  text: '#101828',
  muted: '#667085',
  border: '#e4e7ec',
  headerBg: '#f9fafb',
} as const;

/** Escape untrusted values before they enter the HTML body. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wholesale shipments have no internal order number; the spec wants "—". */
export function orderNumberDisplay(shipment: ShipmentRow): string {
  if (shipment.source === 'wholesale_danielle') return '—';
  return shipment.order_number ?? '—';
}

export function sourceDisplay(shipment: ShipmentRow): string {
  if (shipment.source === 'wholesale_danielle') return WHOLESALE_SOURCE_LABEL;
  return shipment.source_store ?? 'ShipStation';
}

function shipmentUrl(shipment: ShipmentRow): string {
  return `${env.appUrl}/shipments/${shipment.id}`;
}

interface SectionOptions {
  heading: string;
  emphasis: 'critical' | 'warning' | 'neutral';
  shipments: ShipmentRow[];
  now: Date;
  emptyText?: string;
}

function renderRow(shipment: ShipmentRow, now: Date, emphasis: SectionOptions['emphasis']): string {
  const cell = `padding:10px 12px;border-bottom:1px solid ${COLORS.border};font-size:13px;color:${COLORS.text};vertical-align:top;`;
  const ageColor = emphasis === 'critical' ? COLORS.critical : COLORS.text;
  const ageWeight = emphasis === 'critical' ? '700' : '400';

  // Short values are kept on one line; only the free-text UPS status wraps.
  return `
    <tr>
      <td style="${cell}white-space:nowrap;">${escapeHtml(shipment.customer_name ?? '—')}</td>
      <td style="${cell}white-space:nowrap;">${escapeHtml(orderNumberDisplay(shipment))}</td>
      <td style="${cell}white-space:nowrap;">${escapeHtml(sourceDisplay(shipment))}</td>
      <td style="${cell}font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
        <a href="${escapeHtml(shipmentUrl(shipment))}" style="color:#175cd3;text-decoration:none;">${escapeHtml(shipment.tracking_number)}</a>
      </td>
      <td style="${cell}white-space:nowrap;">${escapeHtml(formatDateTimeShort(shipment.label_created_at))}</td>
      <td style="${cell}white-space:nowrap;color:${ageColor};font-weight:${ageWeight};">${escapeHtml(formatAge(shipment.label_created_at, now))}</td>
      <td style="${cell}">${escapeHtml(shipment.ups_status ?? shipment.latest_tracking_event ?? 'No UPS data')}</td>
    </tr>`;
}

function renderSection(options: SectionOptions): string {
  const { heading, emphasis, shipments, now } = options;
  if (shipments.length === 0) {
    if (!options.emptyText) return '';
    return `
      <div style="margin:0 0 28px;">
        <h2 style="font-size:15px;margin:0 0 8px;color:${COLORS.text};">${escapeHtml(heading)}</h2>
        <p style="margin:0;font-size:13px;color:${COLORS.muted};">${escapeHtml(options.emptyText)}</p>
      </div>`;
  }

  const palette =
    emphasis === 'critical'
      ? { fg: COLORS.critical, bg: COLORS.criticalBg, border: COLORS.criticalBorder }
      : emphasis === 'warning'
        ? { fg: COLORS.warning, bg: COLORS.warningBg, border: COLORS.warningBorder }
        : { fg: COLORS.text, bg: '#ffffff', border: COLORS.border };

  const headerCell = `padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${COLORS.muted};border-bottom:1px solid ${COLORS.border};font-weight:600;`;

  return `
    <div style="margin:0 0 28px;border:1px solid ${palette.border};border-radius:8px;overflow:hidden;">
      <div style="background:${palette.bg};padding:12px 16px;border-bottom:1px solid ${palette.border};">
        <h2 style="margin:0;font-size:15px;font-weight:700;color:${palette.fg};">
          ${escapeHtml(heading)}
          <span style="font-weight:400;color:${COLORS.muted};">(${shipments.length})</span>
        </h2>
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#ffffff;table-layout:auto;">
        <thead>
          <tr style="background:${COLORS.headerBg};">
            <th style="${headerCell}">Customer</th>
            <th style="${headerCell}">Order #</th>
            <th style="${headerCell}">Source</th>
            <th style="${headerCell}">Tracking #</th>
            <th style="${headerCell}">Label Created</th>
            <th style="${headerCell}">Age</th>
            <th style="${headerCell}">UPS Status</th>
          </tr>
        </thead>
        <tbody>
          ${shipments.map((s) => renderRow(s, now, emphasis)).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderSummaryCard(label: string, value: number, tone: 'critical' | 'warning' | 'success' | 'neutral'): string {
  const color =
    tone === 'critical' ? COLORS.critical : tone === 'warning' ? COLORS.warning : tone === 'success' ? COLORS.success : COLORS.text;
  return `
    <td style="padding:0 8px 0 0;width:25%;vertical-align:top;">
      <div style="border:1px solid ${COLORS.border};border-radius:8px;padding:12px 14px;background:#ffffff;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${COLORS.muted};margin-bottom:4px;">${escapeHtml(label)}</div>
        <div style="font-size:26px;font-weight:700;color:${color};line-height:1;">${value}</div>
      </div>
    </td>`;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderDailyReport(data: DailyReportData, now: Date = new Date()): RenderedEmail {
  const subject = `Lavi MD Shipping Audit — ${formatLongDate(now)}`;
  const dashboardUrl = env.appUrl;

  const confirmedUrl = `${dashboardUrl}/?filter=confirmed_shipped`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${COLORS.text};">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f2f4f7;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:840px;background:#ffffff;border-radius:12px;padding:28px;border:1px solid ${COLORS.border};">
          <tr><td>

            <h1 style="margin:0 0 4px;font-size:20px;font-weight:700;">Lavi MD Shipping Audit</h1>
            <p style="margin:0 0 20px;font-size:13px;color:${COLORS.muted};">
              ${escapeHtml(formatLongDate(now))} &middot; all times ${escapeHtml(DISPLAY_TZ.replace('_', ' '))}
            </p>

            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
              <tr>
                ${renderSummaryCard('Confirmed Shipped', data.confirmedCount, 'success')}
                ${renderSummaryCard('Needs Attention', data.needsAttentionCount, data.needsAttentionCount > 0 ? 'critical' : 'success')}
                ${renderSummaryCard('Labels >24 Hours', data.agingLabels.length, data.agingLabels.length > 0 ? 'critical' : 'success')}
                ${renderSummaryCard('Carrier Exceptions', data.exceptions.length, data.exceptions.length > 0 ? 'critical' : 'success')}
              </tr>
            </table>

            ${
              data.needsAttentionCount === 0
                ? `<div style="background:${COLORS.successBg};border:1px solid #a6f4c5;border-radius:8px;padding:16px;margin:0 0 24px;">
                     <p style="margin:0;font-size:14px;color:${COLORS.success};font-weight:600;">
                       ✅ Nothing needs attention. Every label has a confirmed UPS possession scan.
                     </p>
                   </div>`
                : `<h2 style="margin:0 0 16px;font-size:16px;font-weight:700;color:${COLORS.critical};">🚨 NEEDS ATTENTION</h2>`
            }

            ${renderSection({
              heading: '🚨 LABEL CREATED >24 HOURS AGO — NO UPS SCAN',
              emphasis: 'critical',
              shipments: data.agingLabels,
              now,
            })}

            ${renderSection({
              heading: '⚠️ LABEL CREATED — WAITING FOR UPS',
              emphasis: 'warning',
              shipments: data.labelCreatedRecent,
              now,
            })}

            ${renderSection({
              heading: '🚨 CARRIER EXCEPTIONS',
              emphasis: 'critical',
              shipments: data.exceptions,
              now,
            })}

            <div style="border-top:1px solid ${COLORS.border};padding-top:20px;margin-top:4px;">
              <p style="margin:0 0 6px;font-size:14px;color:${COLORS.success};font-weight:600;">
                ✅ ${data.confirmedCount} shipment${data.confirmedCount === 1 ? '' : 's'} confirmed with UPS
              </p>
              <p style="margin:0 0 20px;font-size:13px;">
                <a href="${escapeHtml(confirmedUrl)}" style="color:#175cd3;text-decoration:none;">View all confirmed shipments &rarr;</a>
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#175cd3;border-radius:8px;">
                    <a href="${escapeHtml(dashboardUrl)}"
                       style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">
                      Open Shipping Dashboard
                    </a>
                  </td>
                </tr>
              </table>
            </div>

            <p style="margin:24px 0 0;font-size:11px;color:${COLORS.muted};line-height:1.6;">
              A shipping label being created does not mean the package shipped. A shipment is only
              reported as confirmed once UPS records a physical possession scan.
            </p>

          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = renderPlainText(data, now, subject);
  return { subject, html, text };
}

function textRow(shipment: ShipmentRow, now: Date): string {
  return [
    `  - ${shipment.customer_name ?? '—'}`,
    `    Order: ${orderNumberDisplay(shipment)}`,
    `    Source: ${sourceDisplay(shipment)}`,
    `    Tracking: ${shipment.tracking_number}`,
    `    Label created: ${formatDateTimeShort(shipment.label_created_at)} (${formatAge(shipment.label_created_at, now)} ago)`,
    `    UPS status: ${shipment.ups_status ?? shipment.latest_tracking_event ?? 'No UPS data'}`,
  ].join('\n');
}

function renderPlainText(data: DailyReportData, now: Date, subject: string): string {
  const lines: string[] = [
    subject,
    '='.repeat(subject.length),
    '',
    `Confirmed Shipped: ${data.confirmedCount}`,
    `Needs Attention: ${data.needsAttentionCount}`,
    `Labels >24 Hours Without Scan: ${data.agingLabels.length}`,
    `Carrier Exceptions: ${data.exceptions.length}`,
    '',
  ];

  if (data.needsAttentionCount === 0) {
    lines.push('Nothing needs attention. Every label has a confirmed UPS possession scan.', '');
  } else {
    lines.push('*** NEEDS ATTENTION ***', '');
  }

  if (data.agingLabels.length > 0) {
    lines.push(`LABEL CREATED >24 HOURS AGO — NO UPS SCAN (${data.agingLabels.length})`, '');
    lines.push(...data.agingLabels.map((s) => textRow(s, now)), '');
  }

  if (data.labelCreatedRecent.length > 0) {
    lines.push(`LABEL CREATED — WAITING FOR UPS (${data.labelCreatedRecent.length})`, '');
    lines.push(...data.labelCreatedRecent.map((s) => textRow(s, now)), '');
  }

  if (data.exceptions.length > 0) {
    lines.push(`CARRIER EXCEPTIONS (${data.exceptions.length})`, '');
    lines.push(...data.exceptions.map((s) => textRow(s, now)), '');
  }

  lines.push(
    `${data.confirmedCount} shipment${data.confirmedCount === 1 ? '' : 's'} confirmed with UPS.`,
    `View all confirmed shipments: ${env.appUrl}/?filter=confirmed_shipped`,
    '',
    `Open Shipping Dashboard: ${env.appUrl}`,
    '',
    'A shipping label being created does not mean the package shipped. A shipment is only',
    'reported as confirmed once UPS records a physical possession scan.',
  );

  return lines.join('\n');
}
