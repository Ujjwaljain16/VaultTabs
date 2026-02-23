/**
 * src/crypto/serverCrypto.ts
 *
 * Server-side cryptography utilities.
 * Uses built-in Node.js crypto for hashing passwords with scrypt.
 */

import { randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

/**
 * Hash a password for storage.
 * Returns a string like: "salt:hash" (both hex encoded)
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a password against a stored hash.
 * Returns true if password matches, false otherwise.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const [salt, hash] = storedHash.split(':');

  if (!salt || !hash) {
    throw new Error('Invalid stored hash format');
  }

  const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
  const derivedBuffer = derivedKey;
  const storedBuffer = Buffer.from(hash, 'hex');

  if (derivedBuffer.length !== storedBuffer.length) {
    return false;
  }

  const { timingSafeEqual } = await import('crypto');
  return timingSafeEqual(derivedBuffer, storedBuffer);
}

/**
 * Generate a random salt for PBKDF2 (used client-side).
 * Returns a base64 string (32 bytes = 256 bits)
 */
export function generateSalt(): string {
  return randomBytes(32).toString('base64');
}