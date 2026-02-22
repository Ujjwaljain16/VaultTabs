/**
 * utils/storage.ts
 *
 * Manages ALL persistent storage for the extension.
 *
 * TWO STORAGE SYSTEMS:
 *
 * 1. chrome.storage.local  → Simple key/value, survives restart, 10MB limit.
 *    Used for: JWT token, user info, device ID, sync stats, error state.
 *    Cannot store CryptoKey objects (not serializable).
 *
 * 2. IndexedDB (via "idb") → Full in-browser database.
 *    Used for: the CryptoKey master key object (stored natively, not serialized).
 *    Sandboxed to the extension — web pages cannot access it.
 *
 * SECURITY NOTE ON MASTER KEY IN INDEXEDDB:
 * The master key is marked non-extractable, so its raw bytes can never be
 * read out of the CryptoKey object even by our own code. IndexedDB stores
 * the opaque handle. This is the same pattern used by password managers.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';

// ─────────────────────────────────────────────────────────────────────────────
// CHROME STORAGE SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtensionStorageData {
  // Auth
  jwt_token?: string;   // JWT from server — sent with every API request
  user_id?: string;   // UUID from server
  user_email?: string;   // For display in popup
  is_logged_in?: boolean;  // Quick flag — avoids parsing token on every check

  // Device
  device_id?: string;   // UUID from server after device registration
  device_name?: string;   // e.g. "Chrome on Mac"

  // Sync state — used by popup to show status
  last_sync_at?: string;  // ISO timestamp of last successful upload
  sync_count?: number;  // Total number of successful syncs this session
  last_tab_count?: number; // How many tabs were in the last snapshot
  last_error?: string;  // Last sync error message (shown in popup)

  // Master key re-login guard
  // We store this flag so on browser restart we know to check IndexedDB.
  // If the key is missing from IndexedDB (e.g. storage was cleared),
  // we show a re-login prompt instead of silently failing.
  master_key_stored?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHROME STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function saveToStorage(data: Partial<ExtensionStorageData>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

export async function loadFromStorage(): Promise<ExtensionStorageData> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(null, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result as ExtensionStorageData);
    });
  });
}

export async function clearStorage(): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(['device_id', 'device_name'], (preserved) => {
      chrome.storage.local.clear(() => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        chrome.storage.local.set(preserved, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INDEXEDDB — master key storage
// ─────────────────────────────────────────────────────────────────────────────

interface VaultTabsDB extends DBSchema {
  'crypto-keys': {
    key: string;
    value: CryptoKey;
  };
}

let db: IDBPDatabase<VaultTabsDB> | null = null;

async function getDB(): Promise<IDBPDatabase<VaultTabsDB>> {
  if (db) return db;
  db = await openDB<VaultTabsDB>('vaulttabs', 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('crypto-keys')) {
        database.createObjectStore('crypto-keys');
      }
    },
  });
  return db;
}

export async function saveMasterKey(masterKey: CryptoKey): Promise<void> {
  const database = await getDB();
  await database.put('crypto-keys', masterKey, 'master_key');
  // Mark in chrome.storage that the key exists in IndexedDB
  await saveToStorage({ master_key_stored: true });
}

export async function loadMasterKey(): Promise<CryptoKey | null> {
  try {
    const database = await getDB();
    const key = await database.get('crypto-keys', 'master_key');
    return key ?? null;
  } catch {
    return null;
  }
}

export async function clearMasterKey(): Promise<void> {
  const database = await getDB();
  await database.delete('crypto-keys', 'master_key');
  await saveToStorage({ master_key_stored: false });
}