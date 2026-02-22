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
 * 2. localStorage
 *    - Stores JWT token, user info, device list
 *    - Persists across browser restarts for seamless experience
 *    - User remains logged in until explicit logout
 *
 * WHY localStorage FOR JWT?
 * Consistent with modern PWA expectations.
 * Token is protected by OS-level disk encryption in most modern devices.
 * Tradeoff vs security (localStorage) — optimized for "always-on" vault access.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';

// ─── Local storage (JWT + user info) ───────────────────────────────────────

export interface SessionData {
  jwt_token: string;
  user_id: string;
  user_email: string;
  // Crypto data needed to re-derive master key if IndexedDB is cleared
  encrypted_master_key: string;
  master_key_iv: string;
  salt: string;
}

export function saveSession(data: SessionData): void {
  localStorage.setItem('vaulttabs_session', JSON.stringify(data));
}

export function loadSession(): SessionData | null {
  const raw = localStorage.getItem('vaulttabs_session');
  if (!raw) return null;
  try { return JSON.parse(raw) as SessionData; }
  catch { return null; }
}

export function clearSession(): void {
  localStorage.removeItem('vaulttabs_session');
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