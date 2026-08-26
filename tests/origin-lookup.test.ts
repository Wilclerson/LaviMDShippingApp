/**
 * "Wholesale / Danielle" must mean "genuinely not in ShipStation", never
 * "not in the stores we happen to ingest".
 *
 * Quantum View sees every label on the UPS account. Deciding wholesale from the
 * contents of our own database labelled 44 real ShipStation shipments — from a
 * store outside SHIPSTATION_STORE_IDS — as Danielle's, with a null order
 * number. These tests pin the corrected rule.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.SHIPSTATION_STORE_IDS = 'se-4492812,se-4492907,se-4508646';
process.env.SHIPSTATION_STORE_NAMES = '';

import { lookupShipStationOrigin, type ShipStationOriginClient } from '../src/lib/shipstation/origin-lookup';
import { buildStoreResolver } from '../src/lib/shipstation/normalize';
import { mergeShipment } from '../src/lib/shipment-normalizer/merge';
import type { RawLabel, RawShipment } from '../src/lib/shipstation/client';

const resolver = buildStoreResolver([]);

const SCOPED = '1Z1610V50390643181'; // se-4492907 — a configured store
const UNSCOPED = '1Z1610V50390644392'; // se-4507974 — a real store we do NOT ingest
const ABSENT = '1Z999AA10123456784'; // Danielle: exists in UPS, never in ShipStation

function label(tracking: string, shipmentId: string): RawLabel {
  return {
    label_id: `se-label-${shipmentId}`,
    shipment_id: shipmentId,
    tracking_number: tracking,
    carrier_code: 'wwex_parcel',
    service_code: 'ups_ground',
    created_at: '2026-08-25T17:33:17.000Z',
    ship_date: '2026-08-25T00:00:00.000Z',
    status: 'completed',
  };
}

function shipment(storeId: string, orderNumber: string | null): RawShipment {
  return {
    shipment_id: `se-ship-${storeId}`,
    store_id: storeId,
    shipment_number: orderNumber ?? undefined,
    shipment_status: 'label_purchased',
    ship_to: { name: 'Test Customer', city_locality: 'Tampa', state_province: 'FL', country_code: 'US' },
  };
}

/** A ShipStation that knows about both a scoped and an unscoped store. */
function fakeClient(overrides: Partial<ShipStationOriginClient> = {}): ShipStationOriginClient {
  const labels = new Map<string, { label: RawLabel; shipment: RawShipment }>([
    [SCOPED, { label: label(SCOPED, 'se-ship-a'), shipment: shipment('se-4492907', '3992') }],
    [UNSCOPED, { label: label(UNSCOPED, 'se-ship-b'), shipment: shipment('se-4507974', null) }],
  ]);
  return {
    async findLabelByTrackingNumber(tn) {
      return labels.get(tn)?.label ?? null;
    },
    async getShipment(id) {
      for (const v of labels.values()) if (v.label.shipment_id === id) return v.shipment;
      return null;
    },
    ...overrides,
  };
}

const merge = (facts: Awaited<ReturnType<typeof lookupShipStationOrigin>>) =>
  mergeShipment(facts, null, {
    agingThresholdHours: 24,
    manuallyResolved: false,
    knownLabelCreatedAt: null,
    knownFirstCarrierScanAt: null,
    knownPhysicalScanCount: 0,
    knownDeliveredAt: null,
    knownExceptionType: null,
    knownVoided: false,
  });

describe('ShipStation origin lookup for Quantum View discoveries', () => {
  test('a tracking number in a CONFIGURED store resolves to ShipStation', async () => {
    const facts = await lookupShipStationOrigin(SCOPED, resolver, fakeClient());
    assert.ok(facts, 'must resolve');
    assert.equal(facts.trackingNumber, SCOPED);
    assert.equal(facts.shipstationStoreId, 'se-4492907');
    assert.equal(facts.orderNumber, '3992');
    assert.equal(merge(facts).source, 'shipstation');
  });

  test('a tracking number in an UNSCOPED store is still ShipStation, NOT Danielle', async () => {
    const facts = await lookupShipStationOrigin(UNSCOPED, resolver, fakeClient());
    assert.ok(facts, 'a store we do not ingest is still a ShipStation shipment');
    assert.equal(facts.shipstationStoreId, 'se-4507974');
    const merged = merge(facts);
    assert.equal(merged.source, 'shipstation');
    assert.notEqual(merged.source, 'wholesale_danielle');
  });

  test('a tracking number ABSENT from ShipStation becomes Wholesale / Danielle', async () => {
    const facts = await lookupShipStationOrigin(ABSENT, resolver, fakeClient());
    assert.equal(facts, null, 'positive absence is the only route to wholesale');
    const merged = mergeShipment(null, {
      trackingNumber: ABSENT,
      recipientName: 'Wholesale Buyer',
      companyName: null,
      carrier: 'UPS',
      service: 'UPS Ground',
      labelCreatedAt: new Date('2026-08-25T12:00:00Z'),
      shipDate: null,
      destinationCity: null, destinationState: null, destinationPostalCode: null, destinationCountry: null,
      upsStatus: null, upsStatusCode: null, upsStatusType: null,
      firstCarrierScanAt: null, deliveredAt: null,
      latestEvent: null, latestEventAt: null, exceptionType: null,
      events: [], raw: {},
    }, {
      agingThresholdHours: 24, manuallyResolved: false, knownLabelCreatedAt: null,
      knownFirstCarrierScanAt: null, knownPhysicalScanCount: 0, knownDeliveredAt: null,
      knownExceptionType: null, knownVoided: false,
    });
    assert.equal(merged.source, 'wholesale_danielle');
    assert.equal(merged.orderNumber, null);
  });

  test('an inconclusive answer throws — it is never read as absence', async () => {
    const client = fakeClient({
      async findLabelByTrackingNumber() {
        throw new Error('ShipStation responded 503');
      },
    });
    await assert.rejects(() => lookupShipStationOrigin(UNSCOPED, resolver, client), /503/);
  });

  test('a mismatched label never attaches to the wrong package', async () => {
    // ShipStation returns a label for a DIFFERENT tracking number.
    const client = fakeClient({
      async findLabelByTrackingNumber() {
        return label('1Z1610V50390649999', 'se-ship-z');
      },
    });
    const facts = await lookupShipStationOrigin(UNSCOPED, resolver, client);
    assert.equal(facts, null, 'a non-matching label must not be adopted');
  });

  test('duplicate/overlap: a number already ingested from ShipStation resolves identically', async () => {
    // Quantum View and ShipStation both see the same package. Resolving twice
    // must be stable and must never flip the source.
    const first = await lookupShipStationOrigin(SCOPED, resolver, fakeClient());
    const second = await lookupShipStationOrigin(SCOPED, resolver, fakeClient());
    assert.deepEqual(first?.trackingNumber, second?.trackingNumber);
    assert.equal(first?.shipstationStoreId, second?.shipstationStoreId);
    assert.equal(merge(first).source, 'shipstation');
    assert.equal(merge(second).source, 'shipstation');
  });

  test('overlap: the same tracking number cannot be both ShipStation and wholesale', async () => {
    const client = fakeClient();
    const scoped = await lookupShipStationOrigin(SCOPED, resolver, client);
    const unscoped = await lookupShipStationOrigin(UNSCOPED, resolver, client);
    const absent = await lookupShipStationOrigin(ABSENT, resolver, client);
    const sources = [merge(scoped).source, merge(unscoped).source];
    assert.deepEqual(sources, ['shipstation', 'shipstation']);
    assert.equal(absent, null);
    // One tracking number, one verdict.
    assert.equal(new Set([scoped?.trackingNumber, unscoped?.trackingNumber]).size, 2);
  });

  test('a label with no shipment record still counts as ShipStation-originated', async () => {
    const client = fakeClient({
      async getShipment() {
        return null; // enrichment unavailable
      },
    });
    const facts = await lookupShipStationOrigin(UNSCOPED, resolver, client);
    assert.ok(facts, 'the label alone proves ShipStation origin');
    assert.equal(merge(facts).source, 'shipstation');
  });
});
