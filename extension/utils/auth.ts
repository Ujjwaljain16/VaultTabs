/** Account flows (kdf v2, with one-time upgrade of legacy v1 accounts). The password never leaves this module except as a v1 login/upgrade credential for legacy accounts. */

import { LIMITS, type AuthResponse } from '@vaulttabs/shared';
import {
  KDF_VERSION_CURRENT,
  KDF_VERSION_LEGACY,
  createAccountMaterial,
  createPasswordMaterial,
  deriveAccountKeys,
  deriveLegacyWrappingKey,
  toNonExtractable,
  unwrapMasterKey,
} from '@vaulttabs/shared/crypto';
import { api, defaultDeviceName } from './api';
import { getDeviceId, getKnownKdfVersion, recordKdfVersion, startSession } from './storage';

/** Thrown when a legacy (v1) account needs the user's explicit consent before the raw password is sent. */
export class LegacyUpgradeConsentRequired extends Error {
  constructor() {
    super(
      'This is an older account. To finish logging in, your password must be sent to the server once so the account can be upgraded to the current, more secure login method. Click the button again to continue.',
    );
    this.name = 'LegacyUpgradeConsentRequired';
  }
}

export const KDF_DOWNGRADE_MESSAGE =
  'The server asked for an outdated login method for this account; refusing to send your password.';

const DECRYPT_FAILED = 'Could not unlock your vault with this password.';

/** A device of the same name not seen for this long is treated as this browser (reinstall). */
const ADOPT_IDLE_MS = 10 * 60 * 1000;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function attachDevice(token: string, userId: string, deviceName?: string) {
  let name = (deviceName?.trim() || defaultDeviceName()).slice(0, LIMITS.maxDeviceNameChars);
  let existing = await getDeviceId(userId);
  if (existing && name === defaultDeviceName()) {
    // Logging in again with the untouched, pre-filled default name must not rename the device
    // the user already named ("Brave personal" → "Chrome on Windows"): keep its current name.
    try {
      const { devices } = await api.devices(token);
      const current = devices.find(d => d.id === existing);
      if (current) name = current.device_name;
    } catch {
      // Keep the default name; the device id is still reused.
    }
  }
  if (!existing) {
    // Fresh install / new extension id: no stored device for this account. Re-attach to the
    // user's existing device with the same name (e.g. "Brave personal") instead of creating a
    // duplicate, unless that device is active right now (then it's a different browser).
    try {
      const { devices } = await api.devices(token);
      const match = devices
        .filter(d => sameName(d.device_name, name))
        // A name the user chose ("Personal Chrome") identifies the browser, so reuse it even if the
        // old install was active moments ago. Auto-generated names ("Chrome on Windows") can be
        // shared by different machines, so for those only reuse a device that has gone idle.
        .filter(
          d => name !== defaultDeviceName() || Date.now() - new Date(d.last_seen).getTime() > ADOPT_IDLE_MS,
        )
        .sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime())[0];
      existing = match?.id;
    } catch {
      // Fall back to registering a new device.
    }
  }
  // The server reuses `id` only if it already belongs to this user; otherwise it issues a new one.
  const { device } = await api.registerDevice(
    { device_name: name, ...(existing ? { id: existing } : {}) },
    token,
  );
  return device;
}

async function finish(auth: AuthResponse, masterKey: CryptoKey, deviceName?: string): Promise<void> {
  const device = await attachDevice(auth.token, auth.user.id, deviceName);
  await startSession({
    token: auth.token,
    userId: auth.user.id,
    email: auth.user.email,
    deviceId: device.id,
    deviceName: device.device_name,
    masterKey,
  });
}

export interface LoginOptions {
  /** The user explicitly agreed to the one-time legacy (v1) login + upgrade. */
  allowLegacyUpgrade?: boolean;
}

export async function login(
  email: string,
  password: string,
  deviceName?: string,
  options: LoginOptions = {},
): Promise<void> {
  const pre = await api.prelogin(email);
  // A server must never be able to downgrade an account this browser has seen at a newer version.
  if (pre.kdf_version < (await getKnownKdfVersion(email))) throw new Error(KDF_DOWNGRADE_MESSAGE);

  if (pre.kdf_version === KDF_VERSION_CURRENT) {
    const { authKey, wrappingKey } = await deriveAccountKeys(password, pre.salt, pre.kdf_iterations);
    const auth = await api.login({ email, auth_key: authKey });
    let key = wrappingKey;
    if (auth.crypto.salt !== pre.salt || auth.crypto.kdf_iterations !== pre.kdf_iterations) {
      key = (await deriveAccountKeys(password, auth.crypto.salt, auth.crypto.kdf_iterations)).wrappingKey;
    }
    let masterKey: CryptoKey;
    try {
      masterKey = await unwrapMasterKey(auth.crypto.encrypted_master_key, auth.crypto.master_key_iv, key);
    } catch {
      throw new Error(DECRYPT_FAILED);
    }
    await finish(auth, masterKey, deviceName);
    await recordKdfVersion(email, KDF_VERSION_CURRENT);
    return;
  }

  if (pre.kdf_version === KDF_VERSION_LEGACY) {
    if (!options.allowLegacyUpgrade) throw new LegacyUpgradeConsentRequired();
    let auth = await api.login({ email, password });
    let extractable: CryptoKey;
    try {
      const legacyKey = await deriveLegacyWrappingKey(password, auth.crypto.salt);
      extractable = await unwrapMasterKey(
        auth.crypto.encrypted_master_key,
        auth.crypto.master_key_iv,
        legacyKey,
        true,
      );
    } catch {
      throw new Error(DECRYPT_FAILED);
    }
    if (auth.upgrade_required !== false) {
      const material = await createPasswordMaterial(extractable, password);
      auth = await api.upgrade(auth.token, { password, ...material });
    }
    await finish(auth, await toNonExtractable(extractable), deviceName);
    if (auth.user.kdf_version >= KDF_VERSION_CURRENT) await recordKdfVersion(email, KDF_VERSION_CURRENT);
    return;
  }

  throw new Error('This account uses an unsupported key format. Please update VaultTabs.');
}

/**
 * Creates the account and session. Returns the recovery code to show exactly once, even when
 * the account was created but setting up this browser failed (`sessionError`): the user can then
 * log in normally, but the code would otherwise be lost.
 */
export async function register(
  email: string,
  password: string,
  deviceName?: string,
): Promise<{ recoveryCode: string; sessionError?: string }> {
  const { masterKey, recoveryCode, payload } = await createAccountMaterial(password);
  const auth = await api.register({ email, ...payload });
  await recordKdfVersion(email, KDF_VERSION_CURRENT);
  try {
    await finish(auth, masterKey, deviceName);
    return { recoveryCode };
  } catch (err) {
    return {
      recoveryCode,
      sessionError: err instanceof Error ? err.message : 'Could not set up this browser.',
    };
  }
}

export type PasswordStrength = { level: 0 | 1 | 2 | 3; label: string };

/** A rough strength hint (length + character variety + obvious patterns). */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < LIMITS.minPasswordChars) {
    return { level: 0, label: `Too short (min ${LIMITS.minPasswordChars} characters)` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(password)).length;
  const unique = new Set(password).size;
  let score = 0;
  if (password.length >= 14) score++;
  if (password.length >= 20) score++;
  if (classes >= 3) score++;
  if (unique < password.length / 3 || /^(.)\1+$/.test(password) || /(password|1234|qwerty)/i.test(password))
    score = 0;
  if (score <= 0) return { level: 1, label: 'Weak: use a longer passphrase' };
  if (score === 1) return { level: 2, label: 'Fair' };
  return { level: 3, label: 'Strong' };
}
