import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_URL = 'https://shipping.lavimd.store';

import { renderDailyReport, escapeHtml, orderNumberDisplay, sourceDisplay } from '../src/lib/email/render';
import type { ShipmentRow } from '../src/lib/types';
import type { DailyReportData } from '../src/lib/database/queries';

const NOW = new Date('2026-08-26T12:00:00Z');

function shipment(overrides: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tracking_number: '1ZAAA0000000000001',
    source: 'shipstation',
    source_store: 'Lavi MD Retail Website',
    shipstation_store_id: '1',
    customer_name: 'Maria Alvarez',
    company_name: null,
    order_number: 'LM-10432',
    shipstation_order_id: null,
    shipstation_shipment_id: null,
    shipstation_label_id: null,
    shipstation_status: null,
    carrier: 'UPS',
    service: 'UPS Ground',
    label_created_at: new Date('2026-08-24T14:00:00Z'),
    ship_date: '2026-08-24',
    first_carrier_scan_at: null,
    delivered_at: null,
    destination_city: 'Tampa',
    destination_state: 'FL',
    destination_postal_code: '33602',
    destination_country: 'US',
    ups_status: 'Label created, UPS has not received the package',
    ups_status_code: 'MP',
    ups_status_type: 'M',
    normalized_status: 'AGING_LABEL',
    latest_tracking_event: null,
    latest_tracking_event_at: null,
    exception_type: null,
    has_physical_scan: false,
    first_seen_at: NOW,
    last_synced_at: NOW,
    last_tracking_check_at: NOW,
    manually_resolved: false,
    manually_resolved_by: null,
    manually_resolved_at: null,
    resolution_reason: null,
    resolution_note: null,
    notes: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function data(overrides: Partial<DailyReportData> = {}): DailyReportData {
  return {
    agingLabels: [],
    labelCreatedRecent: [],
    exceptions: [],
    confirmedCount: 52,
    deliveredCount: 30,
    inTransitCount: 12,
    needsAttentionCount: 0,
    totalActive: 100,
    ...overrides,
  };
}

describe('daily report rendering', () => {
  test('the subject matches the required format', () => {
    const { subject } = renderDailyReport(data(), NOW);
    assert.equal(subject, 'Lavi MD Shipping Audit — August 26, 2026');
  });

  test('problems appear before the success summary', () => {
    const { html } = renderDailyReport(
      data({
        agingLabels: [shipment()],
        needsAttentionCount: 1,
      }),
      NOW,
    );
    const attentionIndex = html.indexOf('NEEDS ATTENTION');
    const agingIndex = html.indexOf('Labels &gt;24 Hours — No UPS Scan');
    const successIndex = html.indexOf('confirmed with UPS');
    assert.ok(attentionIndex > -1);
    assert.ok(agingIndex > attentionIndex, 'aging section follows the attention heading');
    assert.ok(successIndex > agingIndex, 'the success summary comes last');
  });

  test('successful shipments are summarised, never listed', () => {
    const { html, text } = renderDailyReport(data({ confirmedCount: 52 }), NOW);
    assert.ok(html.includes('52 shipments confirmed with UPS'));
    assert.ok(html.includes('View all confirmed shipments'));
    assert.ok(text.includes('52 shipments confirmed with UPS.'));
  });

  test('the dashboard button points at the configured app URL', () => {
    const { html, text } = renderDailyReport(data(), NOW);
    assert.ok(html.includes('href="https://shipping.lavimd.store"'));
    assert.ok(html.includes('Open Shipping Dashboard'));
    assert.ok(text.includes('Open Shipping Dashboard: https://shipping.lavimd.store'));
  });

  test('wholesale rows show an em dash for the order number', () => {
    const wholesale = shipment({
      source: 'wholesale_danielle',
      source_store: 'Wholesale / Danielle',
      order_number: null,
      customer_name: 'Danielle Rivera',
    });
    assert.equal(orderNumberDisplay(wholesale), '—');
    assert.equal(sourceDisplay(wholesale), 'Wholesale / Danielle');

    const { html } = renderDailyReport(data({ agingLabels: [wholesale], needsAttentionCount: 1 }), NOW);
    assert.ok(html.includes('Wholesale / Danielle'));
    assert.ok(html.includes('>—</td>'));
  });

  test('a wholesale shipment that somehow carries an order number still shows a dash', () => {
    const odd = shipment({ source: 'wholesale_danielle', order_number: 'SHOULD-NOT-SHOW' });
    assert.equal(orderNumberDisplay(odd), '—');
  });

  test('a quiet morning renders an explicit all-clear', () => {
    const { html, text } = renderDailyReport(data({ needsAttentionCount: 0 }), NOW);
    assert.ok(html.includes('Nothing needs attention'));
    assert.ok(text.includes('Nothing needs attention'));
  });

  test('all seven summary metrics are present', () => {
    const report = () =>
      renderDailyReport(
        data({
          confirmedCount: 52,
          needsAttentionCount: 6,
          totalActive: 188,
          inTransitCount: 102,
          deliveredCount: 37,
          agingLabels: [shipment(), shipment()],
          exceptions: [shipment({ normalized_status: 'EXCEPTION' })],
        }),
        NOW,
      );

    const { text } = report();
    for (const line of [
      'Total Monitored:',
      'Needs Attention:',
      'Confirmed Shipped:',
      'In Transit:',
      'Delivered:',
      'Labels >24 Hours:',
      'Carrier Exceptions:',
    ]) {
      assert.ok(text.includes(line), `plain text is missing "${line}"`);
    }
    // The values, not just the labels.
    assert.match(text, /Total Monitored:\s+188/);
    assert.match(text, /In Transit:\s+102/);
    assert.match(text, /Delivered:\s+37/);

    const { html } = report();
    for (const label of [
      'Total Monitored',
      'NEEDS ATTENTION',
      'Confirmed Shipped',
      'In Transit',
      'Delivered',
      'Labels &gt;24 Hours',
      'Carrier Exceptions',
    ]) {
      assert.ok(html.includes(label), `html is missing the "${label}" metric`);
    }
    assert.ok(html.includes('>188<'), 'the Total Monitored value is rendered');
    assert.ok(html.includes('>102<'), 'the In Transit value is rendered');
  });

  test('the branded header identifies the sender without a remote logo', () => {
    const { html } = renderDailyReport(data(), NOW);
    assert.ok(html.includes('Lavi MD'));
    assert.ok(html.includes('Shipping Audit'));
    assert.ok(html.includes('Chayim Therapeutics Fulfillment Operations'));
    assert.ok(html.includes('Poppins'), 'the brand typeface is requested');
    // Typography only: no remote image may be embedded.
    assert.ok(!/<img/i.test(html), 'the header must not depend on a remote logo');
  });

  test('the layout is email-safe and responsive', () => {
    const { html } = renderDailyReport(
      data({ agingLabels: [shipment()], needsAttentionCount: 1 }),
      NOW,
    );
    assert.ok(html.includes('@media only screen and (max-width:620px)'), 'has a mobile breakpoint');
    assert.ok(html.includes('class="desk"'), 'wide-screen table variant');
    assert.ok(html.includes('class="mob"'), 'stacked mobile variant');
    assert.ok(html.includes('mso-hide:all'), 'the mobile variant is hidden from Outlook');
    // Outlook ignores <style>, so every visual rule must also be inline.
    assert.ok(!/<div[^>]+class="card"[^>]*>(?![^]*style=)/.test(html));
  });

  test('each attention row carries every required column', () => {
    const { html } = renderDailyReport(data({ agingLabels: [shipment()], needsAttentionCount: 1 }), NOW);
    for (const column of ['Customer', 'Order #', 'Source', 'Tracking #', 'Label Created', 'Age', 'UPS Status']) {
      assert.ok(html.includes(column), `missing column ${column}`);
    }
    assert.ok(html.includes('Maria Alvarez'));
    assert.ok(html.includes('LM-10432'));
    assert.ok(html.includes('1ZAAA0000000000001'));
    // The label is 46 hours old at NOW.
    assert.ok(html.includes('1d 22h'), 'age must be rendered');
  });

  test('tracking numbers link to the shipment detail page', () => {
    const { html } = renderDailyReport(data({ agingLabels: [shipment()], needsAttentionCount: 1 }), NOW);
    assert.ok(html.includes('https://shipping.lavimd.store/shipments/11111111-1111-4111-8111-111111111111'));
  });

  test('customer-supplied text is HTML-escaped', () => {
    const hostile = shipment({
      customer_name: '<script>alert("xss")</script>',
      order_number: 'A&B "quoted"',
    });
    const { html } = renderDailyReport(data({ agingLabels: [hostile], needsAttentionCount: 1 }), NOW);
    assert.ok(!html.includes('<script>alert'), 'a script tag must never survive rendering');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('A&amp;B &quot;quoted&quot;'));
  });

  test('escapeHtml covers the dangerous characters', () => {
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('all three attention sections render when populated', () => {
    const { html } = renderDailyReport(
      data({
        agingLabels: [shipment({ tracking_number: '1ZAGING000000000001' })],
        labelCreatedRecent: [shipment({ tracking_number: '1ZFRESH000000000001', normalized_status: 'LABEL_CREATED' })],
        exceptions: [shipment({ tracking_number: '1ZEXCEPT00000000001', normalized_status: 'EXCEPTION' })],
        needsAttentionCount: 3,
      }),
      NOW,
    );
    assert.ok(html.includes('1ZAGING000000000001'));
    assert.ok(html.includes('1ZFRESH000000000001'));
    assert.ok(html.includes('1ZEXCEPT00000000001'));
    assert.ok(html.includes('Labels &gt;24 Hours — No UPS Scan'));
    assert.ok(html.includes('Label Created — Waiting for UPS'));
    assert.ok(html.includes('Carrier Exceptions'));
  });
});
