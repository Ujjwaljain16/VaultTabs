/**
 * Seeds a legacy (kdf v1) account directly in the database, exactly as accounts created before
 * v2 look (see backend/test/auth.test.ts): the master key wrapped with the v1 password-derived key
 * and a `salthex:hashhex` scrypt password hash.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import {
  deriveLegacyWrappingKey,
  generateMasterKey,
  generateSalt,
  wrapMasterKey,
} from '@vaulttabs/shared/crypto';
import { db } from './db';

export async function seedLegacyUser(email: string, password: string): Promise<string> {
  const salt = generateSalt();
  const master = await generateMasterKey();
  const wrapped = await wrapMasterKey(master, await deriveLegacyWrappingKey(password, salt));
  const hashSalt = randomBytes(16).toString('hex');
  const legacyHash = `${hashSalt}:${scryptSync(password, hashSalt, 64).toString('hex')}`;
  const [row] = await db()<{ id: string }[]>`
    INSERT INTO users (email, password_hash, encrypted_master_key, master_key_iv, salt)
    VALUES (${email.toLowerCase()}, ${legacyHash}, ${wrapped.encrypted_master_key}, ${wrapped.master_key_iv}, ${salt})
    RETURNING id`;
  return row!.id;
}

export async function kdfVersion(email: string): Promise<number> {
  const [row] = await db()<{ kdf_version: number }[]>`
    SELECT kdf_version FROM users WHERE email = ${email.toLowerCase()}`;
  return row!.kdf_version;
}

/** A malicious / rolled-back server claims the account is still v1. */
export async function tamperBackToV1(email: string): Promise<void> {
  await db()`UPDATE users SET kdf_version = 1 WHERE email = ${email.toLowerCase()}`;
}
