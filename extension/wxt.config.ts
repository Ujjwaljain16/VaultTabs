import { defineConfig } from 'wxt';

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
    description: 'Zero-knowledge cross-browser tab sync',
    version: '0.1.0',
    permissions: ['tabs', 'storage', 'alarms', 'windows'],
    host_permissions: [
      // Local dev endpoints
      'http://localhost:3000/*',
      'https://localhost:3000/*',
      // Production: covers any HTTPS backend URL
      // Update VITE_API_URL in .env.production.local to point to your prod backend
      'https://*/*',
    ],
  },
});