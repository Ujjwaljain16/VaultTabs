import { defineConfig } from 'wxt';

/**
 * wxt.firefox.config.ts
 *
 * Firefox-specific WXT configuration.
 * Run with: npm run dev:firefox  OR  npm run build:firefox
 *
 * KEY DIFFERENCES FROM CHROME:
 *
 * 1. Manifest V2 (not V3)
 *    Firefox supports MV3 but it's still catching up.
 *    MV2 is more stable on Firefox and has better background page support.
 *
 * 2. background.persistent = false
 *    Firefox's equivalent of Chrome's service worker — event-driven background.
 *    Our alarm-based debounce system works identically on both.
 *
 * 3. browser_specific_settings
 *    Firefox requires a unique extension ID (gecko.id).
 *    This can be any email-style string for development.
 *    For production, you'll need a real ID from addons.mozilla.org.
 *
 * 4. browser_action (MV2) vs action (MV3)
 *    WXT handles this automatically based on manifest_version.
 *
 * 5. IndexedDB + WebCrypto
 *    Both work identically in Firefox — no code changes needed.
 *
 * TO RUN:
 *   npm run dev:firefox     → opens Firefox with extension loaded
 *   npm run build:firefox   → builds for Firefox distribution

 **/

export default defineConfig({
  browser: 'firefox',

  manifest: {
    name: 'VaultTabs',
    description: 'Zero-knowledge cross-browser tab sync',
    version: '0.1.0',
    manifest_version: 2,

    // Firefox requires this block for extension identity
    browser_specific_settings: {
      gecko: {
        id: 'vaulttabs@yourdomain.com',
        strict_min_version: '109.0', // First version with stable MV2 + WebCrypto
      },
    },

    // MV2 uses "background.scripts" instead of "service_worker"
    // WXT handles the actual file generation; this configures the behavior
    background: {
      persistent: false, // Event-driven (like MV3 service worker)
    },

    permissions: [
      'tabs',
      'storage',
      'alarms',
      'windows',
    ],

    host_permissions: [
      'http://localhost:3000/*',
      'https://localhost:3000/*',
      'https://100.129.163.119:3000/*',
      'https://*/*',
    ],
  },
});