// Input schemas shared by several routes. Unknown keys are stripped (old clients may send extra
// fields), never rejected.

import { z } from 'zod';
import { LIMITS } from '@vaulttabs/shared';
import { KDF_VERSION_CURRENT, MAX_PBKDF2_ITERATIONS, MIN_PBKDF2_ITERATIONS } from '@vaulttabs/shared/crypto';
import { isBase64InRange, isBase64OfLength } from './crypto/serverCrypto.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const uuid = z.string().regex(UUID_RE, 'must be a UUID');

/** Emails are compared case-insensitively everywhere: trim + lower-case before anything else. */
export const email = z
  .string({ error: 'email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email('must be a valid email address').max(254));

const b64Exact = (bytes: number, name: string) =>
  z
    .string({ error: `${name} is required` })
    .refine(v => isBase64OfLength(v, bytes), `${name} must be base64 of ${bytes} bytes`);
const b64Range = (min: number, max: number, name: string) =>
  z
    .string({ error: `${name} is required` })
    .max(4 * Math.ceil(max / 3))
    .refine(v => isBase64InRange(v, min, max), `${name} must be base64 of ${min}-${max} bytes`);

export const authKey = b64Exact(32, 'auth_key');

export const passwordMaterial = z.object({
  auth_key: authKey,
  salt: b64Range(16, 64, 'salt'),
  kdf_iterations: z
    .number({ error: 'kdf_iterations is required' })
    .int()
    .min(MIN_PBKDF2_ITERATIONS, `kdf_iterations must be at least ${MIN_PBKDF2_ITERATIONS}`)
    .max(MAX_PBKDF2_ITERATIONS, `kdf_iterations must be at most ${MAX_PBKDF2_ITERATIONS}`),
  kdf_version: z.literal(KDF_VERSION_CURRENT, { error: `kdf_version must be ${KDF_VERSION_CURRENT}` }),
  encrypted_master_key: b64Range(32, 128, 'encrypted_master_key'),
  master_key_iv: b64Exact(12, 'master_key_iv'),
});
export type PasswordMaterialInput = z.output<typeof passwordMaterial>;

export const recoveryMaterial = z.object({
  recovery_encrypted_master_key: b64Range(32, 128, 'recovery_encrypted_master_key'),
  recovery_key_iv: b64Exact(12, 'recovery_key_iv'),
  recovery_key_salt: b64Range(16, 64, 'recovery_key_salt'),
  recovery_key_hash: b64Exact(32, 'recovery_key_hash'),
});
export type RecoveryMaterialInput = z.output<typeof recoveryMaterial>;

export const legacyPassword = z
  .string({ error: 'password is required' })
  .min(1, 'password is required')
  .max(LIMITS.maxPasswordChars, `password must be at most ${LIMITS.maxPasswordChars} characters`);

/** Proof of the current password: auth_key for kdf_version 2 accounts, password for legacy ones. */
export const credential = z.union([z.object({ auth_key: authKey }), z.object({ password: legacyPassword })], {
  error: 'current must contain auth_key (or password for legacy accounts)',
});
export type CredentialInput = z.output<typeof credential>;
