import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SHIPSTATION_API_KEY = 'ss-live-SUPERSECRETKEY1234567890';
process.env.UPS_CLIENT_SECRET = 'ups-secret-ABCDEFGHIJKLMNOP';
process.env.CRON_SECRET = 'cron-secret-QRSTUVWXYZ0123456789';

import { redact, resetSecretCache } from '../src/lib/logger';
import { safeEqual } from '../src/lib/auth/session';

describe('log redaction', () => {
  beforeEach(() => resetSecretCache());

  test('credential-looking keys are replaced at any depth', () => {
    const out = redact({
      apiKey: 'abc123',
      nested: { clientSecret: 'xyz', password: 'hunter2', authorization: 'Bearer zzz' },
      session: { token: 'tok' },
      safe: 'visible',
    }) as Record<string, unknown>;

    assert.equal(out.apiKey, '[REDACTED]');
    assert.equal(out.safe, 'visible');
    const nested = out.nested as Record<string, unknown>;
    assert.equal(nested.clientSecret, '[REDACTED]');
    assert.equal(nested.password, '[REDACTED]');
    assert.equal(nested.authorization, '[REDACTED]');
  });

  test('actual secret values are scrubbed wherever they appear', () => {
    const serialised = JSON.stringify(
      redact({
        message: `Request failed with key ss-live-SUPERSECRETKEY1234567890 attached`,
        url: 'https://api.shipstation.com?k=ss-live-SUPERSECRETKEY1234567890',
      }),
    );
    assert.ok(!serialised.includes('SUPERSECRETKEY'), 'the secret value must not survive');
    assert.ok(serialised.includes('[REDACTED]'));
  });

  test('bearer and basic tokens in free text are scrubbed', () => {
    const out = redact({ note: 'sent Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload' }) as { note: string };
    assert.ok(!out.note.includes('eyJhbGciOiJIUzI1NiJ9'));
    assert.ok(out.note.includes('[REDACTED]'));
  });

  test('errors are serialised with their message scrubbed', () => {
    const out = redact(new Error('failed using ups-secret-ABCDEFGHIJKLMNOP')) as { message: string };
    assert.ok(!out.message.includes('ABCDEFGHIJKLMNOP'));
  });

  test('redaction terminates on deeply nested and cyclic-ish input', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 30; i++) deep = { child: deep };
    const serialised = JSON.stringify(redact(deep));
    assert.ok(serialised.includes('depth-limit'));
  });
});

describe('constant-time secret comparison', () => {
  test('matching values compare equal', () => {
    assert.equal(safeEqual('abc123def456', 'abc123def456'), true);
  });

  test('different values, and different lengths, compare unequal', () => {
    assert.equal(safeEqual('abc123def456', 'abc123def457'), false);
    assert.equal(safeEqual('short', 'a-much-longer-value'), false);
    assert.equal(safeEqual('', 'x'), false);
  });

  test('a prefix of the real secret does not pass', () => {
    assert.equal(safeEqual('cron-secret', 'cron-secret-QRSTUVWXYZ0123456789'), false);
  });
});
