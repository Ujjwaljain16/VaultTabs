/**
 * Domain models shared across VaultTabs components.
 *
 * Server-only rows (with password/recovery hashes) live in the backend; everything here is safe to
 * send to clients.
 */

export interface PublicUser {
  id: string;
  email: string;
  created_at: string | Date;
  snapshot_retention: number;
  has_recovery_key: boolean;
  kdf_version: number;
}

/** What a client needs to unwrap the master key with the account password. */
export interface CryptoParams {
  kdf_version: number;
  kdf_iterations: number;
  salt: string;
  encrypted_master_key: string;
  master_key_iv: string;
}

export interface Device {
  id: string;
  user_id: string;
  device_name: string;
  last_seen: string | Date;
  created_at: string | Date;
}

export interface Snapshot {
  id: string;
  user_id: string;
  device_id: string;
  captured_at: string | Date;
  iv: string;
  encrypted_blob: string;
  /** 1 = legacy (no AAD), 2 = bound to user/device/captured_at. */
  enc_version: number;
  /** Saved sessions are never pruned by retention. */
  pinned: boolean;
  /** Encrypted (master key) label of a saved session. */
  label_enc: string | null;
  label_iv: string | null;
  created_at: string | Date;
}

export type RestoreStatus = 'pending' | 'completed' | 'failed' | 'expired';

/** Machine-readable failure reasons reported by the receiving device (no free text is stored). */
export const RESTORE_ERROR_CODES = [
  'master_key_missing',
  'decrypt_failed',
  'empty_snapshot',
  'unsafe_url',
  'open_failed',
  'unknown',
] as const;
export type RestoreErrorCode = (typeof RESTORE_ERROR_CODES)[number];

export const RESTORE_ERROR_MESSAGES: Record<RestoreErrorCode, string> = {
  master_key_missing: 'The target browser is locked. Log in to VaultTabs there and try again.',
  decrypt_failed: 'The target browser could not decrypt the request.',
  empty_snapshot: 'There was nothing to restore.',
  unsafe_url: 'The target browser refused a non-http(s) URL.',
  open_failed: 'The target browser could not open the tabs.',
  unknown: 'The restore failed on the target browser.',
};

export interface RestoreRequest {
  id: string;
  target_device_id: string;
  snapshot_id: string | null;
  status: RestoreStatus;
  error_code: RestoreErrorCode | null;
  created_at: string | Date;
  expires_at: string | Date;
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
