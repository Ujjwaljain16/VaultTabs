const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for Docker standalone output (minimal image size)
  output: 'standalone',

  // Trace from the monorepo root so the standalone bundle has a deterministic layout
  // (pwa/server.js) and includes the @vaulttabs/shared workspace package.
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '..'),
  },

  async headers() {
    return [
      {
        source: '/manifest.json',
        headers: [{ key: 'Content-Type', value: 'application/manifest+json' }],
      },
      {
        // Baseline hardening headers. (No wildcard CORS: the PWA exposes no cross-origin API.)
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;