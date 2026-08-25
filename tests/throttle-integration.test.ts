/**
 * Login throttling against a real database. Skipped without TEST_DATABASE_URL.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

const describeDb = TEST_DB ? describe : describe.skip;

describeDb('login throttling', () => {
  let throttle: typeof import('../src/lib/auth/throttle');
  let pool: typeof import('../src/lib/database/pool');

  const EMAIL = 'throttle-test@lavimd.store';
  const IP = '203.0.113.44';

  before(async () => {
    throttle = await import('../src/lib/auth/throttle');
    pool = await import('../src/lib/database/pool');
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM login_attempts WHERE identifier IN ($1, $2)`, [
      `email:${EMAIL}`,
      `ip:${IP}`,
    ]);
  });

  after(async () => {
    await pool.query(`DELETE FROM login_attempts WHERE identifier IN ($1, $2)`, [
      `email:${EMAIL}`,
      `ip:${IP}`,
    ]);
    await pool.closePool();
  });

  test('a fresh identifier is allowed', async () => {
    const decision = await throttle.checkLoginAllowed(EMAIL, IP);
    assert.equal(decision.allowed, true);
  });

  test('repeated failures for one email eventually block it', async () => {
    for (let i = 0; i < 7; i++) await throttle.recordLoginAttempt(EMAIL, null, false);
    assert.equal((await throttle.checkLoginAllowed(EMAIL, null)).allowed, true, '7 failures still allowed');

    await throttle.recordLoginAttempt(EMAIL, null, false);
    const blocked = await throttle.checkLoginAllowed(EMAIL, null);
    assert.equal(blocked.allowed, false, '8 failures must block');
    assert.ok(blocked.retryAfterMinutes > 0);
  });

  test('a successful sign-in clears the account lockout', async () => {
    for (let i = 0; i < 9; i++) await throttle.recordLoginAttempt(EMAIL, null, false);
    assert.equal((await throttle.checkLoginAllowed(EMAIL, null)).allowed, false);

    await throttle.recordLoginAttempt(EMAIL, null, true);
    assert.equal(
      (await throttle.checkLoginAllowed(EMAIL, null)).allowed,
      true,
      'a user who finally remembers their password must not stay locked out',
    );
  });

  test('email throttling does not block an unrelated account from the same IP', async () => {
    for (let i = 0; i < 10; i++) await throttle.recordLoginAttempt(EMAIL, null, false);
    const other = await throttle.checkLoginAllowed('someone-else@lavimd.store', null);
    assert.equal(other.allowed, true);
  });

  test('password spraying across accounts is caught by the IP limit', async () => {
    // 25 failures from one IP, each against a different email — no single email
    // reaches its own limit, but the IP does.
    for (let i = 0; i < 25; i++) {
      await throttle.recordLoginAttempt(`spray-${i}@lavimd.store`, IP, false);
    }
    const decision = await throttle.checkLoginAllowed('spray-victim@lavimd.store', IP);
    assert.equal(decision.allowed, false, 'the IP limit must catch a spray');

    // Cleanup for the spray identifiers.
    await pool.query(`DELETE FROM login_attempts WHERE identifier LIKE 'email:spray-%'`);
  });

  test('old attempts are purged', async () => {
    await throttle.recordLoginAttempt(EMAIL, null, false);
    await pool.query(
      `UPDATE login_attempts SET attempted_at = NOW() - INTERVAL '45 days' WHERE identifier = $1`,
      [`email:${EMAIL}`],
    );
    await throttle.purgeOldLoginAttempts();
    const remaining = await pool.query(`SELECT 1 FROM login_attempts WHERE identifier = $1`, [
      `email:${EMAIL}`,
    ]);
    assert.equal(remaining.length, 0);
  });
});
