import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.SHIPSTATION_STORE_IDS = '55001,55002';
process.env.SHIPSTATION_STORE_NAMES = 'Lavi MD Manual Orders,Lavi MD Retail Website,Lavi MD Shopify Store';

import {
  toShipStationFacts,
  buildStoreResolver,
  isStoreInScope,
  normalizeTrackingNumber,
  carrierDisplayName,
  serviceDisplayName,
  isUpsCarrier,
} from '../src/lib/shipstation/normalize';

const resolver = buildStoreResolver([
  { store_id: '55001', name: 'Lavi MD Retail Website' },
  { store_id: '55002', name: 'Lavi MD Shopify Store' },
  { store_id: '55003', name: 'Lavi MD Manual Orders' },
  { store_id: '99999', name: 'Some Other Brand' },
]);

describe('tracking number normalisation', () => {
  test('uppercases and strips whitespace', () => {
    assert.equal(normalizeTrackingNumber(' 1z999aa1 0123 456784 '), '1Z999AA10123456784');
  });
  test('rejects values that are too short or not strings', () => {
    assert.equal(normalizeTrackingNumber('1Z9'), null);
    assert.equal(normalizeTrackingNumber(null), null);
    assert.equal(normalizeTrackingNumber(12345678), null);
    assert.equal(normalizeTrackingNumber(''), null);
  });
});

describe('carrier and service naming', () => {
  test('carrier codes map to display names', () => {
    assert.equal(carrierDisplayName('ups'), 'UPS');
    assert.equal(carrierDisplayName('ups_walleted'), 'UPS');
    assert.equal(carrierDisplayName('stamps_com'), 'USPS');
    assert.equal(carrierDisplayName('fedex'), 'FedEx');
    assert.equal(carrierDisplayName(null), null);
  });

  test('isUpsCarrier only matches UPS', () => {
    assert.equal(isUpsCarrier('UPS'), true);
    assert.equal(isUpsCarrier('FedEx'), false);
    assert.equal(isUpsCarrier(null), false);
  });

  test('service codes become readable names', () => {
    assert.equal(serviceDisplayName('ups_ground'), 'UPS Ground');
    assert.equal(serviceDisplayName('ups_2nd_day_air'), 'UPS 2nd Day Air');
    assert.equal(serviceDisplayName('UPS Ground'), 'UPS Ground', 'already-readable values pass through');
    assert.equal(serviceDisplayName(null), null);
  });
});

describe('store scoping', () => {
  test('a configured store id is in scope', () => {
    assert.equal(isStoreInScope('55001', 'Lavi MD Retail Website', resolver), true);
  });

  test('a configured store name is in scope even when the id is not listed', () => {
    assert.equal(isStoreInScope('55003', 'Lavi MD Manual Orders', resolver), true);
  });

  test('an unrelated store is out of scope', () => {
    assert.equal(isStoreInScope('99999', 'Some Other Brand', resolver), false);
  });

  test('name matching is case-insensitive', () => {
    assert.equal(isStoreInScope('77777', 'lavi md shopify store', resolver), true);
  });

  test('with no filter configured everything is accepted', () => {
    const open = buildStoreResolver([]);
    open.allowedIds.clear();
    open.allowedNames.clear();
    assert.equal(isStoreInScope('99999', 'Anything At All', open), true);
  });
});

describe('label + shipment to domain facts', () => {
  const label = {
    label_id: 'se-8891',
    shipment_id: 'se-8891',
    tracking_number: '1z999aa1 0123456784',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    created_at: '2026-08-25T14:00:00.000Z',
    ship_date: '2026-08-25T00:00:00.000Z',
    status: 'completed',
    voided: false,
  };

  const shipment = {
    shipment_id: 'se-8891',
    store_id: 55001,
    order_number: 'LM-10432',
    order_id: 'so_9911',
    shipment_status: 'label_purchased',
    ship_to: {
      name: 'Maria Alvarez',
      company_name: 'Alvarez Clinic',
      city_locality: 'Tampa',
      state_province: 'FL',
      postal_code: '33602',
      country_code: 'US',
    },
  };

  test('all audit-critical fields are extracted', () => {
    const facts = toShipStationFacts(label, shipment, resolver);
    assert.ok(facts);
    assert.equal(facts.trackingNumber, '1Z999AA10123456784');
    assert.equal(facts.customerName, 'Maria Alvarez');
    assert.equal(facts.companyName, 'Alvarez Clinic');
    assert.equal(facts.orderNumber, 'LM-10432');
    assert.equal(facts.shipstationOrderId, 'so_9911');
    assert.equal(facts.shipstationShipmentId, 'se-8891');
    assert.equal(facts.shipstationStoreId, '55001', 'numeric store ids are stringified');
    assert.equal(facts.sourceStore, 'Lavi MD Retail Website');
    assert.equal(facts.carrier, 'UPS');
    assert.equal(facts.service, 'UPS Ground');
    assert.equal(facts.labelCreatedAt?.toISOString(), '2026-08-25T14:00:00.000Z');
    assert.equal(facts.shipDate, '2026-08-25');
    assert.equal(facts.destinationCity, 'Tampa');
    assert.equal(facts.destinationState, 'FL');
    assert.equal(facts.voided, false);
  });

  test('a label with no tracking number is discarded', () => {
    assert.equal(toShipStationFacts({ ...label, tracking_number: undefined }, shipment, resolver), null);
  });

  test('a missing shipment still yields usable facts', () => {
    // Shipment enrichment can fail; the tracking number and label timestamp are
    // the audit-critical parts and must survive.
    const facts = toShipStationFacts(label, null, resolver);
    assert.ok(facts);
    assert.equal(facts.trackingNumber, '1Z999AA10123456784');
    assert.equal(facts.labelCreatedAt?.toISOString(), '2026-08-25T14:00:00.000Z');
    assert.equal(facts.orderNumber, null);
    assert.equal(facts.customerName, null);
  });

  test('alternate order-number field names are picked up', () => {
    const viaExternal = toShipStationFacts(
      label,
      { ...shipment, order_number: undefined, external_order_id: 'SHOP-778' },
      resolver,
    );
    assert.equal(viaExternal?.orderNumber, 'SHOP-778');

    const viaShipmentNumber = toShipStationFacts(
      label,
      { ...shipment, order_number: undefined, external_order_id: undefined, shipment_number: 'SN-42' },
      resolver,
    );
    assert.equal(viaShipmentNumber?.orderNumber, 'SN-42');
  });

  test('an unknown field shape degrades to null instead of throwing', () => {
    const facts = toShipStationFacts(
      { tracking_number: '1Z999AA10123456784', renamed_created_field: '2026-08-25T14:00:00Z' },
      {},
      resolver,
    );
    assert.ok(facts);
    assert.equal(facts.labelCreatedAt, null);
    assert.equal(facts.carrier, null);
  });

  test('void is detected from either the flag or the status string', () => {
    assert.equal(toShipStationFacts({ ...label, voided: true }, shipment, resolver)?.voided, true);
    assert.equal(
      toShipStationFacts({ ...label, voided: false, status: 'voided' }, shipment, resolver)?.voided,
      true,
    );
  });

  test('raw payloads are retained for forensic replay', () => {
    const facts = toShipStationFacts(label, shipment, resolver);
    assert.ok(facts?.raw);
    assert.deepEqual((facts.raw as { label: unknown }).label, label);
  });
});
