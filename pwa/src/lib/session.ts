/**
 * Session and master-key storage for the web dashboard.
 *
 *  - localStorage holds the JWT, the PublicUser and the CryptoParams (salt, iterations, wrapped
 *    master key). That is enough to unlock the vault OFFLINE with the password, and none of it lets
 *    anyone decrypt anything without the password.
 *  - The master key itself is a NON-EXTRACTABLE CryptoKey. It lives in memory only, unless the user
 *    ticked "Remember this browser", in which case the same non-extractable handle is also kept in
 *    IndexedDB so a reload does not lock the vault. Script on this origin can still USE a stored key
 *    (that is inherent to any web app), which is why the dashboard runs under a strict CSP and why
 *    "remember" is opt-in.
 *  - Lock = drop the key from memory and IndexedDB; the session (token) is kept so unlocking needs
 *    only the password.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CryptoParams, PublicUser } from '@vaulttabs/shared';

const SESSION_KEY = 'vaulttabs.session.v2';
const LOCK_SETTINGS_KEY = 'vaulttabs.lock.v1';
const LEGACY_SESSION_KEY = 'vaulttabs_session';
const LEGACY_DB_NAME = 'vaulttabs-pwa';
const DB_NAME = 'vaulttabs-web';
const KEY_ID = 'master_key';
const CHANNEL_NAME = 'vaulttabs';
/** Per-email highest kdf_version seen in this browser (kept across sign-out: downgrade protection). */
const KDF_VERSIONS_KEY = 'vaulttabs_kdf_versions';

export interface StoredSession {
  token: string;
  user: PublicUser;
  crypto: CryptoParams;
}

export const AUTO_LOCK_OPTIONS = [0, 5, 15, 60] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_OPTIONS)[number];

export interface LockSettings {
  /** Keep the (non-extractable) master key in IndexedDB across reloads. */
  rememberBrowser: boolean;
  /** Lock after this many idle minutes (0 = never). */
  autoLockMinutes: AutoLockMinutes;
}

const DEFAULT_LOCK_SETTINGS: LockSettings = { rememberBrowser: false, autoLockMinutes: 15 };

// ─── localStorage helpers ──────────────────────────────────────────────────────────────────────

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readJson<T>(key: string): T | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (!hasStorage()) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function isStoredSession(v: unknown): v is StoredSession {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<StoredSession>;
  return (
    typeof s.token === 'string' &&
    typeof s.user?.id === 'string' &&
    typeof s.user?.email === 'string' &&
    typeof s.crypto?.salt === 'string' &&
    typeof s.crypto?.encrypted_master_key === 'string' &&
    typeof s.crypto?.master_key_iv === 'string' &&
    typeof s.crypto?.kdf_version === 'number'
  );
}

/** Drop data written by the pre-v2 dashboard (password-based login, possibly extractable key). */
let legacyCleaned = false;
function cleanupLegacy(): void {
  if (legacyCleaned || !hasStorage()) return;
  legacyCleaned = true;
  try {
    if (window.localStorage.getItem(LEGACY_SESSION_KEY) !== null) {
      window.localStorage.removeItem(LEGACY_SESSION_KEY);
      window.indexedDB?.deleteDatabase(LEGACY_DB_NAME);
    }
  } catch {
    /* ignore */
  }
}

// ─── Session ───────────────────────────────────────────────────────────────────────────────────

export function getSession(): StoredSession | null {
  cleanupLegacy();
  const s = readJson<unknown>(SESSION_KEY);
  return isStoredSession(s) ? s : null;
}

export function setSession(session: StoredSession): void {
  writeJson(SESSION_KEY, session);
  recordKdfVersion(session.user.email, Math.max(session.crypto.kdf_version, session.user.kdf_version ?? 0));
}

// ─── KDF downgrade protection ──────────────────────────────────────────────────────────────────

function readKdfVersions(): Record<string, number> {
  const v = readJson<unknown>(KDF_VERSIONS_KEY);
  return typeof v === 'object' && v !== null ? (v as Record<string, number>) : {};
}

/** Highest kdf_version this browser has seen for the account (0 = never seen). */
export function getKnownKdfVersion(email: string): number {
  const v = readKdfVersions()[email.trim().toLowerCase()];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function recordKdfVersion(email: string, version: number): void {
  if (!email || !Number.isFinite(version)) return;
  const key = email.trim().toLowerCase();
  const all = readKdfVersions();
  if ((all[key] ?? 0) >= version) return;
  all[key] = version;
  writeJson(KDF_VERSIONS_KEY, all);
}

/** Merge fields into the stored session (no-op when signed out). Returns the new session. */
export function updateSession(patch: Partial<StoredSession>): StoredSession | null {
  const current = getSession();
  if (!current) return null;
  const next: StoredSession = {
    token: patch.token ?? current.token,
    user: patch.user ? { ...current.user, ...patch.user } : current.user,
    crypto: patch.crypto ?? current.crypto,
  };
  setSession(next);
  return next;
}

export function getToken(): string | null {
  return getSession()?.token ?? null;
}

// ─── Lock settings ─────────────────────────────────────────────────────────────────────────────

export function getLockSettings(): LockSettings {
  const s = readJson<Partial<LockSettings>>(LOCK_SETTINGS_KEY) ?? {};
  const minutes = (AUTO_LOCK_OPTIONS as readonly number[]).includes(s.autoLockMinutes ?? -1)
    ? (s.autoLockMinutes as AutoLockMinutes)
    : DEFAULT_LOCK_SETTINGS.autoLockMinutes;
  return {
    rememberBrowser:
      typeof s.rememberBrowser === 'boolean' ? s.rememberBrowser : DEFAULT_LOCK_SETTINGS.rememberBrowser,
    autoLockMinutes: minutes,
  };
}

export function setLockSettings(patch: Partial<LockSettings>): LockSettings {
  const next = { ...getLockSettings(), ...patch };
  writeJson(LOCK_SETTINGS_KEY, next);
  return next;
}

// ─── Master key (memory + optional IndexedDB) ──────────────────────────────────────────────────

interface KeyDB extends DBSchema {
  keys: { key: string; value: CryptoKey };
}

let dbPromise: Promise<IDBPDatabase<KeyDB>> | null = null;
function getDB(): Promise<IDBPDatabase<KeyDB>> {
  if (!dbPromise) {
    dbPromise = openDB<KeyDB>(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      },
    }).catch(err => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

let memoryKey: CryptoKey | null = null;

async function readStoredKey(): Promise<CryptoKey | null> {
  try {
    const key = (await (await getDB()).get('keys', KEY_ID)) ?? null;
    // Never use an extractable key from storage (only non-extractable handles are ever written).
    return key && !key.extractable ? key : null;
  } catch {
    return null;
  }
}

async function deleteStoredKey(): Promise<void> {
  try {
    await (await getDB()).delete('keys', KEY_ID);
  } catch {
    /* IndexedDB unavailable (private mode): nothing stored */
  }
}

/** The unlocked master key, or null when the vault is locked. */
export async function getMasterKey(): Promise<CryptoKey | null> {
  if (memoryKey) return memoryKey;
  if (!getSession()) return null;
  if (!getLockSettings().rememberBrowser) return null;
  const stored = await readStoredKey();
  if (stored) memoryKey = stored;
  return stored;
}

export function hasMasterKeyInMemory(): boolean {
  return memoryKey !== null;
}

/**
 * Keep the unlocked master key. It must already be non-extractable (use toNonExtractable()).
 * `remember` also persists the handle in IndexedDB; otherwise any stored copy is removed.
 */
export async function setMasterKey(key: CryptoKey, remember: boolean): Promise<void> {
  if (key.extractable) throw new Error('Refusing to store an extractable master key');
  memoryKey = key;
  setLockSettings({ rememberBrowser: remember });
  if (remember) {
    try {
      await (await getDB()).put('keys', key, KEY_ID);
    } catch {
      /* fall back to memory only */
    }
  } else {
    await deleteStoredKey();
  }
}

/** Change the "remember this browser" preference for the key that is currently unlocked. */
export async function setRememberBrowser(remember: boolean): Promise<void> {
  if (memoryKey) await setMasterKey(memoryKey, remember);
  else {
    setLockSettings({ rememberBrowser: remember });
    if (!remember) await deleteStoredKey();
  }
}

// ─── Cross-tab events ──────────────────────────────────────────────────────────────────────────

export type VaultEvent = 'lock' | 'signout';

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
}

/** Identifies this tab so it ignores its own broadcasts (it already handles its own navigation). */
const TAB_ID = Math.random().toString(36).slice(2);

function broadcast(event: VaultEvent): void {
  const ch = channel();
  if (!ch) return;
  ch.postMessage({ event, from: TAB_ID });
  ch.close();
}

/** Subscribe to lock / sign-out events from other tabs. Returns an unsubscribe function. */
export function onVaultEvent(cb: (event: VaultEvent) => void): () => void {
  const ch = channel();
  if (!ch) return () => {};
  ch.onmessage = (e: MessageEvent<{ event?: unknown; from?: unknown }>) => {
    const { event, from } = e.data ?? {};
    if (from === TAB_ID) return;
    if (event === 'lock' || event === 'signout') {
      memoryKey = null;
      cb(event);
    }
  };
  return () => ch.close();
}

/** Lock: forget the master key (memory + IndexedDB). The session stays, so unlocking is offline. */
export async function lockVault(opts: { broadcast?: boolean } = {}): Promise<void> {
  memoryKey = null;
  await deleteStoredKey();
  if (opts.broadcast !== false) broadcast('lock');
}

/** Forget everything locally (token, user, crypto params, key). Does not call the server. */
export async function clearLocalSession(opts: { broadcast?: boolean } = {}): Promise<void> {
  memoryKey = null;
  if (hasStorage()) window.localStorage.removeItem(SESSION_KEY);
  await deleteStoredKey();
  if (opts.broadcast !== false) broadcast('signout');
}
