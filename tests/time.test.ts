import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAge,
  formatLongDate,
  toLocalDateKey,
  parseUpsDateTime,
  parseUpsDateOnly,
  toUpsDateTimeString,
  localHourToUtc,
} from '../src/lib/time';

const TZ = 'America/New_York';

describe('age formatting', () => {
  const now = new Date('2026-08-26T13:00:00Z');
  test('renders days, hours and minutes', () => {
    assert.equal(formatAge(new Date('2026-08-23T09:00:00Z'), now), '3d 4h');
    assert.equal(formatAge(new Date('2026-08-26T07:48:00Z'), now), '5h 12m');
    assert.equal(formatAge(new Date('2026-08-26T12:18:00Z'), now), '42m');
  });
  test('null is an em dash and a future date does not go negative', () => {
    assert.equal(formatAge(null, now), '—');
    assert.equal(formatAge(new Date('2026-08-27T00:00:00Z'), now), '0m');
  });
});

describe('display timezone conversion', () => {
  test('a UTC instant renders as the correct Eastern calendar day', () => {
    // 01:30 UTC on the 27th is still 21:30 on the 26th in New York.
    assert.equal(toLocalDateKey(new Date('2026-08-27T01:30:00Z'), TZ), '2026-08-26');
    assert.equal(toLocalDateKey(new Date('2026-08-26T13:00:00Z'), TZ), '2026-08-26');
  });

  test('the email subject date uses the display timezone', () => {
    assert.equal(formatLongDate(new Date('2026-08-27T01:30:00Z'), TZ), 'August 26, 2026');
  });
});

describe('UPS timestamp parsing', () => {
  test('YYYYMMDD + HHMMSS with an offset resolves to the right instant', () => {
    assert.equal(
      parseUpsDateTime('20260824', '191500', '-04:00')?.toISOString(),
      '2026-08-24T23:15:00.000Z',
    );
  });

  test('without an offset the value is read as UTC', () => {
    assert.equal(parseUpsDateTime('20260824', '191500', null)?.toISOString(), '2026-08-24T19:15:00.000Z');
  });

  test('malformed input yields null rather than an Invalid Date', () => {
    assert.equal(parseUpsDateTime('2026824', '191500', null), null);
    assert.equal(parseUpsDateTime(undefined, '191500', null), null);
    assert.equal(parseUpsDateTime('20260824', 'garbage', null), null);
    assert.equal(parseUpsDateTime('', '', null), null);
  });

  test('a missing time defaults to midnight', () => {
    assert.equal(parseUpsDateTime('20260824', undefined, null)?.toISOString(), '2026-08-24T00:00:00.000Z');
  });

  test('date-only parsing', () => {
    assert.equal(parseUpsDateOnly('20260824'), '2026-08-24');
    assert.equal(parseUpsDateOnly('bad'), null);
    assert.equal(parseUpsDateOnly(null), null);
  });

  test('Quantum View range formatting round-trips', () => {
    assert.equal(toUpsDateTimeString(new Date('2026-08-24T19:15:07Z')), '20260824191507');
    assert.equal(toUpsDateTimeString(new Date('2026-01-05T04:03:02Z')), '20260105040302');
  });
});

describe('8 AM Eastern anchoring across daylight saving', () => {
  test('during EDT, 8 AM Eastern is 12:00 UTC', () => {
    const summer = localHourToUtc(new Date('2026-08-26T15:00:00Z'), 8, TZ);
    assert.equal(summer.toISOString(), '2026-08-26T12:00:00.000Z');
  });

  test('during EST, 8 AM Eastern is 13:00 UTC', () => {
    const winter = localHourToUtc(new Date('2026-01-15T15:00:00Z'), 8, TZ);
    assert.equal(winter.toISOString(), '2026-01-15T13:00:00.000Z');
  });

  test('the anchor lands on 8 AM local in both halves of the year', () => {
    for (const reference of ['2026-08-26T15:00:00Z', '2026-01-15T15:00:00Z', '2026-03-10T15:00:00Z']) {
      const anchored = localHourToUtc(new Date(reference), 8, TZ);
      const hour = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false })
        .format(anchored);
      assert.equal(Number.parseInt(hour, 10), 8, `failed for ${reference}`);
    }
  });
});
