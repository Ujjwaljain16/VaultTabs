// Server-side hashing of password-equivalent secrets (v2 auth keys, legacy v1 passwords,
// recovery-code verifiers) and derivation of deterministic fake data for unknown accounts.
//
// Stored format: scrypt$<logN>$<r>$<p>$<saltB64>$<hashB64>
// Legacy format: <salthex>:<hashhex>   (scrypt N=16384, r=8, p=1, 64-byte key, salt = hex string)

import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const CURRENT = { logN: 15, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
const LEGACY_KEY_LEN = 64;

function scryptAsync(
  secret: string,
  salt: Buffer | string,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keyLen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function scryptOptions(logN: number, r: number, p: number): ScryptOptions {
  const N = 2 ** logN;
  // scrypt needs ~128 * N * r bytes; leave headroom over Node's 32 MiB default.
  return { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const { logN, r, p } = CURRENT;
  const hash = await scryptAsync(secret, salt, KEY_LEN, scryptOptions(logN, r, p));
  return `scrypt$${logN}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export interface VerifyResult {
  ok: boolean;
  /** The stored hash uses an outdated format/parameters and should be replaced after success. */
  needsRehash: boolean;
}

const MODERN_RE = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;
const LEGACY_RE = /^([0-9a-f]{16,128}):([0-9a-f]{128})$/i;

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<VerifyResult> {
  if (!stored) {
    await verifyAgainstDummy(secret);
    return { ok: false, needsRehash: false };
  }

  const modern = MODERN_RE.exec(stored);
  if (modern) {
    const [, logNs, rs, ps, saltB64, hashB64] = modern;
    const logN = Number(logNs);
    const r = Number(rs);
    const p = Number(ps);
    // Bound parameters so a corrupted row cannot make us allocate gigabytes.
    if (logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 16)
      return { ok: false, needsRehash: false };
    const expected = Buffer.from(hashB64!, 'base64');
    const actual = await scryptAsync(
      secret,
      Buffer.from(saltB64!, 'base64'),
      expected.length,
      scryptOptions(logN, r, p),
    );
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    const outdated = logN !== CURRENT.logN || r !== CURRENT.r || p !== CURRENT.p;
    return { ok, needsRehash: ok && outdated };
  }

  const legacy = LEGACY_RE.exec(stored);
  if (legacy) {
    const [, saltHex, hashHex] = legacy;
    // The legacy code passed the hex STRING itself as the salt.
    const actual = await scryptAsync(secret, saltHex!, LEGACY_KEY_LEN, scryptOptions(14, 8, 1));
    const expected = Buffer.from(hashHex!, 'hex');
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    return { ok, needsRehash: ok };
  }

  await verifyAgainstDummy(secret);
  return { ok: false, needsRehash: false };
}

let dummyHash: Promise<string> | undefined;

/** Burns the same scrypt time as a real verification (unknown email, missing verifier). */
export async function verifyAgainstDummy(secret: string): Promise<false> {
  dummyHash ??= hashSecret(randomBytes(32).toString('base64'));
  const stored = await dummyHash;
  const [, logN, r, p, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash!, 'base64');
  const actual = await scryptAsync(
    secret,
    Buffer.from(salt!, 'base64'),
    expected.length,
    scryptOptions(Number(logN), Number(r), Number(p)),
  );
  timingSafeEqual(expected, actual);
  return false;
}

/** Deterministic pseudo-random bytes: HMAC-SHA256(key, label|input|counter), expanded to `length`. */
export function deriveFakeBytes(key: Buffer, label: string, input: string, length: number): Buffer {
  const chunks: Buffer[] = [];
  for (let counter = 0; chunks.length * 32 < length; counter++) {
    chunks.push(createHmac('sha256', key).update(`vaulttabs/fake/${label}|${input}|${counter}`).digest());
  }
  return Buffer.concat(chunks).subarray(0, length);
}

/** True if `value` is canonical base64 that decodes to exactly `bytes` bytes. */
export function isBase64OfLength(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const buf = Buffer.from(value, 'base64');
  return buf.length === bytes && buf.toString('base64') === value;
}

/** True if `value` is canonical base64 decoding to between `min` and `max` bytes. */
export function isBase64InRange(value: string, min: number, max: number): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const buf = Buffer.from(value, 'base64');
  return buf.length >= min && buf.length <= max && buf.toString('base64') === value;
}
