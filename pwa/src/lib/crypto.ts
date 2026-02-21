/**
 * src/lib/crypto.ts
 *
 * Client-side cryptography for the PWA.
 *
 * THIS IS IDENTICAL TO THE EXTENSION'S crypto.ts — intentionally.
 * The same master key that encrypted snapshots in the extension
 * decrypts them here. Same PBKDF2 params, same AES-GCM params.
 * Any divergence = decryption failure.
 *
 * WebCrypto is built into every modern browser and mobile browser.
 * No libraries needed.
 */

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH       = 'SHA-256';
const AES_KEY_LENGTH    = 256;
const AES_ALGORITHM     = 'AES-GCM';

// ─── Buffer ↔ Base64 ──────────────────────────────────────────────────────────

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ─── Key derivation ───────────────────────────────────────────────────────────

/**
 * Derive the wrapping key from password + salt using PBKDF2.
 * Must use the exact same params as the extension — otherwise
 * the derived key will be different and decryption will fail.
 */
export async function deriveWrappingKey(password: string, saltBase64: string): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password);

  const passwordKey = await crypto.subtle.importKey(
    'raw', passwordBytes, 'PBKDF2', false, ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBuffer(saltBase64),
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    passwordKey,
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    false,
    ['unwrapKey']
  );
}

// ─── Master key decryption ────────────────────────────────────────────────────

/**
 * Decrypt the master key using the wrapping key.
 * Called after login — server returns the encrypted blob + iv.
 */
export async function decryptMasterKey(
  encryptedMasterKeyBase64: string,
  ivBase64: string,
  wrappingKey: CryptoKey
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    base64ToBuffer(encryptedMasterKeyBase64),
    wrappingKey,
    { name: AES_ALGORITHM, iv: base64ToBuffer(ivBase64) },
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    false,
    ['decrypt']
  );
}

// ─── Snapshot decryption ──────────────────────────────────────────────────────

export interface TabSnapshot {
  id: number;
  url: string;
  title: string;
  favIconUrl?: string;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
}

/**
 * Decrypt a tab snapshot blob back into a TabSnapshot array.
 * The blob was encrypted by the extension — we're just reversing it.
 */
export async function decryptSnapshot(
  encryptedBlobBase64: string,
  ivBase64: string,
  masterKey: CryptoKey
): Promise<TabSnapshot[]> {
  const plaintext = await crypto.subtle.decrypt(
    { name: AES_ALGORITHM, iv: base64ToBuffer(ivBase64) },
    masterKey,
    base64ToBuffer(encryptedBlobBase64)
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as TabSnapshot[];
}