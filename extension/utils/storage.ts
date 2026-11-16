/**
 * Persistent extension state.
 *
 * - storage.local: session (token, user), sync status, settings, per-user device ids.
 * - storage.sync:  only the `device_ids` map (user id → device id), so a reinstall on the same
 *                  browser profile keeps its device identity. Synced by the browser vendor; it
 *                  contains no keys, tokens or tab data.
 * - IndexedDB:     the master key as a NON-EXTRACTABLE CryptoKey bound to a user id. Script can
 *                  use it but cannot read its bytes. It is not password-protected at rest: anyone
 *                  with access to the unlocked browser profile can use it.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { browser } from 'wxt/browser';

export interface LastUpload {
  user_id: string;
  device_id: string;
  hash: string;
}

export interface LocalState {
  token?: string;
  user_id?: string;
  user_email?: string;
  device_name?: string;
  /** user id → this browser's device id for that user. Kept on logout. */
  device_ids?: Record<string, string>;

  last_sync_at?: string;
  last_tab_count?: number;
  sync_count?: number;
  last_error?: string;
  last_upload?: LastUpload;

  /** Email to pre-fill on the re-login screen after a session ended. */
  relogin_email?: string;

  /** Normalized host names that are never synced (see utils/domains.ts). */
  excluded_domains?: string[];
  sync_paused?: boolean;

  /** Lower-cased email → highest kdf_version seen (KDF downgrade protection). Kept on logout. */
  kdf_versions?: Record<string, number>;
}

export type StateKey = keyof LocalState;

const SESSION_KEYS: StateKey[] = [
  'token',
  'user_id',
  'user_email',
  'device_name',
  'last_sync_at',
  'last_tab_count',
  'sync_count',
  'last_error',
  'last_upload',
];

/** Keys written by versions before 1.0 that are no longer used. */
const LEGACY_KEYS = ['jwt_token', 'is_logged_in', 'device_id', 'master_key_stored'];

export async function loadState(): Promise<LocalState> {
  return (await browser.storage.local.get(null)) as LocalState;
}

/** Writes defined values and removes keys explicitly set to undefined. */
export async function patchState(patch: Partial<LocalState>): Promise<void> {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) remove.push(key);
    else set[key] = value;
  }
  if (Object.keys(set).length > 0) await browser.storage.local.set(set);
  if (remove.length > 0) await browser.storage.local.remove(remove);
}

// ─── KDF downgrade protection ──────────────────────────────────────────────────────────────────

export async function getKnownKdfVersion(email: string): Promise<number> {
  const { kdf_versions } = await loadState();
  return kdf_versions?.[email.trim().toLowerCase()] ?? 0;
}

export async function recordKdfVersion(email: string, version: number): Promise<void> {
  const key = email.trim().toLowerCase();
  const { kdf_versions = {} } = await loadState();
  if ((kdf_versions[key] ?? 0) >= version) return;
  await browser.storage.local.set({ kdf_versions: { ...kdf_versions, [key]: version } });
}

// ─── Device ids (per user) ─────────────────────────────────────────────────────────────────────

async function loadSyncedDeviceIds(): Promise<Record<string, string>> {
  try {
    const { device_ids } = (await browser.storage.sync.get('device_ids')) as {
      device_ids?: Record<string, string>;
    };
    return device_ids && typeof device_ids === 'object' ? device_ids : {};
  } catch {
    return {}; // storage.sync can be disabled (e.g. by policy)
  }
}

export async function getDeviceId(userId: string): Promise<string | undefined> {
  const { device_ids } = await loadState();
  return device_ids?.[userId] ?? (await loadSyncedDeviceIds())[userId];
}

export async function setDeviceId(userId: string, deviceId: string): Promise<void> {
  const { device_ids } = await loadState();
  const map = { ...(await loadSyncedDeviceIds()), ...device_ids, [userId]: deviceId };
  await browser.storage.local.set({ device_ids: map });
  try {
    await browser.storage.sync.set({ device_ids: map });
  } catch {
    // Mirroring is best effort.
  }
}

// ─── Master key (IndexedDB) ────────────────────────────────────────────────────────────────────

interface StoredKey {
  user_id: string;
  key: CryptoKey;
}

interface VaultTabsDB extends DBSchema {
  'crypto-keys': { key: string; value: StoredKey };
}

const MASTER_KEY_ID = 'master_key';
let dbPromise: Promise<IDBPDatabase<VaultTabsDB>> | null = null;

function getDB(): Promise<IDBPDatabase<VaultTabsDB>> {
  dbPromise ??= openDB<VaultTabsDB>('vaulttabs', 2, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (!db.objectStoreNames.contains('crypto-keys')) db.createObjectStore('crypto-keys');
      // v1 stored a bare (possibly extractable) key without an owner: drop it.
      else if (oldVersion < 2) void tx.objectStore('crypto-keys').clear();
    },
  });
  return dbPromise;
}

export async function saveMasterKey(userId: string, key: CryptoKey): Promise<void> {
  if (key.extractable) throw new Error('Refusing to store an extractable master key');
  await (await getDB()).put('crypto-keys', { user_id: userId, key }, MASTER_KEY_ID);
}

export async function loadMasterKey(userId: string): Promise<CryptoKey | null> {
  try {
    const stored = await (await getDB()).get('crypto-keys', MASTER_KEY_ID);
    return stored && stored.user_id === userId && stored.key instanceof CryptoKey ? stored.key : null;
  } catch {
    return null;
  }
}

export async function clearMasterKey(): Promise<void> {
  try {
    await (await getDB()).delete('crypto-keys', MASTER_KEY_ID);
  } catch {
    // Nothing to clear.
  }
}

// ─── Session ───────────────────────────────────────────────────────────────────────────────────

export interface ActiveSession {
  token: string;
  userId: string;
  email: string;
  deviceId: string;
  deviceName: string;
  masterKey: CryptoKey;
}

/** The fully usable session, or null if logged out / locked (no master key) / no device. */
export async function getActiveSession(): Promise<ActiveSession | null> {
  const state = await loadState();
  if (!state.token || !state.user_id) return null;
  const [deviceId, masterKey] = await Promise.all([getDeviceId(state.user_id), loadMasterKey(state.user_id)]);
  if (!deviceId || !masterKey) return null;
  return {
    token: state.token,
    userId: state.user_id,
    email: state.user_email ?? '',
    deviceId,
    deviceName: state.device_name ?? '',
    masterKey,
  };
}

export interface NewSession {
  token: string;
  userId: string;
  email: string;
  deviceId: string;
  deviceName: string;
  masterKey: CryptoKey;
}

/**
 * Persists a freshly authenticated session. The token is written last: the background script
 * starts syncing when it appears, and by then the key and device id are in place.
 */
export async function startSession(s: NewSession): Promise<void> {
  await saveMasterKey(s.userId, s.masterKey);
  await setDeviceId(s.userId, s.deviceId);
  await patchState({
    user_id: s.userId,
    user_email: s.email,
    device_name: s.deviceName,
    sync_count: 0,
    last_sync_at: undefined,
    last_tab_count: undefined,
    last_error: undefined,
    relogin_email: undefined,
  });
  await patchState({ token: s.token });
}

/** Explicit logout: forget the session and key; keep device ids and settings. */
export async function logout(): Promise<void> {
  await browser.storage.local.remove([...SESSION_KEYS, 'relogin_email']);
  await clearMasterKey();
}

/**
 * The server says the session is gone. Only acts if `token` is still the current token, so a
 * late response for an old session cannot end a newer one.
 */
export async function endSession(token: string, message: string): Promise<boolean> {
  const state = await loadState();
  if (!state.token || state.token !== token) return false;
  // Order matters: an open popup re-routes as soon as the token disappears and must by then find
  // the message and the email for the re-login screen, and no popup may ever read a half-removed
  // session (it would show a blank login form). So: message first, then every session key in ONE
  // removal, then the key.
  await patchState({ last_error: message, relogin_email: state.user_email });
  await browser.storage.local.remove(SESSION_KEYS.filter(k => k !== 'last_error'));
  await clearMasterKey();
  return true;
}

/** One-time migration from the pre-1.0 storage layout. */
export async function migrateLegacyState(): Promise<void> {
  const legacy = (await browser.storage.local.get(LEGACY_KEYS)) as Record<string, unknown>;
  if (Object.keys(legacy).length === 0) return;
  const state = await loadState();
  if (typeof legacy.device_id === 'string' && state.user_id && !state.device_ids?.[state.user_id]) {
    await setDeviceId(state.user_id, legacy.device_id);
  }
  // Old sessions used the legacy key format; require a fresh login.
  await browser.storage.local.remove([...LEGACY_KEYS, ...SESSION_KEYS]);
  await clearMasterKey();
  try {
    await browser.storage.sync.remove(['device_id', 'device_name']);
  } catch {
    // ignore
  }
}
