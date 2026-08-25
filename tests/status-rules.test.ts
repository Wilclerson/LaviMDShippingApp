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
const base = {
  labelCreatedAt: null as Date | null,
  firstCarrierScanAt: null as Date | null,
  deliveredAt: null as Date | null,
  hasException: false,
  voided: false,
  manuallyResolved: false,
  agingThresholdHours: 24,
};

describe('deriveStatus — the LABEL CREATED != SHIPPED rule', () => {
  test('a fresh label with no UPS scan is LABEL_CREATED, never SHIPPED', () => {
    const status = deriveStatus(
      { ...base, labelCreatedAt: new Date('2026-08-26T09:00:00Z') },
      NOW,
    );
    assert.equal(status, 'LABEL_CREATED');
    assert.equal(statusDisplay(status), '⚠️ Label Created — No Carrier Scan');
  });

  test('a label older than the threshold with no scan escalates to AGING_LABEL', () => {
    const status = deriveStatus(
      { ...base, labelCreatedAt: new Date('2026-08-25T09:00:00Z') },
      NOW,
    );
    assert.equal(status, 'AGING_LABEL');
    assert.equal(statusDisplay(status), '🚨 Label >24 Hours — No UPS Scan');
  });

  test('exactly at the 24 hour boundary it is already aging', () => {
    const status = deriveStatus(
      { ...base, labelCreatedAt: new Date('2026-08-25T13:00:00Z') },
      NOW,
    );
    assert.equal(status, 'AGING_LABEL');
  });

  test('one minute under the threshold it is still LABEL_CREATED', () => {
    const status = deriveStatus(
      { ...base, labelCreatedAt: new Date('2026-08-25T13:01:00Z') },
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
    assert.equal(statusDisplay(refineMovementStatus(status, 1)), '✅ Confirmed Shipped');
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

  test('logicalScan=true vetoes possession even with a movement-looking code', () => {
    assert.equal(
      isPhysicalPossessionScan({
        statusType: 'I',
        statusCode: 'AR',
        description: 'Arrival Scan',
        logicalScan: true,
      }),
      false,
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
