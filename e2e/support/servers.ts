/**
 * Builds and runs the real apps for the suite: a fresh Postgres database, the backend (dist), the
 * PWA (`next start`) and a tiny static site that provides the pages the browsers open.
 *
 * Backend and PWA run as detached processes whose PIDs are kept in STATE_DIR, so a test (which
 * runs in a worker process) can stop / restart the backend, and global teardown can stop both.
 */

import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import postgres from 'postgres';
import {
  API_ORIGIN,
  API_PORT,
  API_URL,
  DB_NAME,
  EXTENSION_OUT_DIR,
  JWT_SECRET,
  PG_ADMIN_URL,
  PWA_PORT,
  PWA_URL,
  ROOT,
  SITE_PORT,
  STATE_DIR,
  assertLocalDatabase,
  databaseUrl,
} from './env';

const isWindows = process.platform === 'win32';

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Build ─────────────────────────────────────────────────────────────────────────────────────

function run(command: string, args: string[], options: SpawnSyncOptions = {}): void {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWindows,
    ...options,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})`);
}

/** Newest modification time of any file below `dir` (skipping build output and dependencies). */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.output', '.wxt', 'dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * Builds everything the suite runs. Shared, backend and extension are quick and always rebuilt;
 * the PWA (slow) only when its sources, shared/ or the API URL changed since the last e2e build.
 * E2E_SKIP_BUILD=1 skips building entirely.
 */
export function buildAll(): void {
  if (process.env.E2E_SKIP_BUILD === '1') return;
  ensureStateDir();
  run('npm', ['run', 'build:shared']);
  run('npm', ['run', 'build', '--workspace=backend']);
  run('npm', ['run', 'build', '--workspace=extension'], {
    env: { VITE_API_URL: API_URL, VITE_DASHBOARD_URL: PWA_URL, WXT_OUT_DIR: EXTENSION_OUT_DIR },
  });

  const stampFile = path.join(STATE_DIR, 'pwa-build.json');
  const sourceTime = Math.max(
    newestMtime(path.join(ROOT, 'pwa', 'src')),
    newestMtime(path.join(ROOT, 'pwa', 'public')),
    newestMtime(path.join(ROOT, 'shared', 'src')),
    fs.statSync(path.join(ROOT, 'pwa', 'next.config.js')).mtimeMs,
  );
  let stamp: { apiUrl?: string; sourceTime?: number } = {};
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')) as typeof stamp;
  } catch {
    // first build
  }
  const built = fs.existsSync(path.join(ROOT, 'pwa', '.next', 'BUILD_ID'));
  if (
    process.env.E2E_REBUILD_PWA === '1' ||
    !built ||
    stamp.apiUrl !== API_URL ||
    (stamp.sourceTime ?? 0) < sourceTime
  ) {
    run('npm', ['run', 'build', '--workspace=pwa'], {
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_TELEMETRY_DISABLED: '1' },
    });
    fs.writeFileSync(stampFile, JSON.stringify({ apiUrl: API_URL, sourceTime }));
  }
}

// ─── Database ──────────────────────────────────────────────────────────────────────────────────

export async function resetDatabase(): Promise<void> {
  assertLocalDatabase();
  const admin = postgres(PG_ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  run(process.execPath, ['backend/dist/db/migrate.js'], {
    shell: false,
    stdio: 'pipe',
    env: backendEnv(),
  });
}

// ─── Processes ─────────────────────────────────────────────────────────────────────────────────

function backendEnv(): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl(),
    DATABASE_SSL: 'disable',
    JWT_SECRET,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    ALLOWED_ORIGINS: `${PWA_URL},chrome-extension://pgajemmicfcgngenjflggimgkfedcknp`,
    CLEANUP_INTERVAL_MINUTES: '0',
    LOG_LEVEL: 'info',
  };
}

function pidFile(name: string): string {
  return path.join(STATE_DIR, `${name}.pid`);
}

export function logFile(name: string): string {
  return path.join(STATE_DIR, `${name}.log`);
}

function startDetached(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) {
  ensureStateDir();
  const out = fs.openSync(logFile(name), 'a');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);
  if (child.pid === undefined) throw new Error(`could not start ${name}`);
  fs.writeFileSync(pidFile(name), String(child.pid));
}

function killTree(pid: number): void {
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function stopProcess(name: string): void {
  const file = pidFile(name);
  if (!fs.existsSync(file)) return;
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (pid > 0) killTree(pid);
  fs.rmSync(file, { force: true });
}

async function waitFor(url: string, timeoutMs: number, wantUp = true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let up = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      up = res.ok;
    } catch {
      up = false;
    }
    if (up === wantUp) return;
    if (Date.now() > deadline) throw new Error(`${url} did not become ${wantUp ? 'ready' : 'unreachable'}`);
    await sleep(200);
  }
}

export async function startBackend(): Promise<void> {
  startDetached('backend', process.execPath, ['backend/dist/server.js'], ROOT, backendEnv());
  await waitFor(`${API_ORIGIN}/ready`, 30_000);
}

/** Hard-kills the backend (like a crash); open SSE connections drop. */
export async function stopBackend(): Promise<void> {
  stopProcess('backend');
  await waitFor(`${API_ORIGIN}/health`, 15_000, false);
}

/** Also resets the in-memory per-IP rate limits, which is why spec files call it first. */
export async function restartBackend(): Promise<void> {
  await stopBackend();
  await startBackend();
}

export async function startPwa(): Promise<void> {
  startDetached(
    'pwa',
    process.execPath,
    [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PWA_PORT)],
    path.join(ROOT, 'pwa'),
    { NEXT_PUBLIC_API_URL: API_URL, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
  );
  await waitFor(`${PWA_URL}/manifest.json`, 60_000);
}

export function stopAll(): void {
  stopProcess('backend');
  stopProcess('pwa');
}

// ─── Static site ───────────────────────────────────────────────────────────────────────────────

/**
 * `GET /p/<slug>?title=<t>` → an HTML page titled `t` (default "Page <slug>"). Every path is a
 * distinct, real http page, so the browsers have something to sync.
 */
export function startSite(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${SITE_PORT}`);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(404).end();
      return;
    }
    const slug = decodeURIComponent(url.pathname.replace(/^\/p\//, '').replace(/^\//, '')) || 'home';
    const title = url.searchParams.get('title') ?? `Page ${slug}`;
    const escaped = title.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escaped}</title></head><body><h1>${escaped}</h1></body></html>`,
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SITE_PORT, '127.0.0.1', () => resolve(server));
  });
}
