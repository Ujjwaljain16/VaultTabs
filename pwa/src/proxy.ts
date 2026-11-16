/**
 * Next.js 16 proxy (formerly "middleware"): per-request CSP nonce.
 *
 * Next reads the nonce from the request's Content-Security-Policy header and adds it to every
 * framework/inline script it renders (pages are dynamic: see `await connection()` in layout.tsx).
 * 'strict-dynamic' lets those trusted scripts load the hashed chunks; nothing else may run.
 */

import { NextResponse, type NextRequest } from 'next/server';

function apiOrigin(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1').origin;
  } catch {
    return null;
  }
}

export function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === 'development';
  const api = apiOrigin();
  // Only upgrade when the API itself is HTTPS (a plain-http API means a local test deployment).
  const upgrade = !isDev && api?.startsWith('https:');
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${api ? ` ${api}` : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(upgrade ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: skip build assets, icons, the manifest, the service worker and the offline page.
      source: '/((?!_next/static|_next/image|favicon.png|icon-|manifest.json|sw.js|offline.html).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
