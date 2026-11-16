/**
 * Build-time configuration. NEXT_PUBLIC_* values are inlined into the browser bundle by `next build`,
 * so they must be provided at build time (see pwa/.env.example and the dockerfile build args).
 */

const DEFAULT_REPO_URL = 'https://github.com/Ujjwaljain16/VaultTabs';

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Base URL of the VaultTabs API, e.g. https://api.example.com/api/v1 */
export const API_URL = stripTrailingSlash(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1');

/** Source repository (landing page, footer, security model link). */
export const REPO_URL = stripTrailingSlash(process.env.NEXT_PUBLIC_REPO_URL || DEFAULT_REPO_URL);

/** Where the "Download extension" button points. */
export const EXTENSION_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_EXTENSION_DOWNLOAD_URL || `${DEFAULT_REPO_URL}/releases/latest`;

/** The README section describing exactly what the server can and cannot see. */
export const SECURITY_MODEL_URL = `${REPO_URL}/blob/main/docs/security-model.md`;
