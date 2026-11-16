/**
 * Account flows on top of @vaulttabs/shared/crypto. The password never leaves this module except
 * for legacy (kdf_version 1) accounts, which must send it once to log in / prove it, and are then
 * upgraded to kdf_version 2.
 */

import type { AuthResponse, CryptoParams, Credential } from '@vaulttabs/shared';
import {
  KDF_VERSION_CURRENT,
  KDF_VERSION_LEGACY,
  createAccountMaterial,
  createPasswordMaterial,
  createRecoveryMaterial,
  deriveAccountKeys,
  deriveLegacyWrappingKey,
  generateRecoveryCode,
  hashRecoveryCode,
  isWellFormedRecoveryCode,
  toNonExtractable,
  unwrapMasterKey,
  unwrapMasterKeyWithRecoveryCode,
} from '@vaulttabs/shared/crypto';
import { ApiRequestError, api } from './api';
import {
  clearLocalSession,
  getKnownKdfVersion,
  recordKdfVersion,
  getSession,
  setMasterKey,
  setSession,
  updateSession,
} from './session';

export type ProgressFn = (message: string) => void;
const noop: ProgressFn = () => {};

export class WrongPasswordError extends Error {
  constructor(message = 'Wrong password.') {
    super(message);
    this.name = 'WrongPasswordError';
  }
}

function assertKnownKdf(version: number): void {
  if (version !== KDF_VERSION_CURRENT && version !== KDF_VERSION_LEGACY) {
    throw new Error('This account uses a newer key format. Please update VaultTabs.');
  }
}

/** Unwrap the master key from stored params. Throws WrongPasswordError if the password is wrong. */
async function unwrapWithPassword(
  password: string,
  params: CryptoParams,
  extractable: boolean,
): Promise<{ masterKey: CryptoKey; credential: Credential }> {
  assertKnownKdf(params.kdf_version);
  let wrappingKey: CryptoKey;
  let credential: Credential;
  if (params.kdf_version === KDF_VERSION_CURRENT) {
    const keys = await deriveAccountKeys(password, params.salt, params.kdf_iterations);
    wrappingKey = keys.wrappingKey;
    credential = { auth_key: keys.authKey };
  } else {
    wrappingKey = await deriveLegacyWrappingKey(password, params.salt);
    credential = { password };
  }
  try {
    const masterKey = await unwrapMasterKey(
      params.encrypted_master_key,
      params.master_key_iv,
      wrappingKey,
      extractable,
    );
    return { masterKey, credential };
  } catch {
    throw new WrongPasswordError();
  }
}

async function finishSignIn(res: AuthResponse, masterKey: CryptoKey, remember: boolean): Promise<void> {
  setSession({ token: res.token, user: res.user, crypto: res.crypto });
  await setMasterKey(await toNonExtractable(masterKey), remember);
}

/** Thrown before a raw password would be sent for a legacy account; the UI must confirm first. */
export class LegacyUpgradeRequiredError extends Error {
  constructor() {
    super(
      'This is an older (v1) account. To sign in, your password is sent once over HTTPS, then the account is upgraded so it never has to be sent again.',
    );
    this.name = 'LegacyUpgradeRequiredError';
  }
}

export const KDF_DOWNGRADE_MESSAGE =
  'The server asked for an outdated login method for this account; refusing to send your password.';

// ─── Login ─────────────────────────────────────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
  remember: boolean,
  progress: ProgressFn = noop,
  opts: { allowLegacy?: boolean } = {},
) {
  progress('requesting key-derivation parameters');
  const params = await api.prelogin(email);
  assertKnownKdf(params.kdf_version);
  // Downgrade protection: a malicious server could claim kdf_version 1 to obtain the raw password.
  if (params.kdf_version < getKnownKdfVersion(email)) throw new Error(KDF_DOWNGRADE_MESSAGE);
  if (params.kdf_version === KDF_VERSION_LEGACY && !opts.allowLegacy) throw new LegacyUpgradeRequiredError();

  try {
    if (params.kdf_version === KDF_VERSION_CURRENT) {
      progress(`deriving keys (PBKDF2-SHA256 × ${params.kdf_iterations.toLocaleString('en-US')})`);
      const { authKey, wrappingKey } = await deriveAccountKeys(password, params.salt, params.kdf_iterations);
      progress('authenticating with derived auth key (password stays local)');
      const res = await api.login({ email, auth_key: authKey });
      progress('unwrapping master key locally');
      let masterKey: CryptoKey;
      try {
        masterKey = await unwrapMasterKey(
          res.crypto.encrypted_master_key,
          res.crypto.master_key_iv,
          wrappingKey,
        );
      } catch {
        throw new Error('Signed in, but your key material could not be unwrapped. Please try again.');
      }
      await finishSignIn(res, masterKey, remember);
      return;
    }

    // Legacy account: the password is sent once, then the account is upgraded to kdf_version 2.
    progress('legacy account: deriving wrapping key');
    const legacyWrap = await deriveLegacyWrappingKey(password, params.salt);
    progress('authenticating (legacy)');
    const res = await api.login({ email, password });
    let masterKey: CryptoKey;
    try {
      masterKey = await unwrapMasterKey(
        res.crypto.encrypted_master_key,
        res.crypto.master_key_iv,
        legacyWrap,
        true,
      );
    } catch {
      throw new Error('Signed in, but your key material could not be unwrapped. Please try again.');
    }
    if (res.upgrade_required || res.crypto.kdf_version === KDF_VERSION_LEGACY) {
      progress('upgrading account to the new key format (PBKDF2 600k + HKDF)');
      const material = await createPasswordMaterial(masterKey, password);
      const upgraded = await api.upgrade(res.token, { password, ...material });
      await finishSignIn(upgraded, masterKey, remember);
    } else {
      await finishSignIn(res, masterKey, remember);
    }
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 401 || err.status === 404)) {
      throw new Error('Invalid email or password.');
    }
    throw err;
  }
}

// ─── Register ──────────────────────────────────────────────────────────────────────────────────

/** Creates the account and signs in. Returns the recovery code (show it exactly once). */
export async function register(
  email: string,
  password: string,
  remember: boolean,
  progress: ProgressFn = noop,
) {
  progress('generating master key and recovery code');
  progress('deriving keys (PBKDF2-SHA256 × 600,000 + HKDF)');
  const { masterKey, recoveryCode, payload } = await createAccountMaterial(password);
  progress('registering (only the derived auth key and wrapped keys are sent)');
  const res = await api.register({ email, ...payload });
  setSession({ token: res.token, user: res.user, crypto: res.crypto });
  await setMasterKey(masterKey, remember);
  return recoveryCode;
}

// ─── Unlock (offline) ──────────────────────────────────────────────────────────────────────────

export async function unlock(password: string, remember: boolean): Promise<void> {
  const session = getSession();
  if (!session) throw new Error('You are signed out.');
  const { masterKey } = await unwrapWithPassword(password, session.crypto, false);
  await setMasterKey(masterKey, remember);
}

/** Verify the current password locally and build the server credential for sensitive actions. */
export async function verifyCurrentPassword(password: string) {
  const session = getSession();
  if (!session) throw new Error('You are signed out.');
  return unwrapWithPassword(password, session.crypto, true);
}

// ─── Recovery ──────────────────────────────────────────────────────────────────────────────────

const INVALID_RECOVERY = 'Invalid email or recovery code.';

/** Resets the password with the recovery code. Returns the NEW recovery code (show it once). */
export async function recover(email: string, code: string, newPassword: string, progress: ProgressFn = noop) {
  if (!isWellFormedRecoveryCode(code)) {
    throw new Error('That does not look like a recovery code (VAULT-XXXX-XXXX-XXXX-XXXX-XXXX).');
  }
  progress('fetching wrapped recovery key');
  const material = await api.recoveryMaterial(email);
  progress('deriving recovery key and unwrapping master key locally');
  let masterKey: CryptoKey;
  try {
    masterKey = await unwrapMasterKeyWithRecoveryCode(
      material.recovery_encrypted_master_key,
      material.recovery_key_iv,
      material.recovery_key_salt,
      code,
    );
  } catch {
    throw new Error(INVALID_RECOVERY);
  }
  progress('re-wrapping master key under the new password');
  const next = await createPasswordMaterial(masterKey, newPassword);
  progress('generating a new recovery code');
  const newCode = generateRecoveryCode();
  const recovery = await createRecoveryMaterial(masterKey, newCode);
  progress('submitting');
  try {
    await api.recover({ email, recovery_key_hash: await hashRecoveryCode(code), next, recovery });
  } catch (err) {
    if (err instanceof ApiRequestError && [400, 401, 403, 404].includes(err.status)) {
      throw new Error(err.status === 400 ? err.message : INVALID_RECOVERY);
    }
    throw err;
  }
  // Every session was revoked server-side; forget any local one.
  await clearLocalSession();
  recordKdfVersion(email, KDF_VERSION_CURRENT);
  return newCode;
}

// ─── Settings actions ──────────────────────────────────────────────────────────────────────────

function mapCredentialError(err: unknown): never {
  if (
    err instanceof ApiRequestError &&
    (err.status === 401 || err.status === 403) &&
    err.code !== 'token_invalid'
  ) {
    throw new WrongPasswordError('The server rejected your current password.');
  }
  throw err;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const { masterKey, credential } = await verifyCurrentPassword(currentPassword);
  const next = await createPasswordMaterial(masterKey, newPassword);
  const res = await api.changePassword({ current: credential, next }).catch(mapCredentialError);
  updateSession({ token: res.token, user: res.user, crypto: res.crypto });
}

export async function regenerateRecoveryCode(currentPassword: string): Promise<string> {
  const { masterKey, credential } = await verifyCurrentPassword(currentPassword);
  const code = generateRecoveryCode();
  const recovery = await createRecoveryMaterial(masterKey, code);
  await api.regenerateRecoveryCode({ current: credential, recovery }).catch(mapCredentialError);
  const s = getSession();
  if (s) updateSession({ user: { ...s.user, has_recovery_key: true } });
  return code;
}

export async function signOutEverywhere(): Promise<void> {
  const res = await api.logoutAll();
  updateSession({ token: res.token, user: res.user, crypto: res.crypto });
}

export async function deleteAccount(currentPassword: string): Promise<void> {
  const { credential } = await verifyCurrentPassword(currentPassword);
  await api.deleteAccount({ current: credential }).catch(mapCredentialError);
  await clearLocalSession();
}

export async function signOut(): Promise<void> {
  await clearLocalSession();
}

// ─── Password strength (UX hint only; the server enforces LIMITS) ──────────────────────────────

export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

const COMMON = [
  'password',
  '123456',
  'qwerty',
  'letmein',
  'welcome',
  'admin',
  'iloveyou',
  'monkey',
  'dragon',
  'vault',
];

export function passwordStrength(pw: string): Strength {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (pw.length >= 20) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (classes >= 3) score++;
  const lower = pw.toLowerCase();
  if (COMMON.some(c => lower.includes(c)) || /^(.)\1+$/.test(pw) || /^\d+$/.test(pw))
    score = Math.min(score, 1);
  const s = Math.max(0, Math.min(4, score)) as Strength['score'];
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score: s, label: labels[s] };
}
