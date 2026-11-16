const DEV_API_URL = 'http://localhost:3000/api/v1';

/** Backend base URL (no trailing slash). Production builds refuse to build without VITE_API_URL. */
export const API_URL: string = (
  import.meta.env.VITE_API_URL || (import.meta.env.DEV ? DEV_API_URL : '')
).replace(/\/+$/, '');

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Optional web dashboard URL (Settings → "Open web dashboard"). */
export const DASHBOARD_URL: string | null = safeHttpUrl(import.meta.env.VITE_DASHBOARD_URL);
