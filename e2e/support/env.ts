/** Fixed settings for the end-to-end suite (ports, paths, database). */

import path from 'node:path';

export const ROOT = path.resolve(__dirname, '..', '..');
export const E2E_DIR = path.join(ROOT, 'e2e');
/** PID files, server logs and build stamps (git-ignored). */
export const STATE_DIR = path.join(E2E_DIR, '.state');

export const API_PORT = 3010;
export const PWA_PORT = 3011;
export const SITE_PORT = 3012;

// 127.0.0.1, not localhost: the backend listens on loopback IPv4 only, and on Windows a
// "localhost" connection first tries ::1 and waits for that to fail on every new connection.
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const API_URL = `${API_ORIGIN}/api/v1`;
export const PWA_URL = `http://localhost:${PWA_PORT}`;
/** Tiny local web site whose pages are the "real" tabs the browsers sync. */
export const SITE_URL = `http://127.0.0.1:${SITE_PORT}`;

/** Built with WXT_OUT_DIR so a regular `.output/chrome-mv3` build is never overwritten. */
export const EXTENSION_OUT_DIR = '.output/e2e';
export const EXTENSION_DIR = path.join(ROOT, 'extension', EXTENSION_OUT_DIR, 'chrome-mv3');
/** Pinned by the manifest `key` (extension/wxt.config.ts). */
export const EXTENSION_ID = 'pgajemmicfcgngenjflggimgkfedcknp';
export const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup.html`;

/** Admin connection to a LOCAL throwaway Postgres; the suite drops and recreates DB_NAME. */
export const PG_ADMIN_URL = process.env.E2E_PG_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';
export const DB_NAME = process.env.E2E_DB_NAME ?? 'vaulttabs_e2e';

export function databaseUrl(): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  return url.toString();
}

export function assertLocalDatabase(): void {
  const host = new URL(PG_ADMIN_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to run the e2e suite against non-local database host "${host}".`);
  }
}

export const JWT_SECRET = 'e2e-only-jwt-secret-5c0b9e7a41d2f8836e1a0c9b7d4f2e61';

export const HEADED = process.env.E2E_HEADED === '1';
