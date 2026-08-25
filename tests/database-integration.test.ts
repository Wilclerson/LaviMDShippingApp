/**
 * Integration tests against a real PostgreSQL instance.
 *
 * Skipped automatically when TEST_DATABASE_URL is not set, so the unit suite
 * still runs anywhere. Run locally with:
 *   TEST_DATABASE_URL=postgres://... npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

const describeDb = TEST_DB ? describe : describe.skip;

describeDb('shipment persistence (real database)', () => {
  let upsertShipment: typeof import('../src/lib/database/shipments')['upsertShipment'];
  let loadKnownStates: typeof import('../src/lib/database/shipments')['loadKnownStates'];
  let refreshAgingLabels: typeof import('../src/lib/database/shipments')['refreshAgingLabels'];
  let getShipmentEvents: typeof import('../src/lib/database/shipments')['getShipmentEvents'];
  let query: typeof import('../src/lib/database/pool')['query'];
  let closePool: typeof import('../src/lib/database/pool')['closePool'];
  let mergeShipment: typeof import('../src/lib/shipment-normalizer/merge')['mergeShipment'];

  before(async () => {
    ({ upsertShipment, loadKnownStates, refreshAgingLabels, getShipmentEvents } = await import(
      '../src/lib/database/shipments'
    ));
    ({ query, closePool } = await import('../src/lib/database/pool'));
    ({ mergeShipment } = await import('../src/lib/shipment-normalizer/merge'));
    await query(`DELETE FROM shipments WHERE tracking_number LIKE '1ZTEST%'`);
  });

  after(async () => {
    await query(`DELETE FROM shipments WHERE tracking_number LIKE '1ZTEST%'`);
    await closePool();
  });

  const NOW = new Date('2026-08-26T13:00:00Z');

  function ss(tracking: string, overrides: Record<string, unknown> = {}) {
    return {
      trackingNumber: tracking,
      customerName: 'Maria Alvarez',
      companyName: null,
      orderNumber: 'LM-10432',
      shipstationOrderId: 'so_1',
      shipstationShipmentId: 'se-1',
      shipstationLabelId: 'se-1',
      shipstationStoreId: '55001',
      sourceStore: 'Lavi MD Shopify Store',
      shipstationStatus: 'label_purchased',
      carrier: 'UPS',
      service: 'ups_ground',
      labelCreatedAt: new Date('2026-08-25T14:00:00Z'),
      shipDate: '2026-08-25',
      destinationCity: 'Tampa',
      destinationState: 'FL',
      destinationPostalCode: '33602',
      destinationCountry: 'US',
      voided: false,
      raw: {},
      ...overrides,
    } as never;
  }

  function ups(tracking: string, overrides: Record<string, unknown> = {}) {
    return {
      trackingNumber: tracking,
      recipientName: 'M ALVAREZ',
      companyName: null,
      carrier: 'UPS' as const,
      service: 'UPS Ground',
      labelCreatedAt: null,
      shipDate: null,
      destinationCity: null,
      destinationState: null,
      destinationPostalCode: null,
      destinationCountry: null,
      upsStatus: 'Origin Scan',
      upsStatusCode: 'OR',
      upsStatusType: 'I',
      firstCarrierScanAt: new Date('2026-08-25T22:00:00Z'),
      deliveredAt: null,
      latestEvent: 'Origin Scan',
      latestEventAt: new Date('2026-08-25T22:00:00Z'),
      exceptionType: null,
      events: [
        {
          occurredAt: new Date('2026-08-25T22:00:00Z'),
          description: 'Origin Scan',
          statusCode: 'OR',
          statusType: 'I',
          locationCity: 'Deerfield Beach',
          locationState: 'FL',
          locationCountry: 'US',
          isPhysicalScan: true,
          eventSource: 'ups_tracking' as const,
          dedupKey: 'origin-1',
        },
      ],
      raw: {},
      ...overrides,
    } as never;
  }

  test('the same tracking number never creates a second row', async () => {
    const tn = '1ZTEST000000000001';
    const first = await upsertShipment(
      mergeShipment(ss(tn), null, { agingThresholdHours: 24, now: NOW }),
    );
    assert.equal(first.created, true);

    const second = await upsertShipment(
      mergeShipment(ss(tn), ups(tn), { agingThresholdHours: 24, now: NOW }),
    );
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);

    const rows = await query('SELECT id FROM shipments WHERE tracking_number = $1', [tn]);
    assert.equal(rows.length, 1);
  });

  test('a UPS-only shipment upgrades to ShipStation when the label appears there', async () => {
    const tn = '1ZTEST000000000002';
    await upsertShipment(
      mergeShipment(null, ups(tn, { recipientName: 'Danielle Rivera' }), {
        agingThresholdHours: 24,
        now: NOW,
      }),
    );
    let row = await query<{ source: string; order_number: string | null }>(
      'SELECT source, order_number FROM shipments WHERE tracking_number = $1',
      [tn],
    );
    assert.equal(row[0]!.source, 'wholesale_danielle');
    assert.equal(row[0]!.order_number, null);

    await upsertShipment(mergeShipment(ss(tn), ups(tn), { agingThresholdHours: 24, now: NOW }));
    row = await query('SELECT source, order_number FROM shipments WHERE tracking_number = $1', [tn]);
    assert.equal(row[0]!.source, 'shipstation');
    assert.equal(row[0]!.order_number, 'LM-10432');
  });

  test('a ShipStation shipment is never downgraded back to wholesale', async () => {
    const tn = '1ZTEST000000000003';
    await upsertShipment(mergeShipment(ss(tn), null, { agingThresholdHours: 24, now: NOW }));
    // A later Quantum View sweep sees the same tracking number with no
    // ShipStation context. It must not clobber the store attribution.
    await upsertShipment(mergeShipment(null, ups(tn), { agingThresholdHours: 24, now: NOW }));

    const row = await query<{ source: string; order_number: string; source_store: string }>(
      'SELECT source, order_number, source_store FROM shipments WHERE tracking_number = $1',
      [tn],
    );
    assert.equal(row[0]!.source, 'shipstation');
    assert.equal(row[0]!.order_number, 'LM-10432');
    assert.equal(row[0]!.source_store, 'Lavi MD Shopify Store');
  });

  test('an API response missing the scan does not erase the recorded scan', async () => {
    const tn = '1ZTEST000000000004';
    await upsertShipment(mergeShipment(ss(tn), ups(tn), { agingThresholdHours: 24, now: NOW }));

    // Simulate a degraded UPS response: no scan, no events.
    await upsertShipment(
      mergeShipment(ss(tn), ups(tn, { firstCarrierScanAt: null, events: [], upsStatus: null }), {
        agingThresholdHours: 24,
        now: NOW,
      }),
    );

    const row = await query<{ first_carrier_scan_at: Date | null; has_physical_scan: boolean }>(
      'SELECT first_carrier_scan_at, has_physical_scan FROM shipments WHERE tracking_number = $1',
      [tn],
    );
    assert.equal(row[0]!.first_carrier_scan_at?.toISOString(), '2026-08-25T22:00:00.000Z');
    assert.equal(row[0]!.has_physical_scan, true);
  });

  test('replaying the same events does not duplicate history', async () => {
    const tn = '1ZTEST000000000005';
    const merged = mergeShipment(ss(tn), ups(tn), { agingThresholdHours: 24, now: NOW });
    const first = await upsertShipment(merged);
    assert.equal(first.eventsInserted, 1);

    const second = await upsertShipment(merged);
    assert.equal(second.eventsInserted, 0, 'a replayed scan must be a no-op');

    const events = await getShipmentEvents(first.id);
    assert.equal(events.length, 1);
  });

  test('loadKnownStates returns prior history for the merge layer', async () => {
    const tn = '1ZTEST000000000006';
    await upsertShipment(mergeShipment(ss(tn), ups(tn), { agingThresholdHours: 24, now: NOW }));
    const states = await loadKnownStates([tn, '1ZTEST_MISSING']);
    const state = states.get(tn);
    assert.ok(state);
    assert.equal(state.firstCarrierScanAt?.toISOString(), '2026-08-25T22:00:00.000Z');
    assert.equal(state.physicalScanCount, 1);
    assert.equal(state.manuallyResolved, false);
    assert.equal(states.has('1ZTEST_MISSING'), false);
  });

  test('aging escalation only touches unscanned, unresolved labels', async () => {
    const aging = '1ZTEST000000000007';
    const scanned = '1ZTEST000000000008';
    const resolved = '1ZTEST000000000009';

    const old = new Date(Date.now() - 48 * 3_600_000);
    await upsertShipment(
      mergeShipment(ss(aging, { labelCreatedAt: old }), null, { agingThresholdHours: 999, now: NOW }),
    );
    await upsertShipment(
      mergeShipment(ss(scanned, { labelCreatedAt: old }), ups(scanned), {
        agingThresholdHours: 999,
        now: NOW,
      }),
    );
    await upsertShipment(
      mergeShipment(ss(resolved, { labelCreatedAt: old }), null, { agingThresholdHours: 999, now: NOW }),
    );
    await query(
      `UPDATE shipments SET manually_resolved = TRUE, manually_resolved_at = NOW() WHERE tracking_number = $1`,
      [resolved],
    );

    await refreshAgingLabels(24);

    const statuses = await query<{ tracking_number: string; normalized_status: string }>(
      'SELECT tracking_number, normalized_status FROM shipments WHERE tracking_number = ANY($1::text[])',
      [[aging, scanned, resolved]],
    );
    const byTn = new Map(statuses.map((r) => [r.tracking_number, r.normalized_status]));
    assert.equal(byTn.get(aging), 'AGING_LABEL');
    assert.notEqual(byTn.get(scanned), 'AGING_LABEL');
    assert.notEqual(byTn.get(resolved), 'AGING_LABEL');
  });

  test('status transitions are recorded automatically', async () => {
    const tn = '1ZTEST000000000010';
    await upsertShipment(mergeShipment(ss(tn), null, { agingThresholdHours: 24, now: NOW }));
    await upsertShipment(mergeShipment(ss(tn), ups(tn), { agingThresholdHours: 24, now: NOW }));

    const history = await query<{ from_status: string | null; to_status: string }>(
      `SELECT h.from_status, h.to_status
         FROM shipment_status_history h
         JOIN shipments s ON s.id = h.shipment_id
        WHERE s.tracking_number = $1
        ORDER BY h.id ASC`,
      [tn],
    );
    assert.ok(history.length >= 1);
    assert.equal(history[history.length - 1]!.to_status, 'SHIPPED');
  });
});
