/**
 * src/types/index.ts
 * Shared types used across the PWA.
 */

export type { TabSnapshot } from '@vaulttabs/shared';

/** A device with its decrypted tabs — the main data unit in the dashboard */
export interface DeviceSnapshot {
  snapshotId: string;
  deviceId: string;
  deviceName: string;
  capturedAt: string | Date;
  lastSeen: string | Date;
  tabs: import('@vaulttabs/shared').TabSnapshot[];
  // null = still decrypting, Error = decryption failed
  status: 'loading' | 'ready' | 'error';
  errorMsg?: string;
}

export interface AuthState {
  token: string;
  userId: string;
  userEmail: string;
  masterKey: CryptoKey;
  cryptoData: {
    encrypted_master_key: string;
    master_key_iv: string;
    salt: string;
  };
}