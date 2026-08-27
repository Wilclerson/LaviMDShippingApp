/**
 * Integration tests for behaviour that only shows up against a real database:
 * persistent exceptions across days, and the report data shape.
 *
 * Skipped when TEST_DATABASE_URL is not set.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ShipmentFilter } from '../src/lib/database/queries';

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

const describeDb = TEST_DB ? describe : describe.skip;

describeDb('persistent exceptions and report data', () => {
  let mod: typeof import('../src/lib/database/shipments');
  let queries: typeof import('../src/lib/database/queries');
  let mutations: typeof import('../src/lib/database/mutations');
  let merge: typeof import('../src/lib/shipment-normalizer/merge');
  let pool: typeof import('../src/lib/database/pool');
  let userId: string;

  const HOUR = 3_600_000;
  const ago = (h: number) => new Date(Date.now() - h * HOUR);

  before(async () => {
    mod = await import('../src/lib/database/shipments');
    queries = await import('../src/lib/database/queries');
    mutations = await import('../src/lib/database/mutations');
    merge = await import('../src/lib/shipment-normalizer/merge');
    pool = await import('../src/lib/database/pool');

    const rows = await pool.query<{ id: string }>('SELECT id FROM users LIMIT 1');
    userId = rows[0]?.id ?? '';
  });

  /**
   * Resolving a shipment writes an audit_log row, and audit_log deliberately has
   * no FK to shipments — the trail has to outlive the record it describes. So
   * deleting the shipment alone leaves an orphaned audit row behind. Clear the
   * audit rows first, matched to this suite's own shipments, then the shipments.
   *
   * The second predicate catches rows whose shipment a previous run already
   * removed; both are scoped to the 1ZPERSIST prefix, so nothing else is touched.
   */
  async function cleanup() {
    await pool.query(
      `DELETE FROM audit_log
        WHERE entity_type = 'shipment'
          AND (entity_id IN (SELECT id::text FROM shipments WHERE tracking_number LIKE '1ZPERSIST%')
               OR detail->>'trackingNumber' LIKE '1ZPERSIST%')`,
    );
    await pool.query(`DELETE FROM shipments WHERE tracking_number LIKE '1ZPERSIST%'`);
  }

  beforeEach(cleanup);

  after(async () => {
    await cleanup();
    await pool.closePool();
  });

  /**
   * Overdue is a calendar judgement now, not an hours count: a Thursday air
   * label is not due until the Tuesday after. So fixtures that are meant to be
   * overdue use OVERDUE_HOURS — comfortably past the longest possible window on
   * any weekday — rather than a number that happens to work on a Wednesday.
   */
  const OVERDUE_HOURS = 24 * 14;
  const FRESH_HOURS = 2;

  function label(tracking: string, hoursAgo: number) {
    return merge.mergeShipment(
      {
        trackingNumber: tracking,
        customerName: 'Persistent Customer',
        companyName: null,
        orderNumber: 'LM-PERSIST',
        shipstationOrderId: null,
        shipstationShipmentId: null,
        shipstationLabelId: null,
        shipstationStoreId: '55001',
        sourceStore: 'Lavi MD Retail Website',
        shipstationStatus: 'label_purchased',
        carrier: 'UPS',
        service: 'UPS Ground',
        labelCreatedAt: ago(hoursAgo),
        shipDate: null,
        destinationCity: 'Tampa',
        destinationState: 'FL',
        destinationPostalCode: null,
        destinationCountry: 'US',
        voided: false,
        raw: {},
      },
      null,
      { agingThresholdHours: 24 },
    );
  }

  test('an unscanned label appears in the report every day until it is resolved', async () => {
    const tracking = '1ZPERSIST000000001';
    await mod.upsertShipment(label(tracking, OVERDUE_HOURS));

    // Monday, Tuesday, Wednesday: three consecutive report generations.
    for (let day = 0; day < 3; day++) {
      // Each morning re-runs the sync first; the label is seen again unchanged.
      await mod.upsertShipment(label(tracking, OVERDUE_HOURS + day * 24));
      await mod.refreshAgingLabels(24);

      const data = await queries.getDailyReportData(new Date(Date.now() - 24 * HOUR));
      const found = data.agingLabels.find((s) => s.tracking_number === tracking);
      assert.ok(found, `shipment must still be reported on day ${day + 1}`);
      assert.equal(found.normalized_status, 'AGING_LABEL');
    }
  });

  test('resolving it removes it from every subsequent report', async () => {
    const tracking = '1ZPERSIST000000002';
    const { id } = await mod.upsertShipment(label(tracking, OVERDUE_HOURS));
    await mod.refreshAgingLabels(24);

    let data = await queries.getDailyReportData(new Date(Date.now() - 24 * HOUR));
    assert.ok(data.agingLabels.some((s) => s.tracking_number === tracking));

    const resolved = await mutations.resolveShipment({
      shipmentId: id,
      reason: 'Shipment cancelled',
      note: 'Customer cancelled before pickup.',
      userId,
      actorEmail: 'admin@lavimd.store',
    });
    assert.equal(resolved, true);

    data = await queries.getDailyReportData(new Date(Date.now() - 24 * HOUR));
    assert.equal(
      data.agingLabels.some((s) => s.tracking_number === tracking),
      false,
      'a resolved shipment must not reappear',
    );

    // The record itself still exists — nothing is ever deleted.
    const still = await mod.getShipmentById(id);
    assert.ok(still);
    assert.equal(still.manually_resolved, true);
    assert.equal(still.resolution_reason, 'Shipment cancelled');

    // …and the decision is attributable.
    const trail = await mutations.getAuditTrail(id);
    assert.ok(trail.some((entry) => entry.action === 'shipment.resolve'));
  });

  test('a UPS scan arriving later clears it without any human action', async () => {
    const tracking = '1ZPERSIST000000003';
    await mod.upsertShipment(label(tracking, OVERDUE_HOURS));
    await mod.refreshAgingLabels(24);

    let data = await queries.getDailyReportData(new Date(Date.now() - 24 * HOUR));
    assert.ok(data.agingLabels.some((s) => s.tracking_number === tracking));

    // UPS finally scans it.
    await mod.upsertShipment(
      merge.mergeShipment(
        null,
        {
          trackingNumber: tracking,
          recipientName: null,
          companyName: null,
          carrier: 'UPS',
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
          firstCarrierScanAt: ago(2),
          deliveredAt: null,
          latestEvent: 'Origin Scan',
          latestEventAt: ago(2),
          exceptionType: null,
          events: [
            {
              occurredAt: ago(2),
              description: 'Origin Scan',
              statusCode: 'OR',
              statusType: 'I',
              locationCity: 'Deerfield Beach',
              locationState: 'FL',
              locationCountry: 'US',
              isPhysicalScan: true,
              eventSource: 'ups_tracking',
              dedupKey: 'late-origin',
            },
          ],
          raw: {},
        },
        { agingThresholdHours: 24, knownLabelCreatedAt: ago(OVERDUE_HOURS) },
      ),
    );

    data = await queries.getDailyReportData(new Date(Date.now() - 24 * HOUR));
    assert.equal(
      data.agingLabels.some((s) => s.tracking_number === tracking),
      false,
      'a scanned shipment leaves the attention list on its own',
    );
  });

  test('search finds a shipment by customer, order and tracking number', async () => {
    const tracking = '1ZPERSIST000000004';
    await mod.upsertShipment(label(tracking, 5));

    for (const term of ['Persistent Customer', 'LM-PERSIST', tracking, tracking.slice(0, 10)]) {
      const result = await queries.listShipments({ filter: 'all', search: term });
      assert.ok(
        result.shipments.some((s) => s.tracking_number === tracking),
        `search for "${term}" should find the shipment`,
      );
    }
  });

  test('a search term containing SQL syntax is treated as literal text', async () => {
    const tracking = '1ZPERSIST000000005';
    await mod.upsertShipment(label(tracking, 5));

    const hostile = await queries.listShipments({ filter: 'all', search: "'; DROP TABLE shipments; --" });
    assert.equal(hostile.shipments.length, 0);

    // The table is still there and still holds the row.
    const after = await queries.listShipments({ filter: 'all', search: tracking });
    assert.equal(after.shipments.length, 1);
  });

  test('dashboard counts agree with the filtered lists', async () => {
    await mod.upsertShipment(label('1ZPERSIST000000006', OVERDUE_HOURS));
    await mod.upsertShipment(label('1ZPERSIST000000007', FRESH_HOURS));
    await mod.refreshAgingLabels(24);

    const stats = await queries.getDashboardStats();

    // Every card must agree with the list it links to, or the dashboard lies.
    // Each entry is a card the dashboard renders, paired with the filter that
    // card links to. The numbers must be identical or the dashboard lies.
    const pairs: [keyof typeof stats, ShipmentFilter][] = [
      ['needsAttention', 'needs_attention'],
      ['agingLabels', 'aging_24h'],
      ['labelCreatedTotal', 'label_created'],
      ['confirmedShipped', 'confirmed_shipped'],
      ['inTransitTotal', 'in_transit'],
      ['delivered', 'delivered'],
      ['exceptions', 'exception'],
      ['wholesale', 'wholesale'],
      ['total', 'all'],
    ];

    for (const [key, filter] of pairs) {
      const listed = await queries.listShipments({ filter, limit: 500 });
      assert.equal(stats[key], listed.total, `card "${key}" disagrees with filter "${filter}"`);
    }

    // The combined totals must equal the sum of their parts.
    assert.equal(stats.labelCreatedTotal, stats.labelCreated + stats.agingLabels);
    assert.equal(stats.inTransitTotal, stats.inTransit + stats.confirmedShipped);
  });
});

describeDb('a later sync pass never downgrades a terminal status', () => {
  let mod: typeof import('../src/lib/database/shipments');
  let merge: typeof import('../src/lib/shipment-normalizer/merge');
  let pool: typeof import('../src/lib/database/pool');

  const HOUR = 3_600_000;
  const ago = (h: number) => new Date(Date.now() - h * HOUR);

  before(async () => {
    mod = await import('../src/lib/database/shipments');
    merge = await import('../src/lib/shipment-normalizer/merge');
    pool = await import('../src/lib/database/pool');
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM shipments WHERE tracking_number LIKE '1ZDOWNGRADE%'`);
  });

  after(async () => {
    await pool.query(`DELETE FROM shipments WHERE tracking_number LIKE '1ZDOWNGRADE%'`);
    await pool.closePool();
  });

  function shipStationFacts(tracking: string, overrides: Record<string, unknown> = {}) {
    return {
      trackingNumber: tracking,
      customerName: 'Downgrade Probe',
      companyName: null,
      orderNumber: 'LM-DOWNGRADE',
      shipstationOrderId: null,
      shipstationShipmentId: null,
      shipstationLabelId: null,
      shipstationStoreId: '55001',
      sourceStore: 'Lavi MD Retail Website',
      shipstationStatus: 'shipped',
      carrier: 'UPS',
      service: 'UPS Ground',
      labelCreatedAt: ago(100),
      shipDate: null,
      destinationCity: 'Tampa',
      destinationState: 'FL',
      destinationPostalCode: null,
      destinationCountry: 'US',
      voided: false,
      raw: {},
      ...overrides,
    } as never;
  }

  function upsFacts(tracking: string, overrides: Record<string, unknown> = {}) {
    return {
      trackingNumber: tracking,
      recipientName: null,
      companyName: null,
      carrier: 'UPS',
      service: 'UPS Ground',
      labelCreatedAt: ago(100),
      shipDate: null,
      destinationCity: null,
      destinationState: null,
      destinationPostalCode: null,
      destinationCountry: null,
      upsStatus: 'Origin Scan',
      upsStatusCode: 'OR',
      upsStatusType: 'I',
      firstCarrierScanAt: ago(90),
      deliveredAt: null,
      latestEvent: 'Origin Scan',
      latestEventAt: ago(90),
      exceptionType: null,
      events: [
        {
          occurredAt: ago(90),
          description: 'Origin Scan',
          statusCode: 'OR',
          statusType: 'I',
          locationCity: null,
          locationState: null,
          locationCountry: null,
          isPhysicalScan: true,
          eventSource: 'ups_tracking' as const,
          dedupKey: 'origin',
        },
      ],
      raw: {},
      ...overrides,
    } as never;
  }

  /** Exactly what src/lib/sync/run.ts does for a ShipStation-only pass. */
  async function runShipStationPass(tracking: string) {
    const states = await mod.loadKnownStates([tracking]);
    const known = states.get(tracking);
    await mod.upsertShipment(
      merge.mergeShipment(shipStationFacts(tracking), null, {
        agingThresholdHours: 24,
        manuallyResolved: known?.manuallyResolved ?? false,
        knownLabelCreatedAt: known?.labelCreatedAt ?? null,
        knownFirstCarrierScanAt: known?.firstCarrierScanAt ?? null,
        knownPhysicalScanCount: known?.physicalScanCount ?? 0,
        knownDeliveredAt: known?.deliveredAt ?? null,
        knownExceptionType: known?.exceptionType ?? null,
        knownVoided: known?.voided ?? false,
      }),
    );
  }

  async function statusOf(tracking: string): Promise<string> {
    const rows = await pool.query<{ normalized_status: string }>(
      'SELECT normalized_status FROM shipments WHERE tracking_number = $1',
      [tracking],
    );
    return rows[0]?.normalized_status ?? 'MISSING';
  }

  test('DELIVERED survives a ShipStation pass that cannot see the delivery', async () => {
    const tracking = '1ZDOWNGRADE0000001';
    await mod.upsertShipment(
      merge.mergeShipment(
        null,
        upsFacts(tracking, {
          deliveredAt: ago(20),
          upsStatus: 'Delivered',
          upsStatusCode: 'DL',
          upsStatusType: 'D',
        }),
        { agingThresholdHours: 24 },
      ),
    );
    assert.equal(await statusOf(tracking), 'DELIVERED');

    await runShipStationPass(tracking);
    assert.equal(await statusOf(tracking), 'DELIVERED', 'delivery must never be forgotten');
  });

  test('EXCEPTION survives a pass that cannot see the exception', async () => {
    const tracking = '1ZDOWNGRADE0000002';
    await mod.upsertShipment(
      merge.mergeShipment(null, upsFacts(tracking, { exceptionType: 'Address correction required' }), {
        agingThresholdHours: 24,
      }),
    );
    assert.equal(await statusOf(tracking), 'EXCEPTION');

    await runShipStationPass(tracking);
    assert.equal(await statusOf(tracking), 'EXCEPTION', 'an exception must not be silently cleared');
  });

  test('VOIDED survives a UPS pass that knows nothing about the void', async () => {
    const tracking = '1ZDOWNGRADE0000003';
    await mod.upsertShipment(
      merge.mergeShipment(shipStationFacts(tracking, { voided: true }), null, { agingThresholdHours: 24 }),
    );
    assert.equal(await statusOf(tracking), 'VOIDED');

    const states = await mod.loadKnownStates([tracking]);
    const known = states.get(tracking);
    await mod.upsertShipment(
      merge.mergeShipment(null, upsFacts(tracking), {
        agingThresholdHours: 24,
        knownLabelCreatedAt: known?.labelCreatedAt ?? null,
        knownFirstCarrierScanAt: known?.firstCarrierScanAt ?? null,
        knownPhysicalScanCount: known?.physicalScanCount ?? 0,
        knownDeliveredAt: known?.deliveredAt ?? null,
        knownExceptionType: known?.exceptionType ?? null,
        knownVoided: known?.voided ?? false,
      }),
    );
    assert.equal(await statusOf(tracking), 'VOIDED');
  });

  test('delivery still supersedes a recorded exception', async () => {
    const tracking = '1ZDOWNGRADE0000004';
    await mod.upsertShipment(
      merge.mergeShipment(null, upsFacts(tracking, { exceptionType: 'Delivery attempt failed' }), {
        agingThresholdHours: 24,
      }),
    );
    assert.equal(await statusOf(tracking), 'EXCEPTION');

    // The package is redelivered successfully the next day.
    const states = await mod.loadKnownStates([tracking]);
    const known = states.get(tracking);
    await mod.upsertShipment(
      merge.mergeShipment(
        null,
        upsFacts(tracking, { deliveredAt: ago(2), upsStatus: 'Delivered', upsStatusCode: 'DL' }),
        {
          agingThresholdHours: 24,
          knownLabelCreatedAt: known?.labelCreatedAt ?? null,
          knownFirstCarrierScanAt: known?.firstCarrierScanAt ?? null,
          knownPhysicalScanCount: known?.physicalScanCount ?? 0,
          knownDeliveredAt: known?.deliveredAt ?? null,
          knownExceptionType: known?.exceptionType ?? null,
          knownVoided: known?.voided ?? false,
        },
      ),
    );
    assert.equal(await statusOf(tracking), 'DELIVERED', 'a resolved exception must not block delivery');
  });
});
