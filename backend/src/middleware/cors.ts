// CORS allow-list check shared by the main CORS plugin and the SSE stream route.
//
// - ALLOWED_ORIGINS (comma separated, "*" wildcards allowed) is enforced whenever it is set.
// - If it is NOT set: development allows any origin (convenience), production allows none.
// - Requests without an Origin header (curl, server-to-server, extension background pages with
//   host permissions) are not subject to CORS and pass through; authentication still applies.

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) return process.env.NODE_ENV !== 'production';

  return allowedOrigins.some(allowed => {
    if (allowed.includes('*')) {
      const escaped = allowed
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp('^' + escaped + '$').test(origin);
    }
    return allowed === origin;
  });
}
