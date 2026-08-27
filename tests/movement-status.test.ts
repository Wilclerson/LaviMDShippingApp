/**
 * Status progression over representative LIVE UPS event sequences.
 *
 * Captured from production tracking responses on 2026-08-26. UPS reports
 * logicalScan on this account inconsistently with its own documentation —
 * `false` on manifest events and `true` on AR/DP facility scans — so these
 * fixtures keep the real values rather than the documented ones.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseTrackingResponse } from '../src/lib/ups/tracking';
import { isPhysicalPossessionScan } from '../src/lib/ups/codes';
import { mergeShipment } from '../src/lib/shipment-normalizer/merge';

const TN = '1Z16F3B70214828077';

type Act = { type: string; code: string; desc: string; logical: boolean; day: string; hhmmss: string };

const MANIFEST: Act = { type: 'M', code: 'MP', desc: 'Shipper created a label, UPS has not received the package yet. ', logical: false, day: '20260820', hhmmss: '192050' };
const ORIGIN: Act = { type: 'I', code: 'OR', desc: 'Arrived at Facility', logical: false, day: '20260822', hhmmss: '015229' };
const DEPARTED: Act = { type: 'I', code: 'DP', desc: 'Departed from Facility', logical: true, day: '20260822', hhmmss: '031500' };
const ARRIVED: Act = { type: 'I', code: 'AR', desc: 'Arrived at Facility', logical: true, day: '20260822', hhmmss: '045100' };
const DELIVERED: Act = { type: 'D', code: 'FS', desc: 'DELIVERED ', logical: false, day: '20260825', hhmmss: '151915' };
const EXCEPTION: Act = { type: 'X', code: '17', desc: "A late UPS trailer arrival has delayed delivery. / Delivery will be delayed by one business day.", logical: false, day: '20260825', hhmmss: '140000' };

/**
 * Shaped exactly like a live response, including a detail that matters: UPS
 * sends `gmtTime` with colons ("01:52:29"), which parseUpsDateTime rejects, so
 * the parser always falls back to the compact `date`/`time` pair plus
 * `gmtOffset`. Fixtures carry both so they exercise the same path production
 * does.
 */
function payload(acts: Act[]) {
  return {
    trackResponse: {
      shipment: [{
        inquiryNumber: TN,
        shipperNumber: '16F3B7',
        package: [{
          trackingNumber: TN,
          currentStatus: { description: 'On the Way', code: '005' },
          activity: acts.map((a) => ({
            status: { type: a.type, code: a.code, description: a.desc },
            date: a.day,
            time: a.hhmmss,
            gmtDate: a.day,
            gmtTime: `${a.hhmmss.slice(0, 2)}:${a.hhmmss.slice(2, 4)}:${a.hhmmss.slice(4, 6)}`,
            gmtOffset: '+00:00',
            logicalScan: a.logical,
            location: { address: { city: 'Jacksonville', stateProvince: 'FL', countryCode: 'US' } },
          })),
        }],
      }],
    },
  };
}

/** Full pipeline: parse -> merge -> normalized status. */
function statusOf(acts: Act[], now = new Date('2026-08-26T00:00:00Z')) {
  const ups = parseTrackingResponse(TN, payload(acts));
  assert.ok(ups, 'payload must parse');
  const merged = mergeShipment(null, ups, {
    now,
    agingThresholdHours: 24,
    manuallyResolved: false,
    knownLabelCreatedAt: null,
    knownFirstCarrierScanAt: null,
    knownPhysicalScanCount: 0,
    knownDeliveredAt: null,
    knownExceptionType: null,
    knownVoided: false,
  });
  return { status: merged.normalizedStatus, merged, ups };
}

describe('status progression over live UPS sequences', () => {
  test('manifest only -> LABEL_CREATED', () => {
    // Within the aging threshold: 4 hours after the label was created.
    const { status, merged } = statusOf([MANIFEST], new Date('2026-08-20T23:20:50Z'));
    assert.equal(status, 'LABEL_CREATED');
    assert.equal(merged.firstCarrierScanAt, null, 'a manifest is never possession');
    assert.equal(merged.hasPhysicalScan, false);
  });

  test('manifest only, past its hand-over day -> AGING_LABEL (still not shipped)', () => {
    // Printed Thu 2026-08-20. On the Thursday/Friday hold-for-Monday path that
    // means expected tender Mon 24th and due at the end of Tue 25th, so it is
    // judged on the Thursday after — comfortably past due either way.
    const { status, merged } = statusOf([MANIFEST], new Date('2026-08-27T16:00:00Z'));
    assert.equal(status, 'AGING_LABEL');
    assert.equal(merged.firstCarrierScanAt, null, 'age never manufactures possession');
  });

  test('manifest + OR -> SHIPPED', () => {
    const { status, merged } = statusOf([MANIFEST, ORIGIN]);
    assert.equal(status, 'SHIPPED');
    assert.ok(merged.firstCarrierScanAt, 'the origin scan establishes possession');
    assert.equal(merged.firstCarrierScanAt.toISOString(), '2026-08-22T01:52:29.000Z');
  });

  test('manifest + OR + AR -> IN_TRANSIT', () => {
    const { status, merged } = statusOf([MANIFEST, ORIGIN, ARRIVED]);
    assert.equal(status, 'IN_TRANSIT');
    assert.ok(merged.firstCarrierScanAt);
    assert.equal(merged.firstCarrierScanAt.toISOString(), '2026-08-22T01:52:29.000Z',
      'possession still dates from the ORIGIN scan, not the later arrival');
  });

  test('manifest + OR + DP -> IN_TRANSIT', () => {
    const { status } = statusOf([MANIFEST, ORIGIN, DEPARTED]);
    assert.equal(status, 'IN_TRANSIT');
  });

  test('a delivery event -> DELIVERED', () => {
    const { status, merged } = statusOf([MANIFEST, ORIGIN, ARRIVED, DEPARTED, DELIVERED]);
    assert.equal(status, 'DELIVERED');
    assert.ok(merged.deliveredAt);
  });

  test('an exception while moving -> EXCEPTION', () => {
    const { status, merged } = statusOf([MANIFEST, ORIGIN, ARRIVED, EXCEPTION]);
    assert.equal(status, 'EXCEPTION');
    assert.ok(merged.exceptionType);
    assert.ok(merged.firstCarrierScanAt, 'the package is still known to be with UPS');
  });
});

describe('the conservative possession rule is intact', () => {
  const activity = (type: string, code: string, description: string, logicalScan: boolean | null) =>
    ({ statusType: type, statusCode: code, description, logicalScan });

  test('a manifest event is NEVER possession, whatever logicalScan says', () => {
    assert.equal(isPhysicalPossessionScan(activity('M', 'MP', 'Shipper created a label, UPS has not received the package yet.', false)), false);
    assert.equal(isPhysicalPossessionScan(activity('M', 'MP', 'Shipper created a label', true)), false);
    assert.equal(isPhysicalPossessionScan(activity('M', 'MP', 'Shipper created a label', null)), false);
    // Even if UPS ever mislabels a manifest with a movement code, the phrase catches it.
    assert.equal(isPhysicalPossessionScan(activity('I', 'AR', 'Shipper created a label, UPS has not received the package yet.', false)), false);
  });

  test('AR and DP now count, despite logicalScan=true', () => {
    assert.equal(isPhysicalPossessionScan(activity('I', 'AR', 'Arrived at Facility', true)), true);
    assert.equal(isPhysicalPossessionScan(activity('I', 'DP', 'Departed from Facility', true)), true);
  });

  test('the origin scan still counts', () => {
    assert.equal(isPhysicalPossessionScan(activity('I', 'OR', 'Arrived at Facility', false)), true);
  });

  test('a void is never possession', () => {
    assert.equal(isPhysicalPossessionScan(activity('MV', 'MV', 'Billing information voided', false)), false);
    assert.equal(isPhysicalPossessionScan(activity('I', 'VP', 'Voided pickup', false)), false);
  });

  test('logicalScan is still a veto for events we cannot name', () => {
    // Unknown code + logicalScan true -> not possession. Fails closed.
    assert.equal(isPhysicalPossessionScan(activity('I', 'ZZ', 'Some new UPS event', true)), false);
    // Same event without the logical flag falls through to the type rule.
    assert.equal(isPhysicalPossessionScan(activity('I', 'ZZ', 'Some new UPS event', false)), true);
  });

  test('logicalScan=false alone never promotes an unclassifiable event', () => {
    assert.equal(isPhysicalPossessionScan(activity('U', 'ZZ', 'Revised delivery estimate', false)), false);
    assert.equal(isPhysicalPossessionScan(activity('', '', '', false)), false);
  });
});
