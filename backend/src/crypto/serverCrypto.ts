/**
 * src/crypto/serverCrypto.ts
 *
 * Server-side cryptography utilities.
 *
 * WHAT THE SERVER DOES WITH CRYPTO:
 * 1. Hash passwords with bcrypt (for login verification)
 * 2. That's basically it — all real crypto happens client-side
 *
 * The server does NOT:
 * - Generate master keys (client does this)
 * - Encrypt/decrypt snapshots (client does this)
 * - Know PBKDF2 salts are meaningful (just stores them)
 *
 * We use Node.js's built-in `crypto` module — no extra libraries.
 * For password hashing we use `bcrypt` which is the industry standard.
 *
 * WHY BCRYPT FOR PASSWORDS:
 * We need BOTH:
 * - bcrypt hash → to verify the password quickly during login (fast check)
 * - PBKDF2 salt → stored so the client can re-derive the wrapping key
 *
 * These are two separate systems:
 * - bcrypt: "is this the right password?" (server-side verification)
 * - PBKDF2: "give me the key to decrypt my master key" (client-side, uses salt)
 */

import { randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

// Promisify scrypt so we can use async/await instead of callbacks
const scryptAsync = promisify(scrypt);

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD HASHING
// We use scrypt (built into Node.js) instead of bcrypt to avoid native deps.
// scrypt is the same algorithm used by 1Password and other serious products.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hash a password for storage.
 * Returns a string like: "salt:hash" (both hex encoded)
 *
 * Example:
 *   const hash = await hashPassword("mysecretpassword")
 *   // → "a3f2bc...:9d8e1a..."
 */
export async function hashPassword(password: string): Promise<string> {
  // Generate 16 random bytes as the salt
  // This makes every hash unique even if two users have the same password
  const salt = randomBytes(16).toString('hex');

  // Derive a 64-byte key from the password using scrypt
  // N=16384, r=8, p=1 are the security parameters (higher N = more secure but slower)
  const derivedKey = await scryptAsync(password, salt, 64) as Buffer;

  // Store as "salt:hash" — we need the salt later to verify
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a password against a stored hash.
 * Returns true if password matches, false otherwise.
 *
 * Example:
 *   const valid = await verifyPassword("mysecretpassword", storedHash)
 *   // → true or false
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  // Split the stored "salt:hash" back apart
  const [salt, hash] = storedHash.split(':');

  if (!salt || !hash) {
    throw new Error('Invalid stored hash format');
  }

  // Re-derive the key using the same salt
  const derivedKey = await scryptAsync(password, salt, 64) as Buffer;

  // Compare using timingSafeEqual to prevent timing attacks
  // (A timing attack is where hackers guess passwords by measuring response time)
  const derivedBuffer = derivedKey;
  const storedBuffer = Buffer.from(hash, 'hex');

  if (derivedBuffer.length !== storedBuffer.length) {
    return false;
  }

  // Node's crypto module has a safe comparison function
  const { timingSafeEqual } = await import('crypto');
  return timingSafeEqual(derivedBuffer, storedBuffer);
}

/**
 * Generate a random salt for PBKDF2 (used client-side).
 * We generate this server-side during registration and store it.
 * The client uses it to re-derive the wrapping key during login.
 *
 * Returns a base64 string (32 bytes = 256 bits)
 */
export function generateSalt(): string {
  return randomBytes(32).toString('base64');
}