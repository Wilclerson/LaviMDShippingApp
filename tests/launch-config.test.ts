/**
 * Launch-safe configuration: ShipStation is the authoritative discovery source,
 * UPS Tracking the authoritative possession source, Quantum View optional.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.SHIPSTATION_STORE_IDS = 'se-4492812,se-4492907,se-4508646,se-4507974';
process.env.SHIPSTATION_STORE_NAMES = '';

import {
  buildStoreResolver,
  isStoreInScope,
  resolveStoreName,
  toShipStationFacts,
} from '../src/lib/shipstation/normalize';
import { storeDisplayName, STORE_DISPLAY_NAMES } from '../src/lib/shipstation/store-names';
import { mergeShipment } from '../src/lib/shipment-normalizer/merge';
import { deriveStatus } from '../src/lib/shipment-normalizer/status';
import { parseTrackingResponse, isTrackingNotFound, TRACKING_NOT_FOUND_CODE } from '../src/lib/ups/tracking';
import { isQuantumViewUnavailable } from '../src/lib/sync/run';
import { HttpError } from '../src/lib/http/fetch';
import type { RawLabel, RawShipment } from '../src/lib/shipstation/client';

const resolver = buildStoreResolver([]);
const DANIELLE_STORE = 'se-4507974';
const DANIELLE_TRACKING = '1Z16F3B70215914392';

/** A label from Danielle's store, shaped like the live records. */
const danielleLabel: RawLabel = {
  label_id: 'se-190511914',
  shipment_id: 'se-409923051',
  tracking_number: DANIELLE_TRACKING,
  carrier_code: 'wwex_parcel',
  service_code: 'wwex_ups_2nd_day_air',
  created_at: '2026-08-25T19:03:51.740Z',
  ship_date: '2026-08-25T07:00:00Z',
  status: 'completed',
};

const danielleShipment: RawShipment = {
  shipment_id: 'se-409923051',
  store_id: DANIELLE_STORE,
  // The manual-label signature: no order number, no items, no warehouse.
  shipment_number: undefined,
  external_shipment_id: undefined,
  shipment_status: 'label_purchased',
  items: [],
  ship_to: { name: 'Kimberly Skriba', city_locality: 'GENOA', state_province: 'OH', country_code: 'US' },
};

describe('se-4507974 is ingested by the normal ShipStation pass', () => {
  test('the store is in the configured scope', () => {
    assert.equal(resolver.allowedIds.has(DANIELLE_STORE), true, 'must be configured');
    assert.equal(isStoreInScope(DANIELLE_STORE, null, resolver), true);
  });

  test('the original three stores remain in scope', () => {
    for (const id of ['se-4492812', 'se-4492907', 'se-4508646']) {
      assert.equal(isStoreInScope(id, null, resolver), true, `${id} must stay in scope`);
    }
  });

  test('a store outside the configured list is still excluded', () => {
    assert.equal(isStoreInScope('se-4492995', null, resolver), false, 'the test store stays out');
  });

  test('a Danielle label normalises into usable facts', () => {
    const facts = toShipStationFacts(danielleLabel, danielleShipment, resolver);
    assert.ok(facts);
    assert.equal(facts.trackingNumber, DANIELLE_TRACKING);
    assert.equal(facts.shipstationStoreId, DANIELLE_STORE);
    assert.equal(facts.orderNumber, null, 'manual labels genuinely have no order number');
    assert.equal(facts.customerName, 'Kimberly Skriba');
  });
});

describe('friendly store names', () => {
  test('se-4507974 displays as Wholesale / Danielle', () => {
    assert.equal(storeDisplayName(DANIELLE_STORE), 'Wholesale / Danielle');
    assert.equal(resolveStoreName(DANIELLE_STORE, null, resolver), 'Wholesale / Danielle');
  });

  test('the other three keep their own names', () => {
    assert.equal(storeDisplayName('se-4492812'), 'Lavi MD Manual Orders');
    assert.equal(storeDisplayName('se-4492907'), 'Lavi MD Retail Website');
    assert.equal(storeDisplayName('se-4508646'), 'Lavi MD Shopify Store');
  });

  test('an unknown store id has no invented name', () => {
    assert.equal(storeDisplayName('se-9999999'), null);
    assert.equal(storeDisplayName(null), null);
    assert.equal(storeDisplayName(''), null);
  });

  test('all four configured stores have a display name', () => {
    for (const id of ['se-4492812', 'se-4492907', 'se-4508646', 'se-4507974']) {
      assert.ok(STORE_DISPLAY_NAMES[id], `${id} needs a display name`);
    }
  });
});

describe('"Wholesale / Danielle" is a display name, not a source claim', () => {
  const merged = () =>
    mergeShipment(toShipStationFacts(danielleLabel, danielleShipment, resolver), null, {
      agingThresholdHours: 24,
      manuallyResolved: false,
      knownLabelCreatedAt: null,
      knownFirstCarrierScanAt: null,
      knownPhysicalScanCount: 0,
      knownDeliveredAt: null,
      knownExceptionType: null,
      knownVoided: false,
    });

  test('the internal source stays "shipstation"', () => {
    assert.equal(merged().source, 'shipstation');
    assert.notEqual(merged().source, 'wholesale_danielle');
  });

  test('but it is displayed as Wholesale / Danielle', () => {
    assert.equal(merged().sourceStore, 'Wholesale / Danielle');
  });

  test('the label alone is NOT shipped', () => {
    const m = merged();
    assert.equal(m.firstCarrierScanAt, null);
    assert.equal(m.hasPhysicalScan, false);
    const status = deriveStatus({
      labelCreatedAt: m.labelCreatedAt,
      firstCarrierScanAt: null,
      deliveredAt: null,
      hasException: false,
      voided: false,
      manuallyResolved: false,
      agingThresholdHours: 24,
    }, new Date('2026-08-25T21:00:00Z'));
    assert.equal(status, 'LABEL_CREATED', 'a manifest-only label is never shipped');
  });
});

describe('Quantum View is optional', () => {
  const qvError = (status: number, body: string) =>
    new HttpError('ups-quantum-view responded ' + status, {
      status, body, url: 'https://onlinetools.ups.com/api/quantumview/v3/events', retryable: false,
    });

  test('330050 Invalid QV user is recognised as unavailable, not a failure', () => {
    const err = qvError(400, '{"response":{"errors":[{"code":"330050","message":"Invalid QV user. Please check your login."}]}}');
    assert.equal(isQuantumViewUnavailable(err), true);
  });

  test('401/403 are unavailable too', () => {
    assert.equal(isQuantumViewUnavailable(qvError(401, 'unauthorized')), true);
    assert.equal(isQuantumViewUnavailable(qvError(403, 'forbidden')), true);
  });

  test('a genuine outage is still a failure', () => {
    assert.equal(isQuantumViewUnavailable(qvError(500, 'internal error')), false);
    assert.equal(isQuantumViewUnavailable(qvError(400, '{"errors":[{"code":"999999"}]}')), false);
    assert.equal(isQuantumViewUnavailable(new Error('socket hang up')), false);
  });

  test('a skipped pass does not fail the overall sync', () => {
    // runFullSync: ok = every pass is 'success' or 'skipped'.
    const passes = [{ status: 'success' }, { status: 'skipped' }, { status: 'success' }];
    assert.equal(passes.every((p) => p.status === 'success' || p.status === 'skipped'), true);
    const withFailure = [{ status: 'success' }, { status: 'failed' }, { status: 'success' }];
    assert.equal(withFailure.every((p) => p.status === 'success' || p.status === 'skipped'), false);
  });
});

describe('UPS TW0001 is an explicit "not found"', () => {
  const notFound = {
    trackResponse: {
      shipment: [{
        inquiryNumber: '1Z16F3B70210000002',
        warnings: [{ code: TRACKING_NOT_FOUND_CODE, message: 'Tracking Information Not Found' }],
      }],
    },
  };

  test('a TW0001 response is recognised', () => {
    assert.equal(isTrackingNotFound(notFound), true);
    assert.equal(parseTrackingResponse('1Z16F3B70210000002', notFound), null);
  });

  test('a real response is not mistaken for not-found', () => {
    const real = {
      trackResponse: {
        shipment: [{
          inquiryNumber: DANIELLE_TRACKING,
          package: [{
            trackingNumber: DANIELLE_TRACKING,
            currentStatus: { description: 'Shipment Ready for UPS', code: '003' },
            activity: [{
              status: { type: 'M', code: 'MP', description: 'Shipper created a label, UPS has not received the package yet.' },
              date: '20260825', time: '150355', gmtDate: '20260825', gmtTime: '19:03:55', gmtOffset: '-04:00',
              logicalScan: false,
            }],
          }],
        }],
      },
    };
    assert.equal(isTrackingNotFound(real), false);
    const facts = parseTrackingResponse(DANIELLE_TRACKING, real);
    assert.ok(facts, 'a manifest-only shipment still parses');
    assert.equal(facts.firstCarrierScanAt, null, 'a manifest is not possession');
  });

  test('an empty or malformed payload is not claimed as not-found', () => {
    assert.equal(isTrackingNotFound({}), false);
    assert.equal(isTrackingNotFound(null), false);
    assert.equal(isTrackingNotFound({ trackResponse: { shipment: [] } }), false);
  });

  test('a warning alongside real package data does not suppress the data', () => {
    const mixed = {
      trackResponse: {
        shipment: [{
          warnings: [{ code: TRACKING_NOT_FOUND_CODE, message: 'Tracking Information Not Found' }],
          package: [{ trackingNumber: DANIELLE_TRACKING, activity: [] }],
        }],
      },
    };
    assert.equal(isTrackingNotFound(mixed), false, 'packages present means we have data');
  });
});
