/**
 * src/lib/storage.ts
 *
 * Client-side storage for the PWA.
 *
 * THREE LAYERS:
 *
 * 1. IndexedDB (via idb)
 *    - Stores the CryptoKey master key object
 *    - Persists across page reloads (user doesn't re-enter password every time)
 *    - Cleared on logout
 *
 * 2. sessionStorage
 *    - Stores JWT token, user info, device list
 *    - Dies when the browser tab is closed (more secure than localStorage)
 *    - User logs in fresh each browser session
 *
 * WHY sessionStorage FOR JWT (not localStorage)?
 * On mobile, this means login once per browser session.
 * More secure — token doesn't persist if someone picks up your phone.
 * Tradeoff vs convenience — acceptable for a security tool.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';

// ─── Session storage (JWT + user info) ───────────────────────────────────────

export interface SessionData {
  jwt_token:    string;
  user_id:      string;
  user_email:   string;
  // Crypto data needed to re-derive master key if IndexedDB is cleared
  encrypted_master_key: string;
  master_key_iv:        string;
  salt:                 string;
}

export function saveSession(data: SessionData): void {
  sessionStorage.setItem('vaulttabs_session', JSON.stringify(data));
}

export function loadSession(): SessionData | null {
  const raw = sessionStorage.getItem('vaulttabs_session');
  if (!raw) return null;
  try { return JSON.parse(raw) as SessionData; }
  catch { return null; }
}

export function clearSession(): void {
  sessionStorage.removeItem('vaulttabs_session');
}

// ─── IndexedDB (master key) ───────────────────────────────────────────────────

interface VaultTabsPWADB extends DBSchema {
  'crypto-keys': { key: string; value: CryptoKey };
}

let db: IDBPDatabase<VaultTabsPWADB> | null = null;

async function getDB(): Promise<IDBPDatabase<VaultTabsPWADB>> {
  if (db) return db;
  db = await openDB<VaultTabsPWADB>('vaulttabs-pwa', 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('crypto-keys')) {
        database.createObjectStore('crypto-keys');
      }
    },
  });
  return db;
}

export async function saveMasterKey(key: CryptoKey): Promise<void> {
  const database = await getDB();
  await database.put('crypto-keys', key, 'master_key');
}

export async function loadMasterKey(): Promise<CryptoKey | null> {
  try {
    const database = await getDB();
    return (await database.get('crypto-keys', 'master_key')) ?? null;
  } catch { return null; }
}

export async function clearMasterKey(): Promise<void> {
  const database = await getDB();
  await database.delete('crypto-keys', 'master_key');
}