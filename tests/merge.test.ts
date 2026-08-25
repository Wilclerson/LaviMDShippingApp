import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergeShipment, mergeUpsFacts, quantumViewToUpsFacts } from '../src/lib/shipment-normalizer/merge';
import type { ShipStationShipmentFacts, UpsShipmentFacts, CarrierEvent } from '../src/lib/types';

const NOW = new Date('2026-08-26T13:00:00Z');
const OPTS = { agingThresholdHours: 24, now: NOW };

function ssFacts(overrides: Partial<ShipStationShipmentFacts> = {}): ShipStationShipmentFacts {
  return {
    trackingNumber: '1ZSHARED0000000001',
    customerName: 'Maria Alvarez',
    companyName: null,
    orderNumber: 'LM-10432',
    shipstationOrderId: 'so_9911',
    shipstationShipmentId: 'se-778899',
    shipstationLabelId: 'se-778899',
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
    raw: { label: {} },
    ...overrides,
  };
}

function event(overrides: Partial<CarrierEvent> = {}): CarrierEvent {
  return {
    occurredAt: new Date('2026-08-25T22:00:00Z'),
    description: 'Origin Scan',
    statusCode: 'OR',
    statusType: 'I',
    locationCity: 'Deerfield Beach',
    locationState: 'FL',
    locationCountry: 'US',
    isPhysicalScan: true,
    eventSource: 'ups_tracking',
    dedupKey: 'origin-1',
    ...overrides,
  };
}

function upsFacts(overrides: Partial<UpsShipmentFacts> = {}): UpsShipmentFacts {
  return {
    trackingNumber: '1ZSHARED0000000001',
    recipientName: 'M ALVAREZ',
    companyName: null,
    carrier: 'UPS',
    service: 'UPS Ground',
    labelCreatedAt: new Date('2026-08-25T14:05:00Z'),
    shipDate: null,
    destinationCity: 'TAMPA',
    destinationState: 'FL',
    destinationPostalCode: '33602',
    destinationCountry: 'US',
    upsStatus: 'Origin Scan',
    upsStatusCode: 'OR',
    upsStatusType: 'I',
    firstCarrierScanAt: new Date('2026-08-25T22:00:00Z'),
    deliveredAt: null,
    latestEvent: 'Origin Scan',
    latestEventAt: new Date('2026-08-25T22:00:00Z'),
    exceptionType: null,
    events: [event()],
    raw: {},
    ...overrides,
  };
}

describe('deduplication — one tracking number is one shipment', () => {
  test('matching ShipStation and UPS records produce a single merged shipment', () => {
    const merged = mergeShipment(ssFacts(), upsFacts(), OPTS);
    assert.equal(merged.trackingNumber, '1ZSHARED0000000001');
    assert.equal(merged.source, 'shipstation');
  });

  test('ShipStation is authoritative for customer, order number and store', () => {
    const merged = mergeShipment(ssFacts(), upsFacts(), OPTS);
    assert.equal(merged.customerName, 'Maria Alvarez', 'not the UPS "M ALVAREZ" form');
    assert.equal(merged.orderNumber, 'LM-10432');
    assert.equal(merged.sourceStore, 'Lavi MD Shopify Store');
    assert.equal(merged.shipstationStoreId, '55001');
  });

  test('UPS is authoritative for carrier tracking status', () => {
    const merged = mergeShipment(
      ssFacts({ shipstationStatus: 'shipped' }),
      upsFacts({ upsStatus: 'Arrival Scan', upsStatusCode: 'AR' }),
      OPTS,
    );
    assert.equal(merged.upsStatus, 'Arrival Scan');
    assert.equal(merged.upsStatusCode, 'AR');
    // ShipStation's own claim is retained for reference but does not drive status.
    assert.equal(merged.shipstationStatus, 'shipped');
  });

  test('ShipStation marking a shipment "shipped" cannot produce a shipped status', () => {
    const merged = mergeShipment(
      ssFacts({ shipstationStatus: 'shipped' }),
      upsFacts({ firstCarrierScanAt: null, events: [], upsStatus: 'Label created' }),
      OPTS,
    );
    assert.equal(merged.hasPhysicalScan, false);
    // 23 hours old, so not yet aging - but emphatically not shipped either.
    assert.equal(merged.normalizedStatus, 'LABEL_CREATED');
    assert.ok(!['SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(merged.normalizedStatus));
  });
});

describe('wholesale / Danielle attribution', () => {
  test('a UPS-only tracking number becomes a wholesale shipment with no order number', () => {
    const merged = mergeShipment(
      null,
      upsFacts({
        trackingNumber: '1ZWHOLE0000000009',
        recipientName: 'Danielle Rivera',
        companyName: 'Premier Med Spa',
        firstCarrierScanAt: null,
        events: [],
      }),
      OPTS,
    );
    assert.equal(merged.source, 'wholesale_danielle');
    assert.equal(merged.sourceStore, 'Wholesale / Danielle');
    assert.equal(merged.orderNumber, null, 'wholesale shipments carry no internal order number');
    assert.equal(merged.customerName, 'Danielle Rivera');
    assert.equal(merged.companyName, 'Premier Med Spa');
  });

  test('once ShipStation knows the tracking number it is no longer wholesale', () => {
    const merged = mergeShipment(ssFacts(), upsFacts(), OPTS);
    assert.equal(merged.source, 'shipstation');
    assert.notEqual(merged.sourceStore, 'Wholesale / Danielle');
  });
});

describe('historical timestamps are never lost', () => {
  test('a previously known first scan survives a UPS response that omits it', () => {
    const known = new Date('2026-08-25T22:00:00Z');
    const merged = mergeShipment(ssFacts(), upsFacts({ firstCarrierScanAt: null, events: [] }), {
      ...OPTS,
      knownFirstCarrierScanAt: known,
    });
    assert.equal(merged.firstCarrierScanAt?.toISOString(), known.toISOString());
    assert.equal(merged.hasPhysicalScan, true);
  });

  test('an earlier scan discovered later replaces a later one', () => {
    const merged = mergeShipment(
      ssFacts(),
      upsFacts({ firstCarrierScanAt: new Date('2026-08-25T20:00:00Z') }),
      { ...OPTS, knownFirstCarrierScanAt: new Date('2026-08-25T22:00:00Z') },
    );
    assert.equal(merged.firstCarrierScanAt?.toISOString(), '2026-08-25T20:00:00.000Z');
  });

  test('the earliest label creation time across both sources wins', () => {
    const merged = mergeShipment(
      ssFacts({ labelCreatedAt: new Date('2026-08-25T14:00:00Z') }),
      upsFacts({ labelCreatedAt: new Date('2026-08-25T14:05:00Z') }),
      OPTS,
    );
    assert.equal(merged.labelCreatedAt?.toISOString(), '2026-08-25T14:00:00.000Z');
  });
});

describe('status derivation through the merge', () => {
  test('label created 2 hours ago with no scan is LABEL_CREATED', () => {
    const merged = mergeShipment(
      ssFacts({ labelCreatedAt: new Date('2026-08-26T11:00:00Z') }),
      upsFacts({ firstCarrierScanAt: null, events: [], upsStatus: 'Label created' }),
      OPTS,
    );
    assert.equal(merged.normalizedStatus, 'LABEL_CREATED');
  });

  test('label created 3 days ago with no scan is AGING_LABEL', () => {
    const merged = mergeShipment(
      ssFacts({ labelCreatedAt: new Date('2026-08-23T11:00:00Z') }),
      null,
      OPTS,
    );
    assert.equal(merged.normalizedStatus, 'AGING_LABEL');
  });

  test('a single origin scan reads as Confirmed Shipped', () => {
    const merged = mergeShipment(ssFacts(), upsFacts(), OPTS);
    assert.equal(merged.normalizedStatus, 'SHIPPED');
  });

  test('several physical scans read as In Transit', () => {
    const merged = mergeShipment(
      ssFacts(),
      upsFacts({
        events: [
          event({ dedupKey: 'origin-1' }),
          event({ dedupKey: 'arrival-1', description: 'Arrival Scan', statusCode: 'AR' }),
        ],
      }),
      OPTS,
    );
    assert.equal(merged.normalizedStatus, 'IN_TRANSIT');
  });

  test('a voided ShipStation label is VOIDED, never an aging exception', () => {
    const merged = mergeShipment(
      ssFacts({ voided: true, labelCreatedAt: new Date('2026-08-20T11:00:00Z') }),
      null,
      OPTS,
    );
    assert.equal(merged.normalizedStatus, 'VOIDED');
    assert.equal(merged.exceptionType, 'Label voided');
  });

  test('a UPS exception surfaces as EXCEPTION', () => {
    const merged = mergeShipment(
      ssFacts(),
      upsFacts({ exceptionType: 'Address correction required' }),
      OPTS,
    );
    assert.equal(merged.normalizedStatus, 'EXCEPTION');
    assert.equal(merged.exceptionType, 'Address correction required');
  });
});

describe('mergeUpsFacts — Quantum View and Tracking see different things', () => {
  test('the earliest possession scan across both sources wins', () => {
    const tracking = upsFacts({ firstCarrierScanAt: new Date('2026-08-25T23:30:00Z') });
    const quantum = upsFacts({
      firstCarrierScanAt: new Date('2026-08-25T22:00:00Z'),
      events: [event({ dedupKey: 'qv-origin|2026-08-25T22:00:00.000Z', eventSource: 'ups_quantum_view' })],
    });
    const merged = mergeUpsFacts(tracking, quantum);
    assert.equal(merged?.firstCarrierScanAt?.toISOString(), '2026-08-25T22:00:00.000Z');
  });

  test('events from both sources are unioned without duplicates', () => {
    const shared = event({ dedupKey: 'same-key' });
    const merged = mergeUpsFacts(
      upsFacts({ events: [shared, event({ dedupKey: 'only-tracking' })] }),
      upsFacts({ events: [shared, event({ dedupKey: 'only-quantum' })] }),
    );
    assert.equal(merged?.events.length, 3);
  });

  test('a physical-scan flag is never downgraded by a duplicate', () => {
    const merged = mergeUpsFacts(
      upsFacts({ events: [event({ dedupKey: 'k', isPhysicalScan: false })] }),
      upsFacts({ events: [event({ dedupKey: 'k', isPhysicalScan: true })] }),
    );
    assert.equal(merged?.events[0]!.isPhysicalScan, true);
  });

  test('merging with null returns the other side unchanged', () => {
    const only = upsFacts();
    assert.equal(mergeUpsFacts(only, null), only);
    assert.equal(mergeUpsFacts(null, only), only);
    assert.equal(mergeUpsFacts(null, null), null);
  });
});

describe('quantumViewToUpsFacts', () => {
  test('an Origin scan becomes the first carrier scan', () => {
    const facts = quantumViewToUpsFacts({
      trackingNumber: '1ZWHOLE0000000001',
      recipientName: 'Danielle Rivera',
      companyName: 'Premier Med Spa',
      service: 'UPS Ground',
      labelCreatedAt: new Date('2026-08-25T09:30:00Z'),
      shipDate: '2026-08-25',
      destinationCity: 'Scottsdale',
      destinationState: 'AZ',
      destinationPostalCode: '85251',
      destinationCountry: 'US',
      originScanAt: new Date('2026-08-25T18:12:00Z'),
      deliveredAt: null,
      exceptionType: null,
      events: [event({ dedupKey: 'qv-origin', eventSource: 'ups_quantum_view' })],
    });
    assert.equal(facts.firstCarrierScanAt?.toISOString(), '2026-08-25T18:12:00.000Z');
    assert.equal(facts.carrier, 'UPS');
  });

  test('a manifest-only wholesale label stays in the attention set', () => {
    const facts = quantumViewToUpsFacts({
      trackingNumber: '1ZWHOLE0000000002',
      recipientName: 'Danielle Rivera',
      companyName: null,
      service: 'UPS Ground',
      labelCreatedAt: new Date('2026-08-24T09:30:00Z'),
      shipDate: '2026-08-24',
      destinationCity: 'Reno',
      destinationState: 'NV',
      destinationPostalCode: null,
      destinationCountry: 'US',
      originScanAt: null,
      deliveredAt: null,
      exceptionType: null,
      events: [
        event({
          dedupKey: 'qv-manifest',
          description: 'Label created (UPS manifest received)',
          statusCode: 'MP',
          statusType: 'M',
          isPhysicalScan: false,
          eventSource: 'ups_quantum_view',
        }),
      ],
    });
    const merged = mergeShipment(null, facts, OPTS);
    assert.equal(merged.source, 'wholesale_danielle');
    assert.equal(merged.orderNumber, null);
    assert.equal(merged.normalizedStatus, 'AGING_LABEL');
    assert.equal(merged.hasPhysicalScan, false);
  });
});

describe('terminal facts carried between sync passes', () => {
  test('a pass with no UPS data keeps a previously recorded delivery', () => {
    const merged = mergeShipment(ssFacts(), null, {
      ...OPTS,
      knownDeliveredAt: new Date('2026-08-25T15:00:00Z'),
      knownFirstCarrierScanAt: new Date('2026-08-24T18:00:00Z'),
    });
    assert.equal(merged.normalizedStatus, 'DELIVERED');
    assert.equal(merged.deliveredAt?.toISOString(), '2026-08-25T15:00:00.000Z');
  });

  test('a pass that cannot see an exception does not clear it', () => {
    const merged = mergeShipment(ssFacts(), null, {
      ...OPTS,
      knownExceptionType: 'Address correction required',
      knownFirstCarrierScanAt: new Date('2026-08-24T18:00:00Z'),
    });
    assert.equal(merged.normalizedStatus, 'EXCEPTION');
    assert.equal(merged.exceptionType, 'Address correction required');
  });

  test('a UPS pass keeps a void that only ShipStation reported', () => {
    const merged = mergeShipment(null, upsFacts(), { ...OPTS, knownVoided: true });
    assert.equal(merged.normalizedStatus, 'VOIDED');
  });

  test('fresh UPS data still overrides a stale known exception', () => {
    const merged = mergeShipment(
      null,
      upsFacts({ deliveredAt: new Date('2026-08-26T10:00:00Z') }),
      { ...OPTS, knownExceptionType: 'Delivery attempt failed' },
    );
    assert.equal(merged.normalizedStatus, 'DELIVERED');
  });

  test('without the known-state options nothing changes for a first sighting', () => {
    const merged = mergeShipment(ssFacts(), upsFacts(), OPTS);
    assert.equal(merged.normalizedStatus, 'SHIPPED');
    assert.equal(merged.deliveredAt, null);
    assert.equal(merged.exceptionType, null);
  });
});
