/**
 * The VaultTabs HTTP API contract (all paths are relative to `<API_URL>`, e.g.
 * `https://api.example.com/api/v1`). Every authenticated route takes `Authorization: Bearer <jwt>`.
 *
 * Errors always have the shape `ApiError`. 401 with code `token_invalid` means the session is gone
 * (expired, revoked by "sign out everywhere"/password change, or account deleted): clients must
 * drop their session and ask the user to log in again.
 */

import type {
  CryptoParams,
  Device,
  PublicUser,
  RestoreErrorCode,
  RestoreRequest,
  Snapshot,
} from './models.js';
import type { PasswordMaterial, RecoveryMaterial } from './crypto.js';

export const API_VERSION = 'v1';

export interface ApiError {
  error: string;
  message: string;
  code?: string;
  details?: unknown;
}

// ─── Limits (the server enforces these; clients use them for UX) ───────────────────────────────

export const LIMITS = {
  /** Max length of the base64 snapshot ciphertext. */
  maxSnapshotBlobChars: 2_000_000,
  maxDeviceNameChars: 100,
  minPasswordChars: 10,
  maxPasswordChars: 1024,
  minRetention: 1,
  maxRetention: 500,
  defaultRetention: 50,
  maxSavedSessions: 100,
  maxHistoryPage: 50,
  maxRestoreUrls: 500,
} as const;

// ─── Auth ──────────────────────────────────────────────────────────────────────────────────────

/** POST /auth/prelogin. Unknown emails get plausible fake parameters (no account enumeration). */
export interface PreloginPayload {
  email: string;
}
export interface PreloginResponse {
  kdf_version: number;
  kdf_iterations: number;
  salt: string;
}

/** POST /auth/register → 201 AuthResponse (409 if the email is taken). */
export type RegisterPayload = { email: string } & PasswordMaterial & RecoveryMaterial;

/**
 * POST /auth/login → 200 AuthResponse.
 * kdf_version 2 accounts send `auth_key`; legacy (1) accounts send `password` and receive
 * `upgrade_required: true`, after which the client must call POST /auth/upgrade.
 */
export type LoginPayload = { email: string; auth_key: string } | { email: string; password: string };

export interface AuthResponse {
  token: string;
  user: PublicUser;
  crypto: CryptoParams;
  upgrade_required?: boolean;
}

/** Proof of the current password for sensitive operations (one of the two, by kdf_version). */
export type Credential = { auth_key: string } | { password: string };

/** POST /auth/upgrade (auth) — legacy account → kdf_version 2. Returns AuthResponse. */
export type UpgradePayload = { password: string } & PasswordMaterial;

/** GET /auth/me (auth) → MeResponse */
export interface MeResponse {
  user: PublicUser;
  crypto: CryptoParams;
}

/** POST /auth/change-password (auth) → AuthResponse with a NEW token (all other sessions end). */
export interface ChangePasswordPayload {
  current: Credential;
  next: PasswordMaterial;
}

/** POST /auth/recovery-code (auth) → { message } — replaces the recovery code. */
export interface RegenerateRecoveryPayload {
  current: Credential;
  recovery: RecoveryMaterial;
}

/** POST /auth/logout-all (auth) → AuthResponse with a NEW token for the caller; every other session ends. */

/** POST /auth/recovery-material → RecoveryMaterialResponse (fake but well-formed for unknown emails). */
export interface RecoveryMaterialPayload {
  email: string;
}
export type RecoveryMaterialResponse = Omit<RecoveryMaterial, 'recovery_key_hash'>;

/**
 * POST /auth/recover → { message }. Proves knowledge of the recovery code (its hash), sets a new
 * password and a NEW recovery code, and revokes every existing session.
 */
export interface RecoverPayload {
  email: string;
  recovery_key_hash: string;
  next: PasswordMaterial;
  recovery: RecoveryMaterial;
}

// ─── Devices ───────────────────────────────────────────────────────────────────────────────────

/** POST /devices/register (auth) → 201 DeviceResponse. `id` is reused only if it is yours. */
export interface RegisterDevicePayload {
  device_name: string;
  id?: string;
}
export interface DeviceResponse {
  device: Device;
}
/** GET /devices (auth) */
export interface DevicesResponse {
  devices: Device[];
}
/** PATCH /devices/:id/heartbeat (auth) → { ok: true }  (404 if not yours) */
/** DELETE /devices/:id (auth) → { message } */

// ─── Account ───────────────────────────────────────────────────────────────────────────────────

/** GET /account (auth) */
export interface AccountInfoResponse {
  account: PublicUser;
  stats: {
    device_count: number;
    snapshot_count: number;
    saved_count: number;
    storage_bytes: number;
    last_sync_at: string | Date | null;
  };
}
/** PATCH /account/retention (auth) { retention } → { retention } */
export interface RetentionPayload {
  retention: number;
}
/** GET /account/devices (auth) */
export interface AccountDevice extends Device {
  snapshot_count: number;
  last_snapshot_at: string | Date | null;
}
export interface AccountDevicesResponse {
  devices: AccountDevice[];
}
/** PATCH /account/devices/:id (auth) { device_name } → DeviceResponse; DELETE /account/devices/:id */
/** DELETE /account (auth) { current: Credential } → { message } */
export interface DeleteAccountPayload {
  current: Credential;
}

// ─── Snapshots ─────────────────────────────────────────────────────────────────────────────────

/** POST /snapshots (auth) → 201 { snapshot_id, captured_at } */
export interface UploadSnapshotPayload {
  device_id: string;
  captured_at: string;
  iv: string;
  encrypted_blob: string;
  enc_version: number;
}
export interface UploadSnapshotResponse {
  snapshot_id: string;
  captured_at: string | Date;
}

export interface SnapshotWithDevice extends Snapshot {
  device_name: string;
  last_seen: string | Date;
}

/** GET /snapshots/latest (auth) — newest snapshot per device. */
export interface SnapshotsResponse {
  snapshots: SnapshotWithDevice[];
}

/**
 * GET /snapshots/history?device_id=&limit=&before= (auth) — newest first.
 * `before` is an ISO timestamp cursor; pass `next_before` to get the next page (null = no more).
 */
export interface SnapshotHistoryResponse {
  snapshots: SnapshotWithDevice[];
  next_before: string | null;
}

/** GET /snapshots/saved (auth) — all pinned snapshots ("saved sessions"). */
/** GET /snapshots/:id (auth) → { snapshot: SnapshotWithDevice } */
/** PATCH /snapshots/:id (auth) → { snapshot: SnapshotWithDevice } */
export interface UpdateSnapshotPayload {
  pinned?: boolean;
  label_enc?: string | null;
  label_iv?: string | null;
}
/** DELETE /snapshots/:id (auth) → { message } */

// ─── Restore / send tab ────────────────────────────────────────────────────────────────────────

/**
 * POST /restore (auth) → 201 CreateRestoreResponse.
 * Either `snapshot_id` (open a whole snapshot on the target) or `encrypted_payload` + `payload_iv`
 * (an encrypted RestorePayload, see crypto.encryptRestorePayload) must be given.
 */
export interface CreateRestorePayload {
  target_device_id: string;
  snapshot_id?: string;
  encrypted_payload?: string;
  payload_iv?: string;
}
export interface CreateRestoreResponse {
  request_id: string;
  status: string;
  expires_at: string | Date;
}

export interface PendingRestoreDetail {
  id: string;
  target_device_id: string;
  created_at: string | Date;
  expires_at: string | Date;
  snapshot: Pick<
    Snapshot,
    'id' | 'device_id' | 'captured_at' | 'iv' | 'encrypted_blob' | 'enc_version'
  > | null;
  encrypted_payload: string | null;
  payload_iv: string | null;
}

/**
 * GET /restore/pending?device_id= (auth), and each `data:` event of the SSE stream
 * GET /restore/stream?device_id= (auth; `: ping` comments every 20 s).
 */
export interface PendingRestoreResponse {
  pending: boolean;
  /** The oldest queued request (kept for clients older than 1.1). */
  request?: PendingRestoreDetail;
  /**
   * Every queued request for this device, oldest first. Requests wait up to 24 h, so tabs sent
   * to a closed browser open when it next starts. Clients must open each id only once.
   */
  requests?: PendingRestoreDetail[];
}

/** PATCH /restore/:id (auth) — reported by the target device. */
export interface CompleteRestorePayload {
  status: 'completed' | 'failed';
  error_code?: RestoreErrorCode;
}

/** GET /restore/:id (auth) */
export interface RestoreStatusResponse {
  request: RestoreRequest;
}
