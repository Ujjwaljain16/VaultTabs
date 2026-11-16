/**
 * Typed client for the VaultTabs HTTP API (contract: @vaulttabs/shared, src/api.ts).
 *
 * Every function throws ApiRequestError on failure. A 401 with code `token_invalid` on an
 * authenticated call means the session is gone (expired, revoked by "sign out everywhere", a
 * password change, or account deletion): the local session and key are cleared and the browser is
 * sent to /login?reason=expired.
 */

import type {
  AccountDevice,
  AccountDevicesResponse,
  AccountInfoResponse,
  ApiError,
  AuthResponse,
  ChangePasswordPayload,
  CompleteRestorePayload,
  CreateRestorePayload,
  CreateRestoreResponse,
  DeleteAccountPayload,
  DeviceResponse,
  DevicesResponse,
  LoginPayload,
  MeResponse,
  PendingRestoreResponse,
  PreloginResponse,
  RecoverPayload,
  RecoveryMaterialResponse,
  RegenerateRecoveryPayload,
  RegisterDevicePayload,
  RegisterPayload,
  RestoreStatusResponse,
  SnapshotHistoryResponse,
  SnapshotsResponse,
  SnapshotWithDevice,
  UpdateSnapshotPayload,
  UpgradePayload,
  UploadSnapshotPayload,
  UploadSnapshotResponse,
} from '@vaulttabs/shared';
import { API_URL } from './config';
import { clearLocalSession, getToken } from './session';

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RequestOptions {
  body?: unknown;
  /** Send the stored session token (default true). */
  auth?: boolean;
  /** Use this token instead of the stored one (e.g. right after login, before it is stored). */
  token?: string;
  query?: Record<string, string | number | undefined | null>;
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === 'object' && v !== null && typeof (v as ApiError).message === 'string';
}

let redirecting = false;
async function handleSessionGone(): Promise<void> {
  await clearLocalSession();
  if (typeof window !== 'undefined' && !redirecting) {
    redirecting = true;
    // Full reload on purpose: it guarantees the in-memory master key is gone.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/login?reason=expired');
  }
}

async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const auth = opts.auth ?? true;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = opts.token ?? (auth ? getToken() : null);
  if (auth) {
    if (!token) {
      await handleSessionGone();
      throw new ApiRequestError(401, 'You are signed out.', 'token_invalid');
    }
    headers.Authorization = `Bearer ${token}`;
  }
  // Only declare a JSON body when there is one (Fastify rejects empty JSON bodies).
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let url = `${API_URL}${path}`;
  if (opts.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ApiRequestError(
      0,
      timedOut
        ? 'The server took too long to respond.'
        : 'Could not reach the VaultTabs server. Check your connection.',
    );
  }

  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) {
    const err = isApiError(json) ? json : undefined;
    const code = err?.code;
    if (res.status === 401 && code === 'token_invalid' && (auth || opts.token)) {
      await handleSessionGone();
    }
    throw new ApiRequestError(res.status, err?.message || defaultMessage(res.status), code, err?.details);
  }
  return json as T;
}

function defaultMessage(status: number): string {
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'The server had a problem. Please try again.';
  if (status === 404) return 'Not found.';
  return `Request failed (HTTP ${status}).`;
}

/** Human message for any error thrown by this module or by crypto code. */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

const id = (v: string) => encodeURIComponent(v);
type MessageResponse = { message: string };

// ─── Auth ──────────────────────────────────────────────────────────────────────────────────────

export const api = {
  prelogin: (email: string) =>
    request<PreloginResponse>('POST', '/auth/prelogin', { auth: false, body: { email } }),
  register: (payload: RegisterPayload) =>
    request<AuthResponse>('POST', '/auth/register', { auth: false, body: payload }),
  login: (payload: LoginPayload) =>
    request<AuthResponse>('POST', '/auth/login', { auth: false, body: payload }),
  /** Legacy account → kdf_version 2. Uses the token returned by /auth/login. */
  upgrade: (token: string, payload: UpgradePayload) =>
    request<AuthResponse>('POST', '/auth/upgrade', { token, body: payload }),
  me: () => request<MeResponse>('GET', '/auth/me'),
  changePassword: (payload: ChangePasswordPayload) =>
    request<AuthResponse>('POST', '/auth/change-password', { body: payload }),
  regenerateRecoveryCode: (payload: RegenerateRecoveryPayload) =>
    request<MessageResponse>('POST', '/auth/recovery-code', { body: payload }),
  logoutAll: () => request<AuthResponse>('POST', '/auth/logout-all'),
  recoveryMaterial: (email: string) =>
    request<RecoveryMaterialResponse>('POST', '/auth/recovery-material', { auth: false, body: { email } }),
  recover: (payload: RecoverPayload) =>
    request<MessageResponse>('POST', '/auth/recover', { auth: false, body: payload }),

  // ─── Devices ─────────────────────────────────────────────────────────────────────────────────
  registerDevice: (payload: RegisterDevicePayload) =>
    request<DeviceResponse>('POST', '/devices/register', { body: payload }),
  listDevices: () => request<DevicesResponse>('GET', '/devices'),
  heartbeat: (deviceId: string) => request<{ ok: true }>('PATCH', `/devices/${id(deviceId)}/heartbeat`),
  deleteDevice: (deviceId: string) => request<MessageResponse>('DELETE', `/devices/${id(deviceId)}`),

  // ─── Account ─────────────────────────────────────────────────────────────────────────────────
  account: () => request<AccountInfoResponse>('GET', '/account'),
  setRetention: (retention: number) =>
    request<{ retention: number }>('PATCH', '/account/retention', { body: { retention } }),
  accountDevices: () => request<AccountDevicesResponse>('GET', '/account/devices'),
  renameDevice: (deviceId: string, deviceName: string) =>
    request<DeviceResponse>('PATCH', `/account/devices/${id(deviceId)}`, {
      body: { device_name: deviceName },
    }),
  deleteAccountDevice: (deviceId: string) =>
    request<MessageResponse>('DELETE', `/account/devices/${id(deviceId)}`),
  deleteAccount: (payload: DeleteAccountPayload) =>
    request<MessageResponse>('DELETE', '/account', { body: payload }),

  // ─── Snapshots ───────────────────────────────────────────────────────────────────────────────
  uploadSnapshot: (payload: UploadSnapshotPayload) =>
    request<UploadSnapshotResponse>('POST', '/snapshots', { body: payload }),
  latestSnapshots: () => request<SnapshotsResponse>('GET', '/snapshots/latest'),
  snapshotHistory: (deviceId: string, opts: { limit?: number; before?: string | null } = {}) =>
    request<SnapshotHistoryResponse>('GET', '/snapshots/history', {
      query: { device_id: deviceId, limit: opts.limit, before: opts.before },
    }),
  savedSnapshots: () => request<SnapshotsResponse>('GET', '/snapshots/saved'),
  getSnapshot: (snapshotId: string) =>
    request<{ snapshot: SnapshotWithDevice }>('GET', `/snapshots/${id(snapshotId)}`),
  updateSnapshot: (snapshotId: string, payload: UpdateSnapshotPayload) =>
    request<{ snapshot: SnapshotWithDevice }>('PATCH', `/snapshots/${id(snapshotId)}`, { body: payload }),
  deleteSnapshot: (snapshotId: string) => request<MessageResponse>('DELETE', `/snapshots/${id(snapshotId)}`),

  // ─── Restore / send tab ──────────────────────────────────────────────────────────────────────
  createRestore: (payload: CreateRestorePayload) =>
    request<CreateRestoreResponse>('POST', '/restore', { body: payload }),
  restoreStatus: (requestId: string) => request<RestoreStatusResponse>('GET', `/restore/${id(requestId)}`),
  /** Used by the extension; GET /restore/stream (SSE) is extension-only and not wrapped here. */
  pendingRestore: (deviceId: string) =>
    request<PendingRestoreResponse>('GET', '/restore/pending', { query: { device_id: deviceId } }),
  completeRestore: (requestId: string, payload: CompleteRestorePayload) =>
    request<{ ok?: boolean; message?: string }>('PATCH', `/restore/${id(requestId)}`, { body: payload }),
};

export type { AccountDevice, SnapshotWithDevice };
