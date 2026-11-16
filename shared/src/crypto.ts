/**
 * @vaulttabs/shared/crypto
 *
 * The ONE implementation of VaultTabs client-side cryptography, used by the extension and the PWA
 * (and by the backend tests). Pure WebCrypto: runs in browsers, extension service workers and
 * Node >= 20 (globalThis.crypto).
 *
 * ── Key hierarchy (kdf_version 2) ──────────────────────────────────────────────────────────────
 *
 *   password ──PBKDF2-HMAC-SHA256(salt, iterations ≥ 600k)──► root (256 bit, never leaves memory)
 *      root ──HKDF-SHA256(info "vaulttabs/v2/auth-key")──► auth_key  (sent to the server, which
 *                                                                     stores only scrypt(auth_key))
 *      root ──HKDF-SHA256(info "vaulttabs/v2/wrap-key")──► wrapping key (AES-256-GCM, never sent)
 *
 *   master key: random AES-256-GCM key. Stored on the server only wrapped by the wrapping key and
 *   by a recovery-code-derived key. HKDF outputs are independent, so knowing auth_key tells the
 *   server nothing about the wrapping key: the server cannot decrypt snapshots.
 *
 * ── Legacy (kdf_version 1) ─────────────────────────────────────────────────────────────────────
 *   The password itself was sent to the server and PBKDF2(password, salt, 100k) was the wrapping
 *   key. Only used to log in legacy accounts once so they can be upgraded to v2.
 *
 * ── Ciphertexts ────────────────────────────────────────────────────────────────────────────────
 *   Snapshot v2: AES-GCM with additional authenticated data binding it to user, device and capture
 *   time, so a server cannot move a snapshot to another device or relabel an old one as new.
 *   Restore payloads ("send tab") and saved-session labels are bound the same way.
 */

import type { TabSnapshot } from './models.js';

// ─── Parameters ────────────────────────────────────────────────────────────────────────────────

export const KDF_VERSION_LEGACY = 1 as const;
export const KDF_VERSION_CURRENT = 2 as const;
export type KdfVersion = typeof KDF_VERSION_LEGACY | typeof KDF_VERSION_CURRENT;

/** OWASP 2023+ guidance for PBKDF2-HMAC-SHA256. */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
/** The server rejects v2 material with fewer iterations than this. */
export const MIN_PBKDF2_ITERATIONS = 600_000;
/** Upper bound so a malicious server cannot make the client hang. */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;

const LEGACY_PBKDF2_ITERATIONS = 100_000;
const RECOVERY_PBKDF2_ITERATIONS = 50_000; // recovery codes carry ~100 bits of entropy

export const SNAPSHOT_ENC_LEGACY = 1 as const;
export const SNAPSHOT_ENC_CURRENT = 2 as const;
export type SnapshotEncVersion = typeof SNAPSHOT_ENC_LEGACY | typeof SNAPSHOT_ENC_CURRENT;

const AES = 'AES-GCM';
const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available (a secure context / HTTPS is required).');
  return c.subtle;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// ─── Encoding ──────────────────────────────────────────────────────────────────────────────────

export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Account keys ──────────────────────────────────────────────────────────────────────────────

export function generateSalt(): string {
  return bufferToBase64(randomBytes(32));
}

export function assertSaneIterations(iterations: number): void {
  if (
    !Number.isInteger(iterations) ||
    iterations < MIN_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error(`Refusing unsafe KDF iteration count: ${iterations}`);
  }
}

export interface AccountKeys {
  /** Base64 of 32 bytes. This, not the password, is what the server sees. */
  authKey: string;
  /** Non-extractable AES-GCM key that wraps/unwraps the master key. Never leaves the client. */
  wrappingKey: CryptoKey;
}

/** kdf_version 2: derive the server auth key and the local wrapping key from the password. */
export async function deriveAccountKeys(
  password: string,
  saltBase64: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<AccountKeys> {
  assertSaneIterations(iterations);
  const s = subtle();
  const salt = base64ToBytes(saltBase64);
  const pwKey = await s.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const rootBits = await s.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, pwKey, 256);
  const root = await s.importKey('raw', rootBits, 'HKDF', false, ['deriveBits', 'deriveKey']);

  const authBits = await s.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('vaulttabs/v2/auth-key') },
    root,
    256,
  );
  const wrappingKey = await s.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('vaulttabs/v2/wrap-key') },
    root,
    { name: AES, length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
  return { authKey: bufferToBase64(authBits), wrappingKey };
}

/** kdf_version 1 (legacy): PBKDF2(password) used directly as the wrapping key. */
export async function deriveLegacyWrappingKey(password: string, saltBase64: string): Promise<CryptoKey> {
  const s = subtle();
  const pwKey = await s.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(saltBase64),
      iterations: LEGACY_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    pwKey,
    { name: AES, length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// ─── Master key ────────────────────────────────────────────────────────────────────────────────

/** A fresh, extractable master key (extractable only so it can be wrapped right away). */
export async function generateMasterKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: AES, length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

export interface WrappedKey {
  encrypted_master_key: string;
  master_key_iv: string;
}

export async function wrapMasterKey(masterKey: CryptoKey, wrappingKey: CryptoKey): Promise<WrappedKey> {
  const iv = randomBytes(12);
  const wrapped = await subtle().wrapKey('raw', masterKey, wrappingKey, { name: AES, iv });
  return { encrypted_master_key: bufferToBase64(wrapped), master_key_iv: bufferToBase64(iv) };
}

/**
 * Unwrap the master key. Keep `extractable` false for the copy you store; only pass true when the
 * key must be re-wrapped right away (password change, new recovery code, KDF upgrade).
 */
export async function unwrapMasterKey(
  encryptedMasterKey: string,
  iv: string,
  wrappingKey: CryptoKey,
  extractable = false,
): Promise<CryptoKey> {
  return subtle().unwrapKey(
    'raw',
    base64ToBytes(encryptedMasterKey),
    wrappingKey,
    { name: AES, iv: base64ToBytes(iv) },
    { name: AES, length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

/** Re-import an extractable master key as non-extractable for storage. */
export async function toNonExtractable(masterKey: CryptoKey): Promise<CryptoKey> {
  if (!masterKey.extractable) return masterKey;
  const raw = await subtle().exportKey('raw', masterKey);
  try {
    return await subtle().importKey('raw', raw, { name: AES }, false, ['encrypt', 'decrypt']);
  } finally {
    new Uint8Array(raw).fill(0);
  }
}

// ─── Recovery code ─────────────────────────────────────────────────────────────────────────────

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols → 5 bits each, no bias

/** `VAULT-XXXX-XXXX-XXXX-XXXX-XXXX` with 100 bits of entropy. */
export function generateRecoveryCode(): string {
  const chars = Array.from(randomBytes(20), b => RECOVERY_ALPHABET[b % 32]);
  const groups: string[] = [];
  for (let i = 0; i < 20; i += 4) groups.push(chars.slice(i, i + 4).join(''));
  return `VAULT-${groups.join('-')}`;
}

/** Canonical form used for hashing/derivation: upper case, no dashes/spaces. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/** Plausibility check before contacting the server (accepts with or without the VAULT prefix). */
export function isWellFormedRecoveryCode(code: string): boolean {
  const n = normalizeRecoveryCode(code).replace(/^VAULT/, '');
  return n.length === 20 && [...n].every(c => RECOVERY_ALPHABET.includes(c));
}

/** The verifier sent to the server (it stores scrypt of this). Base64 SHA-256 of the code. */
export async function hashRecoveryCode(code: string): Promise<string> {
  return bufferToBase64(await subtle().digest('SHA-256', enc.encode(normalizeRecoveryCode(code))));
}

async function deriveRecoveryWrappingKey(code: string, saltBase64: string): Promise<CryptoKey> {
  const s = subtle();
  const codeKey = await s.importKey('raw', enc.encode(normalizeRecoveryCode(code)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return s.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(saltBase64),
      iterations: RECOVERY_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    codeKey,
    { name: AES, length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

export interface RecoveryMaterial {
  recovery_encrypted_master_key: string;
  recovery_key_iv: string;
  recovery_key_salt: string;
  recovery_key_hash: string;
}

/** Wrap an (extractable) master key under a recovery code. */
export async function createRecoveryMaterial(masterKey: CryptoKey, code: string): Promise<RecoveryMaterial> {
  const salt = generateSalt();
  const key = await deriveRecoveryWrappingKey(code, salt);
  const iv = randomBytes(12);
  const wrapped = await subtle().wrapKey('raw', masterKey, key, { name: AES, iv });
  return {
    recovery_encrypted_master_key: bufferToBase64(wrapped),
    recovery_key_iv: bufferToBase64(iv),
    recovery_key_salt: salt,
    recovery_key_hash: await hashRecoveryCode(code),
  };
}

/** Returns an EXTRACTABLE key: recovery always re-wraps it under the new password. */
export async function unwrapMasterKeyWithRecoveryCode(
  encryptedMasterKey: string,
  iv: string,
  saltBase64: string,
  code: string,
): Promise<CryptoKey> {
  const key = await deriveRecoveryWrappingKey(code, saltBase64);
  return unwrapMasterKey(encryptedMasterKey, iv, key, true);
}

// ─── High-level account flows ──────────────────────────────────────────────────────────────────

export interface PasswordMaterial extends WrappedKey {
  auth_key: string;
  salt: string;
  kdf_iterations: number;
  kdf_version: typeof KDF_VERSION_CURRENT;
}

/** Wrap `masterKey` (must be extractable) under a password with fresh salt → server payload. */
export async function createPasswordMaterial(
  masterKey: CryptoKey,
  password: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<PasswordMaterial> {
  const salt = generateSalt();
  const { authKey, wrappingKey } = await deriveAccountKeys(password, salt, iterations);
  return {
    auth_key: authKey,
    salt,
    kdf_iterations: iterations,
    kdf_version: KDF_VERSION_CURRENT,
    ...(await wrapMasterKey(masterKey, wrappingKey)),
  };
}

/** Everything a new account needs. Show `recoveryCode` to the user exactly once. */
export async function createAccountMaterial(
  password: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
) {
  const masterKey = await generateMasterKey();
  const recoveryCode = generateRecoveryCode();
  const [passwordMaterial, recovery] = await Promise.all([
    createPasswordMaterial(masterKey, password, iterations),
    createRecoveryMaterial(masterKey, recoveryCode),
  ]);
  return {
    masterKey: await toNonExtractable(masterKey),
    recoveryCode,
    payload: { ...passwordMaterial, ...recovery },
  };
}

// ─── Authenticated encryption helpers ──────────────────────────────────────────────────────────

async function encryptBytes(plaintext: Uint8Array<ArrayBuffer>, key: CryptoKey, aad?: string) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt(
    { name: AES, iv, ...(aad !== undefined ? { additionalData: enc.encode(aad) } : {}) },
    key,
    plaintext,
  );
  return { ciphertext: bufferToBase64(ct), iv: bufferToBase64(iv) };
}

async function decryptBytes(
  ciphertext: string,
  iv: string,
  key: CryptoKey,
  aad?: string,
): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: AES, iv: base64ToBytes(iv), ...(aad !== undefined ? { additionalData: enc.encode(aad) } : {}) },
    key,
    base64ToBytes(ciphertext),
  );
  return new Uint8Array(pt);
}

/** Canonical timestamp form used inside AAD (both sides must agree byte-for-byte). */
export function canonicalTimestamp(t: string | Date): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid timestamp');
  return d.toISOString();
}

export interface SnapshotContext {
  userId: string;
  deviceId: string;
  capturedAt: string | Date;
}

function snapshotAad(ctx: SnapshotContext): string {
  return `vaulttabs/snapshot/v2|${ctx.userId}|${ctx.deviceId}|${canonicalTimestamp(ctx.capturedAt)}`;
}

export async function encryptSnapshot(
  tabs: TabSnapshot[],
  masterKey: CryptoKey,
  ctx: SnapshotContext,
): Promise<{ encrypted_blob: string; iv: string; enc_version: typeof SNAPSHOT_ENC_CURRENT }> {
  const { ciphertext, iv } = await encryptBytes(
    enc.encode(JSON.stringify(tabs)),
    masterKey,
    snapshotAad(ctx),
  );
  return { encrypted_blob: ciphertext, iv, enc_version: SNAPSHOT_ENC_CURRENT };
}

/**
 * Decrypt a snapshot. For enc_version 2 the context MUST come from what the client trusts/displays
 * (its own user id, the device the snapshot is shown under, the timestamp it shows): decryption
 * fails if the server moved or relabelled the snapshot.
 */
export async function decryptSnapshot(
  encryptedBlob: string,
  iv: string,
  masterKey: CryptoKey,
  encVersion: number,
  ctx: SnapshotContext,
): Promise<TabSnapshot[]> {
  const aad = encVersion === SNAPSHOT_ENC_CURRENT ? snapshotAad(ctx) : undefined;
  if (encVersion !== SNAPSHOT_ENC_CURRENT && encVersion !== SNAPSHOT_ENC_LEGACY) {
    throw new Error(`Unsupported snapshot version ${encVersion}`);
  }
  const parsed: unknown = JSON.parse(dec.decode(await decryptBytes(encryptedBlob, iv, masterKey, aad)));
  if (!Array.isArray(parsed)) throw new Error('Malformed snapshot');
  return parsed.filter(isTabLike).map(t => ({
    id: Number(t.id) || 0,
    url: String(t.url),
    title: typeof t.title === 'string' ? t.title : 'Untitled',
    favIconUrl: typeof t.favIconUrl === 'string' ? t.favIconUrl : undefined,
    windowId: Number(t.windowId) || 0,
    index: Number(t.index) || 0,
    active: Boolean(t.active),
    pinned: Boolean(t.pinned),
  }));
}

function isTabLike(t: unknown): t is Record<string, unknown> & { url: string } {
  return typeof t === 'object' && t !== null && typeof (t as { url?: unknown }).url === 'string';
}

// ─── "Send tab" payloads ───────────────────────────────────────────────────────────────────────

export interface RestorePayload {
  urls: string[];
}

export interface RestoreContext {
  userId: string;
  targetDeviceId: string;
}

function restoreAad(ctx: RestoreContext): string {
  return `vaulttabs/restore/v1|${ctx.userId}|${ctx.targetDeviceId}`;
}

export async function encryptRestorePayload(
  payload: RestorePayload,
  masterKey: CryptoKey,
  ctx: RestoreContext,
) {
  const urls = payload.urls.filter(isSafeTabUrl);
  if (urls.length === 0) throw new Error('Nothing to send: only http(s) URLs are allowed');
  const { ciphertext, iv } = await encryptBytes(
    enc.encode(JSON.stringify({ urls })),
    masterKey,
    restoreAad(ctx),
  );
  return { encrypted_payload: ciphertext, payload_iv: iv };
}

export async function decryptRestorePayload(
  encryptedPayload: string,
  iv: string,
  masterKey: CryptoKey,
  ctx: RestoreContext,
): Promise<RestorePayload> {
  const parsed = JSON.parse(
    dec.decode(await decryptBytes(encryptedPayload, iv, masterKey, restoreAad(ctx))),
  ) as {
    urls?: unknown;
  };
  const urls = Array.isArray(parsed.urls)
    ? parsed.urls.filter((u): u is string => typeof u === 'string')
    : [];
  return { urls: urls.filter(isSafeTabUrl) };
}

// ─── Saved-session labels ──────────────────────────────────────────────────────────────────────

function labelAad(userId: string, snapshotId: string): string {
  return `vaulttabs/label/v1|${userId}|${snapshotId}`;
}

export async function encryptLabel(label: string, masterKey: CryptoKey, userId: string, snapshotId: string) {
  const { ciphertext, iv } = await encryptBytes(enc.encode(label), masterKey, labelAad(userId, snapshotId));
  return { label_enc: ciphertext, label_iv: iv };
}

export async function decryptLabel(
  labelEnc: string,
  iv: string,
  masterKey: CryptoKey,
  userId: string,
  snapshotId: string,
): Promise<string> {
  return dec.decode(await decryptBytes(labelEnc, iv, masterKey, labelAad(userId, snapshotId)));
}

// ─── Misc ──────────────────────────────────────────────────────────────────────────────────────

/** Only http(s) URLs are ever captured or opened (never javascript:, data:, file:, chrome: ...). */
export function isSafeTabUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 8192) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Stable SHA-256 hex digest, e.g. to detect unchanged tab lists. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
