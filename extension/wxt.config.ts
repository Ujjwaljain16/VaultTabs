import { defineConfig } from 'wxt';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Host permissions are scoped to the configured backend (VITE_API_URL) when it is set at build
 * time. If it is not set we fall back to any-HTTPS so a build without .env still works - set
 * VITE_API_URL to get the narrower permission set.
 */
function readViteApiUrl(): string | undefined {
  if (process.env.VITE_API_URL) return process.env.VITE_API_URL;
  // WXT does not put .env files into process.env for this config file, so read them directly.
  for (const file of ['.env.production.local', '.env.local', '.env']) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, 'utf8').match(/^\s*VITE_API_URL\s*=\s*(.+?)\s*$/m);
    if (match) return match[1].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

function backendHostPermissions(): string[] {
  const local = ['http://localhost:3000/*', 'https://localhost:3000/*'];
  const apiUrl = readViteApiUrl();
  if (apiUrl) {
    try {
      const u = new URL(apiUrl);
      return [...local, `${u.protocol}//${u.host}/*`];
    } catch { /* fall through */ }
  }
  return [...local, 'https://*/*'];
}

/**
 * WXT Configuration
 *
 * PERMISSIONS EXPLAINED:
 * - "tabs"     → Read open tabs (URL, title, favicon, position)
 * - "storage"  → Save JWT token, deviceId, sync state in browser storage
 * - "alarms"   → Schedule the debounce timer and 3-minute fallback
 *                 (chrome.alarms survive service worker sleep; setTimeout does not)
 *
 * HOST PERMISSIONS:
 * - localhost:3000 → your local backend during development
 * - Add your production URL here when you deploy
 */
export default defineConfig({
  manifest: {
    name: 'VaultTabs',
    description: 'Cross-browser tab sync with client-side encrypted snapshots',
    version: '0.1.0',
    permissions: ['tabs', 'storage', 'alarms', 'windows'],
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    action: {
      default_title: 'VaultTabs',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
        128: 'icon-128.png',
      },
    },
    // Local dev endpoints + the backend from VITE_API_URL (see backendHostPermissions above)
    host_permissions: backendHostPermissions(),
  },
});