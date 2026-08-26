/**
 * Morning audit email rendering — Lavi MD / Chayim Therapeutics branded.
 *
 * Structure, in order:
 *   1. Branded header (typography only — no remote logo)
 *   2. Summary metric cards, with Needs Attention visually dominant
 *   3. 🚨 Labels >24 Hours — No UPS Scan
 *   4. ⚠️ Label Created — Waiting for UPS
 *   5. 🚨 Carrier Exceptions
 *   6. A one-line success summary — never dozens of successful rows
 *   7. "Open Shipping Dashboard" button
 *
 * EMAIL-CLIENT CONSTRAINTS
 * ------------------------
 * Layout is table-based with inline styles because that is what renders
 * reliably. Outlook (Word engine) ignores <style> blocks, media queries,
 * flexbox, grid and border-radius, so every one of those is used only for
 * progressive enhancement and the design degrades to a clean square-cornered
 * table there.
 *
 * Shipment lists are rendered TWICE: a column table for wide screens and
 * stacked cards for narrow ones, toggled by a media query. Squeezing seven
 * columns onto a phone is unreadable, and hiding columns would hide the very
 * facts the fulfillment team needs.
 *
 * Poppins is requested via a webfont link that Outlook is explicitly told to
 * skip; every client that cannot load it falls back to Arial/Helvetica, which
 * the whole design is spaced to tolerate.
 */

import { env } from '../env';
import { formatAge, formatDateTimeShort, formatLongDate, DISPLAY_TZ } from '../time';
import { WHOLESALE_SOURCE_LABEL, type ShipmentRow } from '../types';
import type { DailyReportData } from '../database/queries';

/**
 * Lavi MD / Chayim Therapeutics palette.
 * Colour carries meaning here and is not decorative: red is reserved for
 * problems, amber for waiting, green for confirmed success. Gold is brand
 * accent only and never signals status.
 */
const C = {
  navy: '#12233F',
  navyDeep: '#0B1729',
  navySoft: '#2B4066',
  gold: '#B08D57',
  goldLight: '#C9A961',
  goldBg: '#FBF7F0',
  page: '#FAF8F5',
  card: '#FFFFFF',
  border: '#E7E2D9',
  borderSoft: '#F0ECE4',
  text: '#12233F',
  muted: '#77706A',
  critical: '#B3261E',
  criticalBg: '#FDF4F3',
  criticalBorder: '#EFB8B3',
  warning: '#A26A00',
  warningBg: '#FFFAEE',
  warningBorder: '#EFCE8A',
  success: '#1E7A46',
  successBg: '#F0F8F3',
  successBorder: '#B8DFC8',
} as const;

const FONT = `'Poppins',Arial,Helvetica,sans-serif`;
const MONO = `'SFMono-Regular',Consolas,Menlo,monospace`;

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

function upsStatusOf(shipment: ShipmentRow): string {
  return shipment.ups_status ?? shipment.latest_tracking_event ?? 'No UPS data';
}

type Emphasis = 'critical' | 'warning' | 'neutral';

function palette(emphasis: Emphasis) {
  if (emphasis === 'critical') return { fg: C.critical, bg: C.criticalBg, border: C.criticalBorder };
  if (emphasis === 'warning') return { fg: C.warning, bg: C.warningBg, border: C.warningBorder };
  return { fg: C.navy, bg: C.card, border: C.border };
}

// --- summary metrics ----------------------------------------------------------

type Tone = 'critical' | 'warning' | 'success' | 'neutral';

function toneColor(tone: Tone): string {
  if (tone === 'critical') return C.critical;
  if (tone === 'warning') return C.warning;
  if (tone === 'success') return C.success;
  return C.navy;
}

/** One of the six smaller metric tiles. */
function metricCard(label: string, value: number, tone: Tone): string {
  return `<td class="stack" width="33.33%" style="padding:0 6px 12px 6px;vertical-align:top;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;">
    <tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:10px;padding:14px 16px;text-align:center;">
      <div style="font-family:${FONT};font-size:26px;line-height:1.1;font-weight:700;color:${toneColor(tone)};">${value}</div>
      <div style="font-family:${FONT};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};padding-top:6px;">${escapeHtml(label)}</div>
    </td></tr>
  </table>
</td>`;
}

/** The dominant Needs Attention banner. Red when there is work, green when clear. */
function attentionBanner(count: number): string {
  const clear = count === 0;
  const fg = clear ? C.success : C.critical;
  const bg = clear ? C.successBg : C.criticalBg;
  const bd = clear ? C.successBorder : C.criticalBorder;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;margin:0 0 12px;">
  <tr><td style="background:${bg};border:2px solid ${bd};border-radius:12px;padding:20px 24px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td class="stack" style="vertical-align:middle;text-align:left;">
          <div style="font-family:${FONT};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${fg};font-weight:600;">NEEDS ATTENTION</div>
          <div style="font-family:${FONT};font-size:13px;color:${C.muted};padding-top:4px;">
            ${clear ? 'Every label has a confirmed UPS possession scan.' : 'Labels without confirmed UPS possession, or with a carrier problem.'}
          </div>
        </td>
        <td class="stack" style="vertical-align:middle;text-align:right;white-space:nowrap;">
          <div style="font-family:${FONT};font-size:46px;line-height:1;font-weight:700;color:${fg};">${clear ? '✅' : count}</div>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;
}

// --- shipment rendering -------------------------------------------------------

interface SectionOptions {
  heading: string;
  emphasis: Emphasis;
  shipments: ShipmentRow[];
  now: Date;
}

/** Wide-screen table row. */
function tableRow(shipment: ShipmentRow, now: Date, emphasis: Emphasis): string {
  const cell = `padding:11px 12px;border-bottom:1px solid ${C.borderSoft};font-family:${FONT};font-size:13px;color:${C.text};vertical-align:top;`;
  const p = palette(emphasis);
  const ageWeight = emphasis === 'critical' ? '700' : '600';
  return `<tr>
<td style="${cell}white-space:nowrap;font-weight:600;">${escapeHtml(shipment.customer_name ?? '—')}</td>
<td style="${cell}white-space:nowrap;color:${C.muted};">${escapeHtml(orderNumberDisplay(shipment))}</td>
<td style="${cell}white-space:nowrap;color:${C.muted};">${escapeHtml(sourceDisplay(shipment))}</td>
<td style="${cell}font-family:${MONO};font-size:12px;"><a href="${escapeHtml(shipmentUrl(shipment))}" style="color:${C.navySoft};text-decoration:none;border-bottom:1px solid ${C.goldLight};">${escapeHtml(shipment.tracking_number)}</a></td>
<td style="${cell}white-space:nowrap;color:${C.muted};">${escapeHtml(formatDateTimeShort(shipment.label_created_at))}</td>
<td style="${cell}white-space:nowrap;color:${p.fg};font-weight:${ageWeight};">${escapeHtml(formatAge(shipment.label_created_at, now))}</td>
<td style="${cell}">${escapeHtml(upsStatusOf(shipment))}</td>
</tr>`;
}

/** Narrow-screen stacked card for the same shipment. */
function stackedCard(shipment: ShipmentRow, now: Date, emphasis: Emphasis): string {
  const p = palette(emphasis);
  const line = (label: string, value: string, extra = '') =>
    `<tr><td style="font-family:${FONT};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};padding:6px 0 0;width:38%;">${escapeHtml(label)}</td>
<td style="font-family:${FONT};font-size:13px;color:${C.text};padding:6px 0 0;${extra}">${value}</td></tr>`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${p.border};border-radius:10px;background:${C.card};margin:0 0 10px;">
  <tr><td style="padding:14px 16px;">
    <div style="font-family:${FONT};font-size:15px;font-weight:700;color:${C.navy};">${escapeHtml(shipment.customer_name ?? '—')}</div>
    <div style="font-family:${FONT};font-size:12px;color:${p.fg};font-weight:600;padding-top:2px;">${escapeHtml(formatAge(shipment.label_created_at, now))} waiting</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px;">
      ${line('Order #', escapeHtml(orderNumberDisplay(shipment)))}
      ${line('Source', escapeHtml(sourceDisplay(shipment)))}
      ${line('Tracking', `<a href="${escapeHtml(shipmentUrl(shipment))}" style="color:${C.navySoft};text-decoration:none;font-family:${MONO};font-size:12px;">${escapeHtml(shipment.tracking_number)}</a>`)}
      ${line('Label created', escapeHtml(formatDateTimeShort(shipment.label_created_at)))}
      ${line('UPS status', escapeHtml(upsStatusOf(shipment)))}
    </table>
  </td></tr>
</table>`;
}

function renderSection(options: SectionOptions): string {
  const { heading, emphasis, shipments, now } = options;
  if (shipments.length === 0) return '';
  const p = palette(emphasis);
  const headerCell = `padding:9px 12px;text-align:left;font-family:${FONT};font-size:10px;text-transform:uppercase;letter-spacing:0.07em;color:${C.muted};border-bottom:1px solid ${C.border};font-weight:600;`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;margin:0 0 24px;">
  <tr><td style="border:1px solid ${p.border};border-radius:12px;overflow:hidden;background:${C.card};">

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr><td style="background:${p.bg};border-bottom:1px solid ${p.border};padding:14px 18px;">
        <span style="font-family:${FONT};font-size:14px;font-weight:700;color:${p.fg};letter-spacing:0.01em;">${escapeHtml(heading)}</span>
        <span style="font-family:${FONT};font-size:13px;font-weight:600;color:${p.fg};opacity:0.75;">&nbsp;(${shipments.length})</span>
      </td></tr>
    </table>

    <!-- wide screens -->
    <div class="desk">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <thead><tr style="background:${C.goldBg};">
          <th style="${headerCell}">Customer</th>
          <th style="${headerCell}">Order #</th>
          <th style="${headerCell}">Source</th>
          <th style="${headerCell}">Tracking #</th>
          <th style="${headerCell}">Label Created</th>
          <th style="${headerCell}">Age</th>
          <th style="${headerCell}">UPS Status</th>
        </tr></thead>
        <tbody>${shipments.map((s) => tableRow(s, now, emphasis)).join('')}</tbody>
      </table>
    </div>

    <!-- narrow screens -->
    <div class="mob" style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden;mso-hide:all;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:12px;">
        ${shipments.map((s) => stackedCard(s, now, emphasis)).join('')}
      </td></tr></table>
    </div>

  </td></tr>
</table>`;
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
  const plural = data.confirmedCount === 1 ? '' : 's';

  const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
<!--[if !mso]><!-->
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<!--<![endif]-->
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<![endif]-->
<style>
  body { margin:0; padding:0; width:100% !important; }
  img { border:0; line-height:100%; outline:none; text-decoration:none; }
  table { border-collapse:collapse; }
  a { color:${C.navySoft}; }
  @media only screen and (max-width:620px) {
    .wrap { width:100% !important; padding:12px !important; }
    .pad { padding:20px 16px !important; }
    .desk { display:none !important; max-height:0 !important; overflow:hidden !important; }
    .mob { display:block !important; font-size:14px !important; line-height:normal !important; max-height:none !important; overflow:visible !important; }
    .stack { display:block !important; width:100% !important; text-align:left !important; padding:0 0 10px 0 !important; }
    .hdr-title { font-size:26px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;font-size:0;line-height:0;max-height:0;overflow:hidden;mso-hide:all;">
  ${data.needsAttentionCount} need attention &middot; ${data.confirmedCount} scanned into UPS possession &middot; ${data.agingLabels.length} over 24 hours
</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.page};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="720" class="wrap" style="width:720px;max-width:720px;">

  <!-- ============ branded header ============ -->
  <tr><td style="background:${C.navy};border-radius:14px 14px 0 0;padding:30px 32px 26px;border-bottom:3px solid ${C.gold};">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr><td>
        <div style="font-family:${FONT};font-size:12px;letter-spacing:0.34em;text-transform:uppercase;color:${C.goldLight};font-weight:600;">Lavi MD</div>
        <div class="hdr-title" style="font-family:${FONT};font-size:31px;line-height:1.15;font-weight:700;color:#FFFFFF;padding-top:6px;">Shipping Audit</div>
        <div style="font-family:${FONT};font-size:12px;color:#AFBACB;padding-top:8px;letter-spacing:0.02em;">Chayim Therapeutics Fulfillment Operations</div>
        <div style="border-top:1px solid rgba(201,169,97,0.32);margin:16px 0 0;padding-top:12px;font-family:${FONT};font-size:12px;color:#8FA0B8;">
          ${escapeHtml(formatLongDate(now))} &nbsp;&middot;&nbsp; all times ${escapeHtml(DISPLAY_TZ.replace('_', ' '))}
        </div>
      </td></tr>
    </table>
  </td></tr>

  <!-- ============ body ============ -->
  <tr><td class="pad" style="background:${C.card};padding:28px 32px 8px;">

    ${attentionBanner(data.needsAttentionCount)}

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 4px;">
      <tr>
        ${metricCard('Total Monitored', data.totalActive, 'neutral')}
        ${metricCard('Confirmed Shipped', data.confirmedCount, 'success')}
        ${metricCard('In Transit', data.inTransitCount, 'neutral')}
      </tr>
      <tr>
        ${metricCard('Delivered', data.deliveredCount, 'success')}
        ${metricCard('Labels >24 Hours', data.agingLabels.length, data.agingLabels.length > 0 ? 'critical' : 'success')}
        ${metricCard('Carrier Exceptions', data.exceptions.length, data.exceptions.length > 0 ? 'critical' : 'success')}
      </tr>
    </table>

  </td></tr>

  <tr><td class="pad" style="background:${C.card};padding:14px 32px 0;">
    ${
      data.needsAttentionCount === 0
        ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
             <tr><td style="background:${C.successBg};border:1px solid ${C.successBorder};border-radius:12px;padding:22px 24px;text-align:center;">
               <div style="font-family:${FONT};font-size:15px;font-weight:600;color:${C.success};">Nothing needs attention this morning.</div>
               <div style="font-family:${FONT};font-size:13px;color:${C.muted};padding-top:6px;">Every label has a confirmed UPS possession scan.</div>
             </td></tr>
           </table>`
        : ''
    }

    ${renderSection({ heading: '🚨 Labels >24 Hours — No UPS Scan', emphasis: 'critical', shipments: data.agingLabels, now })}
    ${renderSection({ heading: '⚠️ Label Created — Waiting for UPS', emphasis: 'warning', shipments: data.labelCreatedRecent, now })}
    ${renderSection({ heading: '🚨 Carrier Exceptions', emphasis: 'critical', shipments: data.exceptions, now })}

    <!-- ============ success summary — count only, never a list ============ -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 26px;">
      <tr><td style="background:${C.successBg};border:1px solid ${C.successBorder};border-radius:12px;padding:18px 22px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td class="stack" style="vertical-align:middle;">
              <div style="font-family:${FONT};font-size:15px;font-weight:600;color:${C.success};">${data.confirmedCount} shipment${plural} confirmed with UPS</div>
              <div style="font-family:${FONT};font-size:12px;color:${C.muted};padding-top:4px;">Physically scanned into UPS possession. Not listed here by design.</div>
            </td>
            <td class="stack" style="vertical-align:middle;text-align:right;white-space:nowrap;">
              <a href="${escapeHtml(confirmedUrl)}" style="font-family:${FONT};font-size:13px;font-weight:600;color:${C.success};text-decoration:none;border-bottom:1px solid ${C.successBorder};">View all confirmed shipments &rarr;</a>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>

    <!-- ============ CTA ============ -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 30px;">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr><td align="center" bgcolor="${C.navy}" style="border-radius:10px;">
            <a href="${dashboardUrl}" style="display:inline-block;padding:15px 40px;font-family:${FONT};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;letter-spacing:0.02em;">Open Shipping Dashboard</a>
          </td></tr>
        </table>
      </td></tr>
    </table>

  </td></tr>

  <!-- ============ footer ============ -->
  <tr><td style="background:${C.goldBg};border-top:1px solid ${C.border};border-radius:0 0 14px 14px;padding:22px 32px 26px;">
    <div style="font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">
      <strong style="color:${C.navy};">A shipping label being created does not mean the package shipped.</strong><br>
      A shipment is only reported as confirmed once UPS records a physical possession scan.
    </div>
    <div style="font-family:${FONT};font-size:11px;color:#9A938C;padding-top:14px;border-top:1px solid ${C.border};margin-top:14px;">
      Lavi MD &middot; Chayim Therapeutics Fulfillment Operations &middot; automated internal report
    </div>
  </td></tr>

</table>
</td></tr>
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
    `    UPS status: ${upsStatusOf(shipment)}`,
  ].join('\n');
}

function renderPlainText(data: DailyReportData, now: Date, subject: string): string {
  const lines: string[] = [
    'LAVI MD — SHIPPING AUDIT',
    'Chayim Therapeutics Fulfillment Operations',
    '',
    subject,
    '='.repeat(subject.length),
    `${formatLongDate(now)} · all times ${DISPLAY_TZ.replace('_', ' ')}`,
    '',
    '--- SUMMARY ---',
    `Total Monitored:    ${data.totalActive}`,
    `Needs Attention:    ${data.needsAttentionCount}`,
    `Confirmed Shipped:  ${data.confirmedCount}`,
    `In Transit:         ${data.inTransitCount}`,
    `Delivered:          ${data.deliveredCount}`,
    `Labels >24 Hours:   ${data.agingLabels.length}`,
    `Carrier Exceptions: ${data.exceptions.length}`,
    '',
  ];

  if (data.needsAttentionCount === 0) {
    lines.push('Nothing needs attention. Every label has a confirmed UPS possession scan.', '');
  } else {
    lines.push('*** NEEDS ATTENTION ***', '');
  }

  if (data.agingLabels.length > 0) {
    lines.push(`LABELS >24 HOURS — NO UPS SCAN (${data.agingLabels.length})`, '');
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
