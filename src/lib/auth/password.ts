/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt is memory-hard and is a supported choice for password storage; using
 * the built-in avoids shipping a native bcrypt/argon2 binary, which matters on
 * serverless runtimes where native modules are a recurring deployment hazard.
 *
 * Stored format:  scrypt$N$r$p$<salt-b64>$<hash-b64>
 * The parameters live in the string so they can be raised later without
 * invalidating existing hashes.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16384; // CPU/memory cost
const R = 8;     // block size
const P = 1;     // parallelisation
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEYLEN, {
    N, r: R, p: P, maxmem: MAXMEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const segments = stored.split('$');
    if (segments.length !== 6 || segments[0] !== 'scrypt') return false;

    const n = Number.parseInt(segments[1] ?? '', 10);
    const r = Number.parseInt(segments[2] ?? '', 10);
    const p = Number.parseInt(segments[3] ?? '', 10);
    const salt = Buffer.from(segments[4] ?? '', 'base64');
    const expected = Buffer.from(segments[5] ?? '', 'base64');

    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    if (salt.length === 0 || expected.length === 0) return false;

    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: n, r, p, maxmem: MAXMEM,
    });
    // Constant-time comparison — a length check first, since timingSafeEqual
    // throws on mismatched lengths.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same amount of CPU as a real verification. Called when the
 * email does not exist so that a missing account and a wrong password take
 * indistinguishable time.
 */
export async function dummyVerify(): Promise<void> {
  await scrypt('dummy-password-for-timing', randomBytes(16), KEYLEN, {
    N, r: R, p: P, maxmem: MAXMEM,
  });
}
