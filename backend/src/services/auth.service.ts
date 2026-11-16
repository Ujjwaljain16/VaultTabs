import type { AuthResponse, MeResponse, PreloginResponse, RecoveryMaterialResponse } from '@vaulttabs/shared';
import { DEFAULT_PBKDF2_ITERATIONS, KDF_VERSION_CURRENT } from '@vaulttabs/shared/crypto';
import { deriveFakeBytes, hashSecret, verifyAgainstDummy, verifySecret } from '../crypto/serverCrypto.js';
import { badRequest, conflict, HttpError, invalidCredentials, unauthorized } from '../errors.js';
import type { UserRepository } from '../repositories/user.repository.js';
import type { CredentialInput, PasswordMaterialInput, RecoveryMaterialInput } from '../schemas.js';
import {
  toCryptoParams,
  toPublicUser,
  type PasswordMaterialRow,
  type RecoveryMaterialRow,
  type UserRow,
} from '../types.js';

export interface TokenClaims {
  sub: string;
  tv: number;
}

export type SignToken = (claims: TokenClaims) => string;

/** Thrown when an authenticated user proves the wrong current password (not a session problem). */
const wrongCurrentCredential = () =>
  new HttpError(403, 'The current password is incorrect.', 'invalid_credentials');

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly signToken: SignToken,
    private readonly fakeDataKey: Buffer,
  ) {}

  private authResponse(user: UserRow): AuthResponse {
    const response: AuthResponse = {
      token: this.signToken({ sub: user.id, tv: user.token_version }),
      user: toPublicUser(user),
      crypto: toCryptoParams(user),
    };
    if (user.kdf_version < KDF_VERSION_CURRENT) response.upgrade_required = true;
    return response;
  }

  private async requireUser(userId: string): Promise<UserRow> {
    const user = await this.users.findById(userId);
    // The authenticate hook already checked the user exists; this covers a concurrent delete.
    if (!user) throw unauthorized('Your session has ended. Please log in again.', 'token_invalid');
    return user;
  }

  private async passwordRow(material: PasswordMaterialInput): Promise<PasswordMaterialRow> {
    return {
      password_hash: await hashSecret(material.auth_key),
      salt: material.salt,
      kdf_version: material.kdf_version,
      kdf_iterations: material.kdf_iterations,
      encrypted_master_key: material.encrypted_master_key,
      master_key_iv: material.master_key_iv,
    };
  }

  private async recoveryRow(material: RecoveryMaterialInput): Promise<RecoveryMaterialRow> {
    return {
      recovery_encrypted_master_key: material.recovery_encrypted_master_key,
      recovery_key_iv: material.recovery_key_iv,
      recovery_key_salt: material.recovery_key_salt,
      recovery_key_hash: await hashSecret(material.recovery_key_hash),
    };
  }

  /** Unknown emails get deterministic, plausible parameters so prelogin cannot enumerate accounts. */
  async prelogin(email: string): Promise<PreloginResponse> {
    const user = await this.users.findByEmail(email);
    if (user) return { kdf_version: user.kdf_version, kdf_iterations: user.kdf_iterations, salt: user.salt };
    return {
      kdf_version: KDF_VERSION_CURRENT,
      kdf_iterations: DEFAULT_PBKDF2_ITERATIONS,
      salt: deriveFakeBytes(this.fakeDataKey, 'salt', email, 32).toString('base64'),
    };
  }

  /**
   * NOTE: a taken email returns 409. That reveals that the account exists; avoiding it would need
   * email verification (send a mail instead of answering), which this server does not have.
   * Registration is strictly rate-limited per IP to make bulk enumeration slow.
   */
  async register(
    email: string,
    password: PasswordMaterialInput,
    recovery: RecoveryMaterialInput,
  ): Promise<AuthResponse> {
    const [passwordRow, recoveryRow] = await Promise.all([
      this.passwordRow(password),
      this.recoveryRow(recovery),
    ]);
    const user = await this.users.create({ email, ...passwordRow, ...recoveryRow });
    if (!user)
      throw conflict('An account with this email already exists. Please log in instead.', 'email_taken');
    return this.authResponse(user);
  }

  async login(email: string, proof: { auth_key?: string; password?: string }): Promise<AuthResponse> {
    const user = await this.users.findByEmail(email);
    const secret = user
      ? user.kdf_version >= KDF_VERSION_CURRENT
        ? proof.auth_key
        : proof.password
      : undefined;
    if (!user || secret === undefined) {
      await verifyAgainstDummy(proof.auth_key ?? proof.password ?? '');
      throw invalidCredentials();
    }

    const { ok, needsRehash } = await verifySecret(secret, user.password_hash);
    if (!ok) throw invalidCredentials();

    let current = user;
    if (needsRehash) {
      current =
        (await this.users.updateCredentials(
          user.id,
          { password_hash: await hashSecret(secret) },
          { revokeSessions: false },
        )) ?? user;
    }
    return this.authResponse(current);
  }

  /** Legacy (kdf_version 1) account → v2 password material. Sessions stay valid. */
  async upgrade(userId: string, password: string, material: PasswordMaterialInput): Promise<AuthResponse> {
    const user = await this.requireUser(userId);
    if (user.kdf_version >= KDF_VERSION_CURRENT) {
      throw conflict('This account already uses the current key derivation.', 'already_upgraded');
    }
    const { ok } = await verifySecret(password, user.password_hash);
    if (!ok) throw wrongCurrentCredential();
    const updated = await this.users.updateCredentials(user.id, await this.passwordRow(material), {
      revokeSessions: false,
    });
    return this.authResponse(updated ?? user);
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.requireUser(userId);
    return { user: toPublicUser(user), crypto: toCryptoParams(user) };
  }

  /** v2 accounts must prove auth_key, legacy accounts their password. */
  async verifyCredential(user: UserRow, current: CredentialInput): Promise<void> {
    const isV2 = user.kdf_version >= KDF_VERSION_CURRENT;
    const secret = isV2
      ? 'auth_key' in current
        ? current.auth_key
        : undefined
      : 'password' in current
        ? current.password
        : undefined;
    if (secret === undefined) {
      throw badRequest(
        isV2 ? 'This account requires current.auth_key.' : 'This account requires current.password.',
        'credential_type',
      );
    }
    const { ok } = await verifySecret(secret, user.password_hash);
    if (!ok) throw wrongCurrentCredential();
  }

  /** New password material; every existing session (including the caller's token) ends. */
  async changePassword(
    userId: string,
    current: CredentialInput,
    next: PasswordMaterialInput,
  ): Promise<AuthResponse> {
    const user = await this.requireUser(userId);
    await this.verifyCredential(user, current);
    const updated = await this.users.updateCredentials(user.id, await this.passwordRow(next), {
      revokeSessions: true,
    });
    if (!updated) throw unauthorized('Your session has ended. Please log in again.', 'token_invalid');
    return this.authResponse(updated);
  }

  async regenerateRecovery(
    userId: string,
    current: CredentialInput,
    recovery: RecoveryMaterialInput,
  ): Promise<void> {
    const user = await this.requireUser(userId);
    await this.verifyCredential(user, current);
    await this.users.updateCredentials(user.id, await this.recoveryRow(recovery), { revokeSessions: false });
  }

  async logoutAll(userId: string): Promise<AuthResponse> {
    const updated = await this.users.updateCredentials(userId, {}, { revokeSessions: true });
    if (!updated) throw unauthorized('Your session has ended. Please log in again.', 'token_invalid');
    return this.authResponse(updated);
  }

  /** Unknown emails (and accounts without a recovery code) get deterministic fake material. */
  async recoveryMaterial(email: string): Promise<RecoveryMaterialResponse> {
    const user = await this.users.findByEmail(email);
    if (
      user?.recovery_encrypted_master_key &&
      user.recovery_key_iv &&
      user.recovery_key_salt &&
      user.recovery_key_hash
    ) {
      return {
        recovery_encrypted_master_key: user.recovery_encrypted_master_key,
        recovery_key_iv: user.recovery_key_iv,
        recovery_key_salt: user.recovery_key_salt,
      };
    }
    const fake = (label: string, n: number) =>
      deriveFakeBytes(this.fakeDataKey, label, email, n).toString('base64');
    return {
      recovery_encrypted_master_key: fake('recovery-key', 48),
      recovery_key_iv: fake('recovery-iv', 12),
      recovery_key_salt: fake('recovery-salt', 32),
    };
  }

  /** Recovery code → new password AND new recovery code; every session ends. */
  async recover(
    email: string,
    recoveryKeyHash: string,
    next: PasswordMaterialInput,
    recovery: RecoveryMaterialInput,
  ): Promise<void> {
    const user = await this.users.findByEmail(email);
    const { ok } = await verifySecret(recoveryKeyHash, user?.recovery_key_hash);
    if (!user || !ok) {
      throw new HttpError(401, 'The recovery code is not valid for this account.', 'invalid_recovery_code');
    }
    const [passwordRow, recoveryRow] = await Promise.all([
      this.passwordRow(next),
      this.recoveryRow(recovery),
    ]);
    await this.users.updateCredentials(user.id, { ...passwordRow, ...recoveryRow }, { revokeSessions: true });
  }

  async deleteAccount(userId: string, current: CredentialInput): Promise<void> {
    const user = await this.requireUser(userId);
    await this.verifyCredential(user, current);
    await this.users.delete(user.id);
  }
}
