import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../src/lib/auth/password';
import { can } from '../src/lib/auth/rbac';

describe('password hashing', () => {
  test('a correct password verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  test('a wrong password does not verify', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  test('the same password produces different hashes (unique salt)', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('correct horse battery staple', a), true);
    assert.equal(await verifyPassword('correct horse battery staple', b), true);
  });

  test('the plaintext never appears in the stored hash', async () => {
    const secret = 'supersecretpassword123';
    const hash = await hashPassword(secret);
    assert.ok(!hash.includes(secret));
    assert.ok(hash.startsWith('scrypt$'));
  });

  test('short passwords are rejected', async () => {
    await assert.rejects(() => hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)));
  });

  test('malformed stored hashes fail closed instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$x$y$z', 'bcrypt$1$2$3$4$5', 'scrypt$16384$8$1$$']) {
      assert.equal(await verifyPassword('anything', bad), false);
    }
  });
});

describe('role permissions', () => {
  test('admin can resolve exceptions and manage users', () => {
    assert.equal(can('admin', 'shipments:resolve'), true);
    assert.equal(can('admin', 'users:manage'), true);
    assert.equal(can('admin', 'sync:trigger'), true);
  });

  test('fulfillment can view, search and note but not resolve or manage users', () => {
    assert.equal(can('fulfillment', 'shipments:view'), true);
    assert.equal(can('fulfillment', 'shipments:search'), true);
    assert.equal(can('fulfillment', 'shipments:note'), true);
    assert.equal(can('fulfillment', 'shipments:resolve'), false);
    assert.equal(can('fulfillment', 'users:manage'), false);
    assert.equal(can('fulfillment', 'sync:trigger'), false);
  });
});
