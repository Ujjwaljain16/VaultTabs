// CORS allow-list check shared by the CORS plugin and the SSE stream route.
//
// - ALLOWED_ORIGINS (comma separated, `*` wildcards allowed) is enforced whenever it is set.
// - If it is empty: development/test allow any origin, production allows none.
// - Requests without an Origin header (curl, server-to-server, extension background fetches with
//   host permissions) are not subject to CORS and pass; authentication still applies.

export function createOriginChecker(allowedOrigins: string[], isProduction: boolean) {
  const patterns = allowedOrigins.map(allowed =>
    allowed.includes('*')
      ? new RegExp(
          '^' +
            allowed
              .split('*')
              .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*') +
            '$',
        )
      : allowed,
  );

  return function isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    if (patterns.length === 0) return !isProduction;
    return patterns.some(p => (typeof p === 'string' ? p === origin : p.test(origin)));
  };
}
