/** Typed client for the VaultTabs HTTP API (contract: @vaulttabs/shared api.ts). */

import type {
  ApiError,
  AuthResponse,
  CompleteRestorePayload,
  CreateRestorePayload,
  CreateRestoreResponse,
  DeviceResponse,
  DevicesResponse,
  LoginPayload,
  PendingRestoreResponse,
  PreloginResponse,
  RegisterDevicePayload,
  RegisterPayload,
  RestoreStatusResponse,
  SnapshotsResponse,
  UpgradePayload,
  UploadSnapshotPayload,
  UploadSnapshotResponse,
} from '@vaulttabs/shared';
import { API_URL } from './config';
import { endSession, loadState } from './storage';

export const SESSION_ENDED_MESSAGE = 'Your session ended. Please log in again.';

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network errors / timeouts. */
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  get sessionEnded(): boolean {
    return this.status === 401 && this.code === 'token_invalid';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** `false` for unauthenticated routes; a string to use that token instead of the stored one. */
  auth?: boolean | string;
  signal?: AbortSignal;
  /** Return the raw Response (for streams). No timeout is applied. */
  raw?: boolean;
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object' && value !== null && typeof (value as ApiError).message === 'string';
}

async function resolveToken(auth: boolean | string): Promise<string | undefined> {
  if (typeof auth === 'string') return auth;
  if (!auth) return undefined;
  const { token } = await loadState();
  if (!token) throw new ApiRequestError('You are not logged in.', 401, 'not_logged_in');
  return token;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  if (!API_URL) throw new ApiRequestError('No server is configured for this build.', 0);
  const token = await resolveToken(opts.auth ?? true);
  const headers: Record<string, string> = { Accept: opts.raw ? 'text/event-stream' : 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const onAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) controller.abort(opts.signal.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = opts.raw
    ? undefined
    : setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err; // caller cancelled
    const timedOut = controller.signal.aborted;
    throw new ApiRequestError(
      timedOut ? 'The server took too long to respond.' : "Can't reach the VaultTabs server.",
      0,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!opts.raw) opts.signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Not JSON (proxy error page etc.)
    }
    const error = isApiError(body)
      ? new ApiRequestError(body.message, response.status, body.code)
      : new ApiRequestError(`Server error (HTTP ${response.status}).`, response.status);
    if (error.sessionEnded && token && typeof opts.auth !== 'string') {
      await endSession(token, SESSION_ENDED_MESSAGE);
    }
    throw error;
  }
  return response;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const response = await send(path, opts);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiRequestError('The server sent an invalid response.', response.status);
  }
}

const enc = encodeURIComponent;

export const api = {
  // Auth
  prelogin: (email: string) =>
    request<PreloginResponse>('/auth/prelogin', { method: 'POST', body: { email }, auth: false }),
  login: (payload: LoginPayload) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: payload, auth: false }),
  register: (payload: RegisterPayload) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body: payload, auth: false }),
  upgrade: (token: string, payload: UpgradePayload) =>
    request<AuthResponse>('/auth/upgrade', { method: 'POST', body: payload, auth: token }),

  // Devices
  registerDevice: (payload: RegisterDevicePayload, token?: string) =>
    request<DeviceResponse>('/devices/register', { method: 'POST', body: payload, auth: token ?? true }),
  devices: () => request<DevicesResponse>('/devices'),
  heartbeat: (deviceId: string) =>
    request<unknown>(`/devices/${enc(deviceId)}/heartbeat`, { method: 'PATCH', body: {} }),
  renameDevice: (deviceId: string, deviceName: string) =>
    request<DeviceResponse>(`/account/devices/${enc(deviceId)}`, {
      method: 'PATCH',
      body: { device_name: deviceName },
    }),

  // Snapshots
  uploadSnapshot: (payload: UploadSnapshotPayload) =>
    request<UploadSnapshotResponse>('/snapshots', { method: 'POST', body: payload }),
  latestSnapshots: () => request<SnapshotsResponse>('/snapshots/latest'),

  // Restore / send tab
  createRestore: (payload: CreateRestorePayload) =>
    request<CreateRestoreResponse>('/restore', { method: 'POST', body: payload }),
  restoreStatus: (requestId: string) => request<RestoreStatusResponse>(`/restore/${enc(requestId)}`),
  completeRestore: (requestId: string, payload: CompleteRestorePayload) =>
    request<unknown>(`/restore/${enc(requestId)}`, { method: 'PATCH', body: payload }),
  pendingRestore: (deviceId: string) =>
    request<PendingRestoreResponse>(`/restore/pending?device_id=${enc(deviceId)}`),
  /** Opens the SSE stream; read the body with utils/sse.ts. */
  restoreStream: (deviceId: string, signal: AbortSignal) =>
    send(`/restore/stream?device_id=${enc(deviceId)}`, { signal, raw: true }),
};

/** A short, user-presentable message for any error. */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** A default device label like "Firefox on Windows". Not a fingerprint: just a display name. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const browserName = ua.includes('Firefox/')
    ? 'Firefox'
    : ua.includes('Edg/')
      ? 'Edge'
      : ua.includes('OPR/')
        ? 'Opera'
        : ua.includes('Chrome/')
          ? 'Chrome'
          : 'Browser';
  const os = ua.includes('Windows')
    ? 'Windows'
    : ua.includes('Mac OS')
      ? 'macOS'
      : ua.includes('Android')
        ? 'Android'
        : ua.includes('CrOS')
          ? 'ChromeOS'
          : ua.includes('Linux')
            ? 'Linux'
            : 'Unknown OS';
  return `${browserName} on ${os}`;
}
