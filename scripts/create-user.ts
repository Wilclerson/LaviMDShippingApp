#!/usr/bin/env tsx
import './load-env';
/**
 * Create the first administrator (or any user) from the command line.
 *
 * Usage:
 *   npm run seed:admin -- --email you@lavimd.com --name "Your Name" --role admin
 *
 * The password is read from the ADMIN_PASSWORD environment variable, or from an
 * interactive prompt, so it never lands in shell history.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createUser } from '../src/lib/auth/users';
import { MIN_PASSWORD_LENGTH } from '../src/lib/auth/password';
import { closePool } from '../src/lib/database/pool';
import type { UserRole } from '../src/lib/types';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  const email = arg('email');
  const name = arg('name');
  const roleArg = (arg('role') ?? 'admin') as UserRole;

  if (!email || !name) {
    console.error('Usage: npm run seed:admin -- --email <email> --name "<name>" [--role admin|fulfillment]');
    process.exitCode = 1;
    return;
  }

  if (roleArg !== 'admin' && roleArg !== 'fulfillment') {
    console.error('--role must be "admin" or "fulfillment".');
    process.exitCode = 1;
    return;
  }

  let password = process.env.ADMIN_PASSWORD ?? '';
  if (!password) {
    const rl = createInterface({ input: stdin, output: stdout });
    password = await rl.question(`Password (min ${MIN_PASSWORD_LENGTH} characters): `);
    rl.close();
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exitCode = 1;
    return;
  }

  const user = await createUser({ email, name, role: roleArg, password });
  console.log(`Created ${user.role} "${user.name}" <${user.email}>.`);
}

main()
  .catch((err) => {
    console.error('Failed to create the user:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
