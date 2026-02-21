/**
 * src/lib/api.ts
 *
 * HTTP client for the VaultTabs backend.
 * Same backend as the extension — same endpoints, same JWT auth.
 */

// Change this to your production URL when deploying
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const text = await res.text();

    if (!text) return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };

    let json: unknown;
    try { json = JSON.parse(text); }
    catch { return { ok: false, error: `Invalid JSON: ${text.slice(0, 100)}` }; }

    if (!res.ok) {
      const e = json as Record<string, string>;
      return { ok: false, error: e?.message || e?.error || `HTTP ${res.status}` };
    }

    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

import {
  type LoginResponse,
  type Device,
  type RestoreRequest,
  type AccountDevice,
  type SnapshotWithDevice as SnapshotRow,
  type Snapshot as SnapshotBase
} from '@vaulttabs/shared';

export {
  type LoginResponse,
  type Device,
  type RestoreRequest,
  type AccountDevice,
  type SnapshotRow,
  type SnapshotBase
};

// ─── Types ────────────────────────────────────────────────────────────────────
// (Local types replaced by @vaulttabs/shared imports)

// ─── Endpoints ────────────────────────────────────────────────────────────────

export function apiLogin(email: string, password: string) {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function apiGetRecoveryMaterial(email: string) {
  return apiFetch<{
    email: string;
    recovery_encrypted_master_key: string;
    recovery_key_iv: string;
    recovery_key_salt: string;
    recovery_key_hash: string;
  }>('/auth/recovery-material', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function apiGetDevices(token: string) {
  return apiFetch<{ devices: Device[] }>('/devices', {}, token);
}

export function apiGetLatestSnapshots(token: string) {
  return apiFetch<{ snapshots: SnapshotRow[] }>('/snapshots/latest', {}, token);
}

export function apiGetSnapshotHistory(token: string, deviceId: string, limit = 20) {
  return apiFetch<{ snapshots: SnapshotRow[] }>(
    `/snapshots/history?device_id=${deviceId}&limit=${limit}`,
    {},
    token
  );
}

// ─── Restore endpoints ────────────────────────────────────────────────────────

// (Local RestoreRequest replaced)

/** Ask the backend to send a restore request to a specific device */
export function apiCreateRestoreRequest(
  token: string,
  targetDeviceId: string,
  snapshotId?: string
) {
  return apiFetch<{ request_id: string; status: string; expires_at: string }>(
    '/restore',
    { method: 'POST', body: JSON.stringify({ target_device_id: targetDeviceId, snapshot_id: snapshotId }) },
    token
  );
}

/** Poll for restore request status (PWA polls this after creating a request) */
export function apiGetRestoreStatus(token: string, requestId: string) {
  return apiFetch<{ request: RestoreRequest }>(`/restore/${requestId}`, {}, token);
}

// ─── Account / device management ─────────────────────────────────────────────

// (Redundant local AccountDevice removed, now imported from @vaulttabs/shared)

/** List all devices with snapshot counts */
export function apiGetAccountDevices(token: string) {
  return apiFetch<{ devices: AccountDevice[] }>('/account/devices', {}, token);
}

/** Delete a device and all its snapshots */
export function apiDeleteDevice(token: string, deviceId: string) {
  return apiFetch<{ message: string }>(`/account/devices/${deviceId}`, { method: 'DELETE' }, token);
}

/** Rename a device */
export function apiRenameDevice(token: string, deviceId: string, name: string) {
  return apiFetch<{ device: AccountDevice }>(
    `/account/devices/${deviceId}`,
    { method: 'PATCH', body: JSON.stringify({ device_name: name }) },
    token
  );
}