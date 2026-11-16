import { readFileSync } from 'node:fs';
import { defineConfig, type ConfigEnv, type UserManifest } from 'wxt';

/**
 * Build-time configuration. WXT loads `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`
 * (and browser-specific variants) into process.env before `manifest()` runs; real environment
 * variables take precedence. See .env.example.
 */

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const DEV_API_URL = 'http://localhost:3000/api/v1';

// Placeholder only: AMO assigns/accepts a real ID when you publish. Set VITE_FIREFOX_EXTENSION_ID.
const DEFAULT_FIREFOX_ID = 'vaulttabs@example.invalid';

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/** Resolves and validates the backend origin. Throws (fails the build) on unsafe production config. */
function resolveApiOrigin({ mode, command }: ConfigEnv): string {
  const isDev = mode === 'development';
  const raw = process.env.VITE_API_URL?.trim();
  if (!raw) {
    if (isDev) return new URL(DEV_API_URL).origin;
    throw new Error(
      `[vaulttabs] VITE_API_URL is required for "${command}" in mode "${mode}". ` +
        'Set it in the environment or extension/.env.production.local, e.g. VITE_API_URL=https://api.example.com/api/v1',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`[vaulttabs] VITE_API_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`[vaulttabs] VITE_API_URL must be http(s): ${raw}`);
  }
  if (!isDev && url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error(`[vaulttabs] VITE_API_URL must use https outside development (got ${url.origin}).`);
  }
  return url.origin;
}

function buildCsp(apiOrigin: string, isDev: boolean): string {
  // In dev, WXT adds its dev-server origin to script-src and needs a websocket for HMR, so only
  // the script/object restrictions apply there.
  if (isDev) return "script-src 'self'; object-src 'none'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    `connect-src 'self' ${apiOrigin}`,
    // Favicons of the user's own open tabs (http(s) or data: URLs reported by the browser).
    "img-src 'self' data: https: http:",
    "style-src 'self'",
    "font-src 'self'",
  ].join('; ');
}

/**
 * Public key that pins the Chrome extension ID (pgajemmicfcgngenjflggimgkfedcknp) for every build,
 * including unpacked installs from any folder. A stable ID keeps chrome.storage.sync (and with it
 * this browser's device id) across reinstalls, so a reinstall never shows up as a new device.
 * Not a secret. Forks/self-hosters can set VITE_CHROME_EXTENSION_KEY to use their own ID.
 */
const DEFAULT_CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArNQMVKpCug1vi4WV2dhvPPA+pNKp1Ol1x00RD5s9/fEqiLbkQC04uTQID+vjiFfiDz8krw4bwdFO5yYdeJ4TZ7GQ0zWxQ73kSsxI6jBqoJ7iwHFfCqLa1H85llqO8Xu9UnxMRRijcCI7wgRUCsjCIF31x8mFkdOD/rJRG33b46XQgqmoY9AklYMjO6zE2U/oGmvp04EIDYRoU7/p14sZCj8u3rDdDd5UHxBdQrWtCyzq5a/W55+wCa3WwJi0mfcBPxXzgmA/IpQcnHJxeaqmF8fArbUUlMADApmzb/kXzgGmIe/c0ftZseal0Mc8v37bOjKgiQabq5nr2evh6s9uLwIDAQAB';

const icons = { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' };

export default defineConfig({
  // Explicit imports only (no auto-imported globals).
  imports: false,
  manifest: (env): UserManifest => {
    const isDev = env.mode === 'development';
    const apiOrigin = resolveApiOrigin(env);

    const hostPermissions = new Set([`${apiOrigin}/*`]);
    if (isDev) hostPermissions.add('http://localhost:3000/*');

    const manifest: UserManifest = {
      name: 'VaultTabs',
      description: 'Cross-browser tab sync with end-to-end encrypted snapshots',
      version: pkg.version,
      // `windows` is not a permission: chrome.windows works without one.
      permissions: ['tabs', 'storage', 'alarms'],
      host_permissions: [...hostPermissions],
      icons,
      action: { default_title: 'VaultTabs', default_icon: icons },
      content_security_policy: { extension_pages: buildCsp(apiOrigin, isDev) },
    };

    if (env.browser !== 'firefox') {
      manifest.key = process.env.VITE_CHROME_EXTENSION_KEY?.trim() || DEFAULT_CHROME_KEY;
    }

    if (env.browser === 'firefox') {
      manifest.browser_specific_settings = {
        gecko: {
          id: process.env.VITE_FIREFOX_EXTENSION_ID?.trim() || DEFAULT_FIREFOX_ID,
          // 140 is the first ESR with built-in data-collection consent.
          strict_min_version: '140.0',
          data_collection_permissions: {
            // Account email, a password-derived login key, and (end-to-end encrypted) open tabs
            // are sent to the configured VaultTabs server.
            required: ['personallyIdentifyingInfo', 'authenticationInfo', 'browsingActivity'],
          },
        },
      };
    }
    return manifest;
  },
});
