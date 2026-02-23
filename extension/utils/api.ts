/**
 * utils/api.ts
 *
 * All HTTP calls to the backend live here.
 *
 * WHY CENTRALIZE API CALLS?
 * - One place to change the base URL
 * - One place to add the JWT token to every request
 * - Consistent error handling
 * - Easy to test and mock
 *
 * ABOUT JWT TOKENS:
 * After login, the server gives us a token. We store it in chrome.storage.
 * We send it with every request in the "Authorization" header like:
 *   Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
 * The server verifies this token and knows who we are.
 */

import { loadFromStorage } from './storage';
import {
  type RegisterPayload,
  type AuthResponse,
  type DeviceResponse,
  type UploadSnapshotPayload,
  type PendingRestoreResponse,
  type CompleteRestorePayload
} from '@vaulttabs/shared';

// We alias this for internal use in apiGetPendingRestore
type PendingRestoreRequestDetail = NonNullable<PendingRestoreResponse['request']>;
export type { PendingRestoreRequestDetail as PendingRestoreRequest };

import { type Device, type RestoreRequest } from '@vaulttabs/shared';
export type { Device, RestoreRequest };

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// Change API_BASE_URL to your production URL when you deploy the backend
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL = (import.meta.env as any).VITE_API_URL || 'https://100.129.163.119:3000/api/v1';

// ─────────────────────────────────────────────────────────────────────────────
// BASE FETCH WRAPPER
// Adds auth headers and standardizes error handling
// ─────────────────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
  data?: T;
  error?: string;
  ok: boolean;
}

/**
 * Base function for all API calls.
 * Automatically adds the JWT token if available.
 *
 * IMPORTANT: We never call response.json() directly anymore.
 * Instead we read the body as text first, then try to parse it.
 * This prevents "Unexpected end of JSON input" when the server:
 *   - Returns an empty body (204 No Content)
 *   - Crashes before sending a response
 *   - Returns an HTML error page instead of JSON
 */
async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  // Load the stored JWT token
  const storage = await loadFromStorage();
  const token = storage.jwt_token;

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  // Add auth header if we have a token
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });

    // ── SAFE BODY PARSING ────────────────────────────────────────────────────
    // Step 1: Read body as plain text (always works, never throws on empty body)
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';

    // Step 2: Try to parse as JSON if body is non-empty and content-type says JSON
    let json: unknown = null;

    if (text.length > 0) {
      if (contentType.includes('application/json')) {
        try {
          json = JSON.parse(text);
        } catch {
          // Body exists but is not valid JSON
          // This usually means the server crashed mid-response
          return {
            ok: false,
            error: `Server returned malformed JSON. Response was: ${text.slice(0, 300)}`,
          };
        }
      } else {
        // Server returned HTML or plain text (often a crash error page)
        // Common when: Fastify has an unhandled error, Node process throws, etc.
        return {
          ok: false,
          error: `Server error (HTTP ${response.status}). Check that your backend is running correctly.\nRaw response: ${text.slice(0, 200)}`,
        };
      }
    }

    // Step 3: Check if HTTP status indicates an error
    if (!response.ok) {
      const errorBody = json as Record<string, string> | null;
      return {
        ok: false,
        error: errorBody?.message || errorBody?.error || `Request failed with HTTP ${response.status}`,
      };
    }

    return { ok: true, data: json as T };

  } catch (err) {
    // This catches genuine network errors:
    // - Backend server not running
    // - No internet connection
    // - CORS blocked (check backend CORS config)
    // - DNS resolution failure
    const message = err instanceof Error ? err.message : 'Unknown network error';
    console.error(`[VaultTabs] Network error for ${path}:`, message);
    return {
      ok: false,
      error: `Cannot reach the VaultTabs server at ${API_BASE_URL}.\n\nMake sure:\n1. The backend is running (npm run dev in the backend folder)\n2. It's on port 3000\n3. Your firewall isn't blocking it\n\nError: ${message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────
// (Local types replaced by @vaulttabs/shared imports)

/** Register a new account */
export async function apiRegister(payload: RegisterPayload) {
  return apiFetch<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Login with email + password */
export async function apiLogin(email: string, password: string) {
  return apiFetch<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

/** Get current user info + crypto data (for re-login after browser restart) */
export async function apiGetMe() {
  return apiFetch<AuthResponse>('/auth/me');
}

// ─────────────────────────────────────────────────────────────────────────────
// DEVICE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// (Local DeviceResponse replaced)

/** Register this browser as a device */
export async function apiRegisterDevice(deviceName: string) {
  return apiFetch<DeviceResponse>('/devices/register', {
    method: 'POST',
    body: JSON.stringify({ device_name: deviceName }),
  });
}

/** Update this device's last_seen timestamp */
export async function apiHeartbeat(deviceId: string) {
  return apiFetch(`/devices/${deviceId}/heartbeat`, {
    method: 'PATCH',
    body: JSON.stringify({})
  });
}

/** Rename a device */
export async function apiRenameDevice(deviceId: string, name: string) {
  return apiFetch<{ message: string; device: any }>(`/account/devices/${deviceId}`, {
    method: 'PATCH',
    body: JSON.stringify({ device_name: name })
  });
}

/** Get all registered devices for this user */
export async function apiGetDevices() {
  return apiFetch<{ devices: Device[] }>('/devices');
}

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// (Local UploadSnapshotPayload replaced)

/** Upload an encrypted tab snapshot */
export async function apiUploadSnapshot(payload: UploadSnapshotPayload) {
  return apiFetch('/snapshots', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// (Local PendingRestoreRequest replaced)

/** Poll for any pending restore request targeting this device */
export async function apiGetPendingRestore(deviceId: string) {
  return apiFetch<PendingRestoreResponse>(
    `/restore/pending?device_id=${deviceId}`
  );
}

/** Mark a restore request as completed or failed */
export async function apiCompleteRestore(
  requestId: string,
  status: 'completed' | 'failed',
  errorMsg?: string
) {
  const payload: CompleteRestorePayload = { status, error_msg: errorMsg };
  return apiFetch<{ message: string; request_id: string; status: string }>(
    `/restore/${requestId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
}

/** Create a new restore request (send tab/snapshot to another device) */
export async function apiCreateRestoreRequest(payload: {
  target_device_id: string;
  snapshot_id?: string;
  target_url?: string;
}) {
  return apiFetch<{ message: string; request_id: string; status: string; expires_at: string }>(
    '/restore',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

// ── SERVER SENT EVENTS (SSE) STREAMING ───────────────────────────────────────

/**
 * Connects to the SSE stream to receive restore requests in real-time.
 * Manually consumes the ReadableStream because EventSource does not
 * support passing Authorization headers natively.
 */
export async function apiConnectRestoreStream(
  deviceId: string,
  onEvent: (data: { pending: boolean; request?: PendingRestoreRequestDetail }) => void,
  onDisconnect: (error: Error | null) => void
) {
  const storage = await loadFromStorage();
  const token = storage.jwt_token;

  if (!token) {
    onDisconnect(new Error('Authentication required for stream'));
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/restore/stream?device_id=${deviceId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'text/event-stream',
      },
      // Important to keep the streams going without caching
      cache: 'no-store',
    });

    if (!response.ok || !response.body) {
      onDisconnect(new Error(`Stream connection failed with status ${response.status}`));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      // If the server closes the connection or network drops
      if (done) {
        onDisconnect(null); // clean disconnect
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // The last element is either an empty string (if buffer ended with \n)
      // or an incomplete line. Keep it in the buffer for the next chunk.
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            onEvent(data);
          } catch (err) {
            console.error('[VaultTabs SSE] Failed to parse event JSON:', err);
          }
        } else if (line.startsWith(':')) {
          // Heartbeat received -> call chrome API to reset the 30s idle timer!
          // This keeps the MV3 background service worker alive indefinitely
          // as long as the backend continues sending 20s heartbeats.
          if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
            chrome.runtime.getPlatformInfo(() => { });
          }
        }
      }
    }
  } catch (err) {
    onDisconnect(err instanceof Error ? err : new Error('Stream network error'));
  }
}

/**
 * Detect a human-readable device name.
 * Uses browser user agent to guess browser name.
 * e.g. "Chrome on Windows", "Firefox on Mac"
 */
export function getDeviceName(): string {
  const ua = navigator.userAgent;
  let browser = 'Unknown Browser';
  let os = 'Unknown OS';

  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera';
  else if (ua.includes('Brave')) browser = 'Brave';
  else if (ua.includes('Chrome')) browser = 'Chrome';

  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'Mac';
  else if (ua.includes('Linux')) os = 'Linux';

  return `${browser} on ${os}`;
}
