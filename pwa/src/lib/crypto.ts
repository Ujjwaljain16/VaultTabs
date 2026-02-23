/**
 * utils/crypto.ts
 *
 * ALL cryptography for the VaultTabs extension lives here.
 *
 * ═══════════════════════════════════════════════════════════════
 * PLAIN ENGLISH EXPLANATION OF WHAT THIS FILE DOES
 * ═══════════════════════════════════════════════════════════════
 *
 * REGISTRATION (first time setup):
 * 1. You choose a password: "mysecretpassword"
 * 2. We generate a random PBKDF2 salt (32 random bytes)
 * 3. We use your password + salt to derive a "wrapping key"
 *    via PBKDF2 with 100,000 iterations. This is intentionally slow.
 * 4. We generate a random 256-bit AES master key (this encrypts your tabs)
 * 5. We encrypt the master key using the wrapping key (AES-GCM)
 * 6. We upload to the server: encrypted_master_key + master_key_iv + salt
 *    The server stores this encrypted blob. It can't read it.
 * 7. We store the DECRYPTED master key in memory (for tab encryption)
 *
 * LOGIN (subsequent sessions):
 * 1. Server returns: encrypted_master_key + master_key_iv + salt
 * 2. We re-derive the wrapping key: your password + stored salt → PBKDF2
 * 3. We decrypt the master key using the wrapping key
 * 4. Now we have the master key in memory again
 *
 * TAB ENCRYPTION:
 * 1. Collect all open tabs → JSON string
 * 2. Generate a fresh random IV (16 bytes)
 * 3. Encrypt with master key (AES-256-GCM)
 * 4. Upload: iv + encrypted_blob
 * 5. Server stores it without being able to read it
 *
 * WebCrypto API is built into every modern browser.
 * No libraries needed — this is native browser code.
 * ═══════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 100_000; // Higher = more secure, but slower. 100k is industry standard.
const PBKDF2_HASH = 'SHA-256';
const AES_KEY_LENGTH = 256; // bits
const AES_ALGORITHM = 'AES-GCM';

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Convert between ArrayBuffer and Base64
//
// WebCrypto works with ArrayBuffers (raw bytes).
// We need to convert to base64 strings to store/send over HTTP.
// ─────────────────────────────────────────────────────────────────────────────

/** Convert an ArrayBuffer to a base64 string */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert a base64 string back to an ArrayBuffer */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Derive a "wrapping key" from the user's password
//
// This uses PBKDF2 — Password-Based Key Derivation Function 2.
// It's slow by design. 100,000 rounds means brute-force guessing is expensive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives an AES-GCM key from a password and salt using PBKDF2.
 * This "wrapping key" is used ONLY to encrypt/decrypt the master key.
 * It's never stored or sent to the server.
 *
 * @param password - The user's password
 * @param saltBase64 - The PBKDF2 salt (stored on server, not secret)
 * @returns A CryptoKey (wrapping key) that can encrypt/decrypt the master key
 */
export async function deriveWrappingKey(
  password: string,
  saltBase64: string
): Promise<CryptoKey> {
  // 1. Convert password string to raw bytes
  const passwordBytes = new TextEncoder().encode(password);

  // 2. Import the password as a raw key material
  // "importKey" takes raw bytes and creates a CryptoKey object
  const passwordKey = await crypto.subtle.importKey(
    'raw',               // Format: raw bytes
    passwordBytes,       // The actual data
    'PBKDF2',           // Algorithm (we'll use this key to run PBKDF2)
    false,              // Not extractable (can't read the key back out)
    ['deriveBits', 'deriveKey'] // What we can do with this key
  );

  // 3. Derive the actual wrapping key using PBKDF2
  const salt = base64ToBuffer(saltBase64);

  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    passwordKey,          // Derived from this
    {
      name: AES_ALGORITHM,
      length: AES_KEY_LENGTH,
    },                    // Produce this type of key
    false,                // Not extractable
    ['wrapKey', 'unwrapKey'] // Used to wrap/unwrap the master key
  );

  return wrappingKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Generate a random salt for PBKDF2
// Called once during registration. Stored on the server.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a random 32-byte salt for PBKDF2.
 * Returns it as a base64 string.
 *
 * The salt is NOT secret — it just makes every user's derived key unique
 * even if they use the same password.
 */
export function generateSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  return bufferToBase64(salt.buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Generate the master key
// Called ONCE during registration. Used to encrypt all tab snapshots forever.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a random 256-bit AES-GCM master key.
 * This key is the crown jewel — it decrypts your tab data.
 *
 * The key is:
 * - Generated client-side (server never sees it)
 * - Stored client-side encrypted in IndexedDB
 * - Only the encrypted version goes to the server
 */
export async function generateMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    {
      name: AES_ALGORITHM,
      length: AES_KEY_LENGTH,
    },
    true, // Extractable = true, so we can wrap/export it
    ['encrypt', 'decrypt']
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Encrypt the master key with the wrapping key
// Called during registration. The result is uploaded to the server.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encrypts (wraps) the master key using the wrapping key.
 *
 * Returns:
 * - encryptedMasterKey: base64 string (stored on server)
 * - iv: base64 string (needed for decryption, stored on server, not secret)
 */
export async function encryptMasterKey(
  masterKey: CryptoKey,
  wrappingKey: CryptoKey
): Promise<{ encryptedMasterKey: string; iv: string }> {
  // AES-GCM requires a fresh random IV for every encryption
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes = 96 bits (standard for GCM)

  // "wrapKey" is like "encrypt" but specifically for encrypting CryptoKey objects
  const wrapped = await crypto.subtle.wrapKey(
    'raw',        // Export the master key in raw format before encrypting
    masterKey,    // The key to encrypt
    wrappingKey,  // Encrypt it using this key
    {
      name: AES_ALGORITHM,
      iv: iv,
    }
  );

  return {
    encryptedMasterKey: bufferToBase64(wrapped),
    iv: bufferToBase64(iv.buffer),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 (Login): Decrypt the master key using the wrapping key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decrypts (unwraps) the master key using the wrapping key.
 *
 * Called after login:
 * 1. Server gives us: encrypted_master_key, master_key_iv, salt
 * 2. We derive the wrapping key from password + salt
 * 3. We call this function to get the master key back
 */
export async function decryptMasterKey(
  encryptedMasterKeyBase64: string,
  ivBase64: string,
  wrappingKey: CryptoKey
): Promise<CryptoKey> {
  const encryptedBuffer = base64ToBuffer(encryptedMasterKeyBase64);
  const iv = base64ToBuffer(ivBase64);

  // "unwrapKey" decrypts the wrapped key bytes back into a real CryptoKey
  const masterKey = await crypto.subtle.unwrapKey(
    'raw',              // Format the inner key was exported as
    encryptedBuffer,    // The encrypted data
    wrappingKey,        // Decrypt with this
    {
      name: AES_ALGORITHM,
      iv: iv,
    },                  // Algorithm used during wrapKey
    {
      name: AES_ALGORITHM,
      length: AES_KEY_LENGTH,
    },                  // What type of key to produce
    false,              // Master key is NOT extractable (security)
    ['encrypt', 'decrypt']
  );

  return masterKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB ENCRYPTION: Encrypt a tab snapshot
// Called every 15 seconds to encrypt the current tab state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encrypts a tab snapshot using the master key.
 *
 * @param tabs - Array of tab objects (url, title, favicon, etc.)
 * @param masterKey - The decrypted master key
 * @returns { encryptedBlob, iv } - Both base64 strings, ready to upload
 */
export async function encryptSnapshot(
  tabs: TabSnapshot[],
  masterKey: CryptoKey
): Promise<{ encryptedBlob: string; iv: string }> {
  // 1. Convert tabs array to a JSON string, then to bytes
  const json = JSON.stringify(tabs);
  const plaintext = new TextEncoder().encode(json);

  // 2. Generate a fresh random IV for this snapshot
  // IMPORTANT: Every encryption must use a fresh IV. Never reuse IVs with AES-GCM.
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 3. Encrypt!
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: AES_ALGORITHM,
      iv: iv,
    },
    masterKey,  // Encrypt with the master key
    plaintext   // The data to encrypt
  );

  return {
    encryptedBlob: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
  };
}

/**
 * Decrypts a snapshot blob back to tab objects.
 * Used by the extension to restore tabs, and by the PWA to display them.
 */
export async function decryptSnapshot(
  encryptedBlobBase64: string,
  ivBase64: string,
  masterKey: CryptoKey
): Promise<TabSnapshot[]> {
  const ciphertext = base64ToBuffer(encryptedBlobBase64);
  const iv = base64ToBuffer(ivBase64);

  const plaintext = await crypto.subtle.decrypt(
    {
      name: AES_ALGORITHM,
      iv: iv,
    },
    masterKey,
    ciphertext
  );

  const json = new TextDecoder().decode(plaintext);
  return JSON.parse(json) as TabSnapshot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Represents one open tab in a snapshot */
export interface TabSnapshot {
  id: number;           // Browser tab ID (local, not persistent)
  url: string;          // Full URL
  title: string;        // Page title
  favIconUrl?: string;  // Favicon URL (optional)
  windowId: number;     // Which window the tab is in
  index: number;        // Tab position in the window
  active: boolean;      // Is this the currently focused tab?
  pinned: boolean;      // Is this tab pinned?
}

/** The full snapshot payload sent to the server */
export interface SnapshotPayload {
  device_id: string;
  captured_at: string;  // ISO timestamp
  iv: string;
  encrypted_blob: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECOVERY KEY CRYPTO
//
// A recovery key is a second way to decrypt the master key.
// If the user forgets their password, they can use this code instead.
//
// HOW IT WORKS:
// 1. Generate a random 24-character code (e.g. VAULT-A3F2-B9KL-C7MN-D4PQ)
// 2. Derive a wrapping key from the code using PBKDF2 (same algo as password)
// 3. Encrypt the master key with that wrapping key
// 4. Upload the encrypted copy + salt to the server
// 5. Show the plaintext code to the user ONCE — never stored anywhere
//
// The server stores: recovery_encrypted_master_key + recovery_key_iv + recovery_key_salt
// The user keeps: the 24-char plaintext code (written down / saved)
// ─────────────────────────────────────────────────────────────────────────────

const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I confusion

/**
 * Generates a random recovery code in the format:
 * VAULT-XXXX-XXXX-XXXX-XXXX
 *
 * Uses only unambiguous characters — no 0/O, 1/I confusion.
 * 20 random chars = ~103 bits of entropy. Unbreakable by brute force.
 */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes).map(b => RECOVERY_CODE_ALPHABET[b % RECOVERY_CODE_ALPHABET.length]);
  const groups = [
    chars.slice(0, 4).join(''),
    chars.slice(4, 8).join(''),
    chars.slice(8, 12).join(''),
    chars.slice(12, 16).join(''),
    chars.slice(16, 20).join(''),
  ];
  return `VAULT-${groups.join('-')}`;
}

/**
 * Derives a wrapping key from a recovery code using PBKDF2.
 * Identical algorithm to deriveWrappingKey — same security, different input.
 *
 * Uses fewer iterations (50k vs 100k) because the recovery code already has
 * very high entropy (103 bits) so brute force resistance from PBKDF2 is less critical.
 */
export async function deriveRecoveryWrappingKey(
  recoveryCode: string,
  saltBase64: string
): Promise<CryptoKey> {
  const codeBytes = new TextEncoder().encode(recoveryCode.replace(/-/g, '').toUpperCase());
  const codeKey = await crypto.subtle.importKey('raw', codeBytes, 'PBKDF2', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: base64ToBuffer(saltBase64), iterations: 50_000, hash: 'SHA-256' },
    codeKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Encrypts the master key using the recovery code wrapping key.
 * Returns the same shape as encryptMasterKey — compatible with the backend.
 */
export async function encryptMasterKeyForRecovery(
  masterKey: CryptoKey,
  recoveryCode: string
): Promise<{
  encryptedMasterKey: string;
  iv: string;
  salt: string;
}> {
  const salt = generateSalt(); // Fresh salt for the recovery key
  const wrappingKey = await deriveRecoveryWrappingKey(recoveryCode, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const wrapped = await crypto.subtle.wrapKey('raw', masterKey, wrappingKey, { name: 'AES-GCM', iv });

  return {
    encryptedMasterKey: bufferToBase64(wrapped),
    iv: bufferToBase64(iv.buffer),
    salt,
  };
}

/**
 * Decrypts the master key using a recovery code.
 * Called during account recovery — user enters their code + chooses new password.
 */
export async function decryptMasterKeyWithRecoveryCode(
  encryptedMasterKeyBase64: string,
  ivBase64: string,
  saltBase64: string,
  recoveryCode: string
): Promise<CryptoKey> {
  const wrappingKey = await deriveRecoveryWrappingKey(recoveryCode, saltBase64);

  return crypto.subtle.unwrapKey(
    'raw',
    base64ToBuffer(encryptedMasterKeyBase64),
    wrappingKey,
    { name: 'AES-GCM', iv: base64ToBuffer(ivBase64) },
    { name: 'AES-GCM', length: 256 },
    true, // Must be extractable so we can re-encrypt with new password
    ['encrypt', 'decrypt']
  );
}

/**
 * Hashes the recovery code using SHA-256.
 * We send THIS hash to the server instead of the plaintext code to maintain Zero-Knowledge.
 * The server then hashes this hash using scrypt to store it securely.
 */
export async function hashRecoveryCode(recoveryCode: string): Promise<string> {
  const codeBytes = new TextEncoder().encode(recoveryCode.replace(/-/g, '').toUpperCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', codeBytes);
  return bufferToBase64(hashBuffer);
}