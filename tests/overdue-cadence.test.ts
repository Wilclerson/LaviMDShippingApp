/**
 * The cadence-based overdue rule.
 *
 * Lavi MD prints Thursday and Friday labels for Monday dispatch, so a flat
 * 24-hour rule flagged 36% of shipments that later scanned perfectly normally —
 * measured across 678 production shipments. A list that is a third false alarms
 * stops being read.
 *
 * Fixed clock throughout. 2026: Aug 24 = Monday … Aug 30 = Sunday.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  isBusinessDay,
  nextBusinessDay,
  onOrNextBusinessDay,
  weekdayOf,
  SHIPPING_HOLIDAYS,
} from '../src/lib/business-calendar';
import { planTender, evaluateOverdue, isGroundSafeService } from '../src/lib/shipment-normalizer/overdue';
import { deriveStatus } from '../src/lib/shipment-normalizer/status';

const AIR = 'UPS 2nd Day Air®';
const NEXT_DAY = 'UPS Next Day Air®';
const GROUND = 'UPS Ground';
const THREE_DAY = 'UPS 3 Day Select®';

/** Noon Eastern on a given day, as a UTC instant (EDT = UTC-4 in August). */
const at = (date: string, time = '12:00:00') => new Date(`${date}T${time}-04:00`);

describe('business calendar', () => {
  test('weekends are not business days', () => {
    assert.equal(isBusinessDay('2026-08-28'), true, 'Friday');
    assert.equal(isBusinessDay('2026-08-29'), false, 'Saturday');
    assert.equal(isBusinessDay('2026-08-30'), false, 'Sunday');
    assert.equal(isBusinessDay('2026-08-31'), true, 'Monday');
  });

  test('shipping holidays are not business days', () => {
    assert.ok(SHIPPING_HOLIDAYS.has('2026-09-07'), 'Labor Day 2026 is configured');
    assert.equal(isBusinessDay('2026-09-07'), false, 'Labor Day');
    assert.equal(isBusinessDay('2026-09-08'), true, 'the day after');
  });

  test('nextBusinessDay skips weekends and holidays together', () => {
    assert.equal(nextBusinessDay('2026-08-28'), '2026-08-31', 'Fri → Mon');
    assert.equal(nextBusinessDay('2026-09-04'), '2026-09-08', 'Fri → Tue over Labor Day');
  });

  test('onOrNextBusinessDay returns the day itself when it is open', () => {
    assert.equal(onOrNextBusinessDay('2026-08-26'), '2026-08-26');
    assert.equal(onOrNextBusinessDay('2026-08-29'), '2026-08-31', 'Sat → Mon');
  });

  test('date arithmetic does not drift across a DST boundary', () => {
    // 2026-11-01 is the US fall-back date.
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-11-01', 1), '2026-11-02');
    assert.equal(weekdayOf('2026-08-24'), 1, 'Monday');
    assert.equal(weekdayOf('2026-08-30'), 0, 'Sunday');
  });

  test('the calendar is configurable, not hard-coded to one holiday', () => {
    const custom = { holidays: new Set(['2026-08-26']) };
    assert.equal(isBusinessDay('2026-08-26', custom), false, 'a configured closure');
    assert.equal(isBusinessDay('2026-09-07', custom), true, 'Labor Day not in this set');
  });
});

describe('service classification', () => {
  test('Ground and 3 Day Select are Ground-safe', () => {
    assert.equal(isGroundSafeService(GROUND), true);
    assert.equal(isGroundSafeService(THREE_DAY), true);
    assert.equal(isGroundSafeService('Wwex UPS Ground'), true);
  });

  test('air services are not', () => {
    assert.equal(isGroundSafeService(AIR), false);
    assert.equal(isGroundSafeService(NEXT_DAY), false);
  });

  test('an unknown or missing service falls back to the air assumption', () => {
    // The forgiving direction: air gets the longer window, so a missing
    // service can never make a label overdue sooner than it should be.
    assert.equal(isGroundSafeService(null), false);
    assert.equal(isGroundSafeService(''), false);
  });
});

describe('expected tender day', () => {
  test('Monday–Wednesday ships the same day', () => {
    for (const day of ['2026-08-24', '2026-08-25', '2026-08-26']) {
      assert.equal(planTender(at(day), AIR).tenderDay, day, day);
    }
  });

  test('Thursday/Friday air is held for the next open Monday', () => {
    assert.equal(planTender(at('2026-08-27'), AIR).tenderDay, '2026-08-31', 'Thu → Mon');
    assert.equal(planTender(at('2026-08-28'), AIR).tenderDay, '2026-08-31', 'Fri → Mon');
    assert.equal(planTender(at('2026-08-28'), NEXT_DAY).tenderDay, '2026-08-31');
  });

  test('Thursday/Friday Ground-safe ships the same day', () => {
    assert.equal(planTender(at('2026-08-27'), GROUND).tenderDay, '2026-08-27');
    assert.equal(planTender(at('2026-08-28'), THREE_DAY).tenderDay, '2026-08-28');
  });

  test('weekend labels wait for the next business day', () => {
    assert.equal(planTender(at('2026-08-29'), AIR).tenderDay, '2026-08-31', 'Sat → Mon');
    assert.equal(planTender(at('2026-08-30'), GROUND).tenderDay, '2026-08-31', 'Sun → Mon');
  });

  test('a Friday air label before Labor Day waits for the Tuesday', () => {
    // Fri Sep 4 → the following Monday is Labor Day → next open day is Tue.
    assert.equal(planTender(at('2026-09-04'), AIR).tenderDay, '2026-09-08');
  });
});

describe('overdue deadline', () => {
  const check = (label: string, service: string) =>
    evaluateOverdue({ labelCreatedAt: at(label), service, minimumHours: 24, now: at(label) });

  test('the deadline is the end of the next business day after tender', () => {
    assert.equal(check('2026-08-24', AIR).plan.dueDay, '2026-08-25', 'Mon → due end of Tue');
    assert.equal(check('2026-08-26', AIR).plan.dueDay, '2026-08-27', 'Wed → due end of Thu');
    assert.equal(check('2026-08-27', GROUND).plan.dueDay, '2026-08-28', 'Thu ground → due end of Fri');
    assert.equal(check('2026-08-28', AIR).plan.dueDay, '2026-09-01', 'Fri air → due end of Tue');
    assert.equal(check('2026-08-28', GROUND).plan.dueDay, '2026-08-31', 'Fri ground → due end of Mon');
  });

  test('a Friday air label is NOT overdue over the weekend', () => {
    const monday = evaluateOverdue({
      labelCreatedAt: at('2026-08-28'),
      service: AIR,
      minimumHours: 24,
      now: at('2026-08-31', '09:00:00'), // Monday morning
    });
    assert.equal(monday.overdue, false, 'this is the false alarm the old rule produced');
  });

  test('but it does become overdue once the Tuesday closes', () => {
    const wednesday = evaluateOverdue({
      labelCreatedAt: at('2026-08-28'),
      service: AIR,
      minimumHours: 24,
      now: at('2026-09-02', '09:00:00'),
    });
    assert.equal(wednesday.overdue, true, 'a genuinely stuck Friday label still surfaces');
  });

  test('a Monday label overdue on Wednesday morning', () => {
    assert.equal(
      evaluateOverdue({ labelCreatedAt: at('2026-08-24'), service: AIR, minimumHours: 24, now: at('2026-08-25', '18:00:00') }).overdue,
      false,
      'still inside the grace day',
    );
    assert.equal(
      evaluateOverdue({ labelCreatedAt: at('2026-08-24'), service: AIR, minimumHours: 24, now: at('2026-08-26', '09:00:00') }).overdue,
      true,
    );
  });

  test('AGING_LABEL_HOURS is a floor that can only delay, never hasten', () => {
    // A huge floor pushes the alarm out past the cadence deadline.
    const withFloor = evaluateOverdue({
      labelCreatedAt: at('2026-08-24'),
      service: AIR,
      minimumHours: 240,
      now: at('2026-08-27'),
    });
    assert.equal(withFloor.overdue, false, 'the floor delayed it');

    // A tiny floor must NOT make it overdue before the cadence says so.
    const tinyFloor = evaluateOverdue({
      labelCreatedAt: at('2026-08-28'),
      service: AIR,
      minimumHours: 1,
      now: at('2026-08-29'),
    });
    assert.equal(tinyFloor.overdue, false, 'cadence still governs; the floor cannot hasten');
  });
});

describe('the possession rule is untouched', () => {
  const base = {
    labelCreatedAt: at('2026-08-24'),
    firstCarrierScanAt: null,
    deliveredAt: null,
    hasException: false,
    voided: false,
    manuallyResolved: false,
    agingThresholdHours: 24,
    service: AIR,
  };

  test('no scan is never SHIPPED, however recent the label', () => {
    assert.equal(deriveStatus(base, at('2026-08-24', '13:00:00')), 'LABEL_CREATED');
    assert.equal(deriveStatus(base, at('2026-08-27')), 'AGING_LABEL');
  });

  test('a physical scan promotes regardless of the cadence', () => {
    const scanned = { ...base, firstCarrierScanAt: at('2026-08-24', '18:00:00') };
    assert.equal(deriveStatus(scanned, at('2026-08-25')), 'IN_TRANSIT');
  });

  test('the cadence cannot promote anything on its own', () => {
    // A Friday air label inside its window is Awaiting, never Shipped.
    const friday = { ...base, labelCreatedAt: at('2026-08-28') };
    assert.equal(deriveStatus(friday, at('2026-08-31', '09:00:00')), 'LABEL_CREATED');
  });

  test('delivered and voided still outrank everything', () => {
    assert.equal(deriveStatus({ ...base, deliveredAt: at('2026-08-25') }, at('2026-08-27')), 'DELIVERED');
    assert.equal(deriveStatus({ ...base, voided: true }, at('2026-08-27')), 'VOIDED');
  });
});
