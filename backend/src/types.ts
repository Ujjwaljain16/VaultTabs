// Server-only row types. Anything with hashes or token_version must never be sent to clients:
// convert with toPublicUser / toCryptoParams.

import type { CryptoParams, PublicUser } from '@vaulttabs/shared';

export interface UserRow {
  id: string;
  email: string;
  /** scrypt(auth_key) for kdf_version 2, scrypt(password) for legacy accounts. */
  password_hash: string;
  encrypted_master_key: string;
  master_key_iv: string;
  salt: string;
  recovery_encrypted_master_key: string | null;
  recovery_key_iv: string | null;
  recovery_key_salt: string | null;
  /** scrypt(recovery_key_hash) */
  recovery_key_hash: string | null;
  snapshot_retention: number;
  kdf_version: number;
  kdf_iterations: number;
  token_version: number;
  created_at: Date;
  updated_at: Date;
}

/** Columns updated together whenever the password changes (v2 material). */
export interface PasswordMaterialRow {
  password_hash: string;
  salt: string;
  kdf_version: number;
  kdf_iterations: number;
  encrypted_master_key: string;
  master_key_iv: string;
}

export interface RecoveryMaterialRow {
  recovery_encrypted_master_key: string;
  recovery_key_iv: string;
  recovery_key_salt: string;
  recovery_key_hash: string;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    created_at: u.created_at,
    snapshot_retention: u.snapshot_retention,
    has_recovery_key: Boolean(u.recovery_key_hash && u.recovery_encrypted_master_key),
    kdf_version: u.kdf_version,
  };
}

export function toCryptoParams(u: UserRow): CryptoParams {
  return {
    kdf_version: u.kdf_version,
    kdf_iterations: u.kdf_iterations,
    salt: u.salt,
    encrypted_master_key: u.encrypted_master_key,
    master_key_iv: u.master_key_iv,
  };
}
