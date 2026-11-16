// Backwards-compatible entry point for hosts still configured with `node dist/index.js`
// (VaultTabs < 1.0). Applies pending migrations, then starts the server.
// New deployments should use `npm start` (migrate + dist/server.js) instead.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

execFileSync(process.execPath, [fileURLToPath(new URL('./db/migrate.js', import.meta.url))], {
  stdio: 'inherit',
});

await import('./server.js');
