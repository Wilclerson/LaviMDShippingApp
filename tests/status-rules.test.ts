import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveStatus,
  refineMovementStatus,
  statusDisplay,
  needsAttention,
  STATUS_PRESENTATION,
} from '../src/lib/shipment-normalizer/status';
import {
  isPhysicalPossessionScan,
  isManifestOnlyActivity,
  isVoidActivity,
  isDeliveryActivity,
  isExceptionActivity,
} from '../src/lib/ups/codes';

const NOW = new Date('2026-08-26T13:00:00Z');
// NOW is Wed 2026-08-26 09:00 Eastern.
const base = {
  labelCreatedAt: null as Date | null,
  firstCarrierScanAt: null as Date | null,
  deliveredAt: null as Date | null,
  hasException: false,
  voided: false,
  manuallyResolved: false,
  agingThresholdHours: 24,
  // Overdue is now a calendar judgement, so the service matters: it decides
  // whether a Thu/Fri label was printed for the same day or held for Monday.
  service: 'UPS 2nd Day Air®',
};

describe('deriveStatus — the LABEL CREATED != SHIPPED rule', () => {
  test('a fresh label with no UPS scan is LABEL_CREATED, never SHIPPED', () => {
    const status = deriveStatus(
      { ...base, labelCreatedAt: new Date('2026-08-26T09:00:00Z') },
      NOW,
    );
    assert.equal(status, 'LABEL_CREATED');
    assert.equal(statusDisplay(status), 'Awaiting UPS');
  });

  test('a label past its expected hand-over day escalates to AGING_LABEL', () => {
    // Printed Mon 24th → expected out Mon → overdue after end of Tue 25th.
    const status = deriveStatus(
      { ...base, labelCreatedAt: new Date('2026-08-24T13:00:00Z') },
      NOW,
    );
    assert.equal(status, 'AGING_LABEL');
    assert.equal(statusDisplay(status), 'Overdue — No UPS Scan');
  });

  test('inside its window it is still LABEL_CREATED, however many hours old', () => {
    // Printed Tue 25th → expected out Tue → its grace day (Wed) has not closed,
    // so at Wed 09:00 it is 28 hours old and still not overdue. The flat rule
    // would have flagged this; the cadence rule does not.
    const status = deriveStatus(
      { ...base, labelCreatedAt: new Date('2026-08-25T09:00:00Z') },
      NOW,
    );
    assert.equal(status, 'LABEL_CREATED');
  });

  test('a physical scan promotes the shipment out of the attention set', () => {
    const status = deriveStatus(
      {
        ...base,
        labelCreatedAt: new Date('2026-08-25T09:00:00Z'),
        firstCarrierScanAt: new Date('2026-08-25T18:00:00Z'),
      },
      NOW,
    );
    assert.equal(status, 'IN_TRANSIT');
    assert.equal(refineMovementStatus(status, 1), 'SHIPPED');
    assert.equal(statusDisplay(refineMovementStatus(status, 1)), 'Confirmed Shipped');
    assert.equal(refineMovementStatus(status, 4), 'IN_TRANSIT');
  });

  test('an aged label that later gets scanned stops being an exception', () => {
    const aged = deriveStatus({ ...base, labelCreatedAt: new Date('2026-08-20T09:00:00Z') }, NOW);
    assert.equal(aged, 'AGING_LABEL');
    const scanned = deriveStatus(
      {
        ...base,
        labelCreatedAt: new Date('2026-08-20T09:00:00Z'),
        firstCarrierScanAt: new Date('2026-08-26T11:00:00Z'),
      },
      NOW,
    );
    assert.equal(scanned, 'IN_TRANSIT');
  });

  test('delivery outranks everything except a void', () => {
    assert.equal(
      deriveStatus(
        {
          ...base,
          labelCreatedAt: new Date('2026-08-20T09:00:00Z'),
          firstCarrierScanAt: new Date('2026-08-20T18:00:00Z'),
          deliveredAt: new Date('2026-08-22T15:00:00Z'),
          hasException: true,
        },
        NOW,
      ),
      'DELIVERED',
    );
  });

  test('a void outranks delivery', () => {
    assert.equal(
      deriveStatus({ ...base, deliveredAt: new Date(), voided: true }, NOW),
      'VOIDED',
    );
  });

  test('an exception outranks in-transit movement', () => {
    assert.equal(
      deriveStatus(
        {
          ...base,
          labelCreatedAt: new Date('2026-08-20T09:00:00Z'),
          firstCarrierScanAt: new Date('2026-08-20T18:00:00Z'),
          hasException: true,
        },
        NOW,
      ),
      'EXCEPTION',
    );
  });

  test('no label and no scan is UNKNOWN, not LABEL_CREATED', () => {
    assert.equal(deriveStatus({ ...base }, NOW), 'UNKNOWN');
  });

  test('ShipStation marking something shipped cannot by itself produce SHIPPED', () => {
    // There is deliberately no ShipStation input to deriveStatus. The only way
    // to leave the attention set is firstCarrierScanAt / deliveredAt.
    const status = deriveStatus(
      { ...base, labelCreatedAt: new Date('2026-08-26T09:00:00Z') },
      NOW,
    );
    assert.ok(STATUS_PRESENTATION[status].needsAttention);
  });
});

describe('needsAttention', () => {
  test('attention statuses flag, success statuses do not', () => {
    assert.equal(needsAttention('LABEL_CREATED', false), true);
    assert.equal(needsAttention('AGING_LABEL', false), true);
    assert.equal(needsAttention('EXCEPTION', false), true);
    assert.equal(needsAttention('SHIPPED', false), false);
    assert.equal(needsAttention('DELIVERED', false), false);
  });

  test('manual resolution clears attention', () => {
    assert.equal(needsAttention('AGING_LABEL', true), false);
    assert.equal(needsAttention('EXCEPTION', true), false);
  });
});

describe('UPS physical possession detection', () => {
  test('manifest pickup (label created) is NOT possession', () => {
    const activity = {
      statusType: 'M',
      statusCode: 'MP',
      description: 'Shipper created a label, UPS has not received the package yet.',
      logicalScan: true,
    };
    assert.equal(isManifestOnlyActivity(activity), true);
    assert.equal(isPhysicalPossessionScan(activity), false);
  });

  test('origin scan IS possession', () => {
    const activity = {
      statusType: 'I',
      statusCode: 'OR',
      description: 'Origin Scan',
      logicalScan: false,
    };
    assert.equal(isPhysicalPossessionScan(activity), true);
  });

  test('pickup scan IS possession', () => {
    assert.equal(
      isPhysicalPossessionScan({
        statusType: 'P',
        statusCode: 'PU',
        description: 'Pickup Scan',
        logicalScan: false,
      }),
      true,
    );
  });

  /**
   * This assertion used to read the other way round: logicalScan=true vetoed
   * possession even for a named movement code. Live UPS data (2026-08-26)
   * disproved the premise — this account returns logicalScan=true on every
   * AR/DP facility scan and logicalScan=false on manifest events, i.e. the flag
   * is unreliable in both directions. A package cannot arrive at a UPS facility
   * unless UPS is holding it, so a named possession code now outranks the flag.
   */
  test('a named possession code outranks logicalScan=true', () => {
    assert.equal(
      isPhysicalPossessionScan({
        statusType: 'I',
        statusCode: 'AR',
        description: 'Arrival Scan',
        logicalScan: true,
      }),
      true,
    );
  });

  test('logicalScan=true still vetoes an UNNAMED code', () => {
    // The veto survives precisely where it earns its keep: events we cannot
    // classify. This is what keeps the rule failing closed.
    assert.equal(
      isPhysicalPossessionScan({
        statusType: 'I',
        statusCode: 'QQ',
        description: 'Some future UPS event',
        logicalScan: true,
      }),
      false,
    );
  });

  test('logicalScan can never promote a manifest event', () => {
    assert.equal(
      isPhysicalPossessionScan({
        statusType: 'M',
        statusCode: 'MP',
        description: 'Shipper created a label, UPS has not received the package yet.',
        logicalScan: false,
      }),
      false,
      'LABEL CREATED != SHIPPED, whatever logicalScan says',
    );
  });

  test('an unknown type with no code fails closed', () => {
    assert.equal(
      isPhysicalPossessionScan({ statusType: 'Z', statusCode: null, description: 'Who knows' }),
      false,
    );
  });

  test('label-created wording is caught even when type/code are missing', () => {
    assert.equal(
      isPhysicalPossessionScan({
        statusType: null,
        statusCode: null,
        description: 'Order Processed: Ready for UPS',
      }),
      false,
    );
    assert.equal(
      isPhysicalPossessionScan({
        statusType: null,
        statusCode: null,
        description: 'Billing Information Received',
      }),
      false,
    );
  });

  test('void detection', () => {
    assert.equal(isVoidActivity({ statusType: 'MV', statusCode: 'MV', description: 'Voided' }), true);
    assert.equal(
      isVoidActivity({ statusType: 'M', statusCode: 'MP', description: 'Billing Information Voided' }),
      true,
    );
    assert.equal(isVoidActivity({ statusType: 'I', statusCode: 'OR', description: 'Origin Scan' }), false);
  });

  test('a voided label is never possession', () => {
    assert.equal(
      isPhysicalPossessionScan({ statusType: 'MV', statusCode: 'MV', description: 'Voided', logicalScan: false }),
      false,
    );
  });

  test('delivery detection distinguishes delivered from out-for-delivery', () => {
    assert.equal(isDeliveryActivity({ statusType: 'D', statusCode: 'DL', description: 'Delivered' }), true);
    assert.equal(
      isDeliveryActivity({ statusType: 'D', statusCode: 'OT', description: 'Out For Delivery Today' }),
      false,
    );
  });

  test('out-for-delivery is still physical possession', () => {
    assert.equal(
      isPhysicalPossessionScan({
        statusType: 'D',
        statusCode: 'OT',
        description: 'Out For Delivery Today',
        logicalScan: false,
      }),
      true,
    );
  });

  test('exception detection', () => {
    assert.equal(isExceptionActivity({ statusType: 'X', statusCode: 'SR', description: 'Customs' }), true);
    assert.equal(
      isExceptionActivity({ statusType: 'I', statusCode: 'AR', description: 'Returned to Shipper' }),
      true,
    );
    assert.equal(isExceptionActivity({ statusType: 'I', statusCode: 'OR', description: 'Origin Scan' }), false);
  });
});
