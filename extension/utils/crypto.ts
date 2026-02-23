/**
 * utils/crypto.ts
 *
 * Cryptography utilities for VaultTabs.
 * Uses the WebCrypto API.
 */

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = 'SHA-256';
const AES_KEY_LENGTH = 256;
const AES_ALGORITHM = 'AES-GCM';

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function deriveWrappingKey(
  password: string,
  saltBase64: string
): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password);
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  const salt = base64ToBuffer(saltBase64);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    passwordKey,
    {
      name: AES_ALGORITHM,
      length: AES_KEY_LENGTH,
    },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

export function generateSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  return bufferToBase64(salt.buffer);
}

export async function generateMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    {
      name: AES_ALGORITHM,
      length: AES_KEY_LENGTH,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptMasterKey(
  masterKey: CryptoKey,
  wrappingKey: CryptoKey
): Promise<{ encryptedMasterKey: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const wrapped = await crypto.subtle.wrapKey(
    'raw',
    masterKey,
    wrappingKey,
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

export async function decryptMasterKey(
  encryptedMasterKeyBase64: string,
  ivBase64: string,
  wrappingKey: CryptoKey
): Promise<CryptoKey> {
  const encryptedBuffer = base64ToBuffer(encryptedMasterKeyBase64);
  const iv = base64ToBuffer(ivBase64);

  return crypto.subtle.unwrapKey(
    'raw',
    encryptedBuffer,
    wrappingKey,
    {
      name: AES_ALGORITHM,
      iv: iv,
    },
    {
      name: AES_ALGORITHM,
      length: AES_KEY_LENGTH,
    },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptSnapshot(
  tabs: TabSnapshot[],
  masterKey: CryptoKey
): Promise<{ encryptedBlob: string; iv: string }> {
  const json = JSON.stringify(tabs);
  const plaintext = new TextEncoder().encode(json);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: AES_ALGORITHM,
      iv: iv,
    },
    masterKey,
    plaintext
  );

  return {
    encryptedBlob: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
  };
}

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

export interface SnapshotPayload {
  device_id: string;
  captured_at: string;
  iv: string;
  encrypted_blob: string;
}

const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

export async function encryptMasterKeyForRecovery(
  masterKey: CryptoKey,
  recoveryCode: string
): Promise<{
  encryptedMasterKey: string;
  iv: string;
  salt: string;
}> {
  const salt = generateSalt();
  const wrappingKey = await deriveRecoveryWrappingKey(recoveryCode, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const wrapped = await crypto.subtle.wrapKey('raw', masterKey, wrappingKey, { name: 'AES-GCM', iv });

  return {
    encryptedMasterKey: bufferToBase64(wrapped),
    iv: bufferToBase64(iv.buffer),
    salt,
  };
}

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
    true,
    ['encrypt', 'decrypt']
  );
}

export async function hashRecoveryCode(recoveryCode: string): Promise<string> {
  const codeBytes = new TextEncoder().encode(recoveryCode.replace(/-/g, '').toUpperCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', codeBytes);
  return bufferToBase64(hashBuffer);
}