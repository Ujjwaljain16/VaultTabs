// Shared test setup. Tests NEVER read backend/.env: every setting is passed explicitly, and the
// database must be a local throwaway one (TEST_DATABASE_URL, default below).

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
  MIN_PBKDF2_ITERATIONS,
  createAccountMaterial,
  deriveAccountKeys,
  unwrapMasterKey,
} from '@vaulttabs/shared/crypto';
import type { AuthResponse } from '@vaulttabs/shared';
import { buildServer } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createSql, type Sql } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/vaulttabs_test';

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) &&
    process.env.TEST_DATABASE_ALLOW_REMOTE !== '1'
  ) {
    throw new Error(`Refusing to run destructive tests against non-local database host "${host}".`);
  }
}

export const ITERATIONS = MIN_PBKDF2_ITERATIONS;

export function testConfig(overrides: Record<string, string> = {}): Config {
  assertLocal(TEST_DATABASE_URL);
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_SSL: 'disable',
    DATABASE_POOL_MAX: '5',
    JWT_SECRET: 'test-jwt-secret-4f9a1c7e2b8d6035aa91e0c4d7b2f681',
    ALLOWED_ORIGINS: 'https://app.example.test,chrome-extension://*',
    CLEANUP_INTERVAL_MINUTES: '0',
    ...overrides,
  });
}

export function adminSql(): Sql {
  assertLocal(TEST_DATABASE_URL);
  return createSql({ databaseUrl: TEST_DATABASE_URL, databaseSsl: 'disable', databasePoolMax: 3 });
}

/** Drop and recreate the public schema; optionally migrate. */
export async function resetDatabase(sql: Sql, options: { migrate?: boolean } = {}): Promise<void> {
  assertLocal(TEST_DATABASE_URL);
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  if (options.migrate !== false) await runMigrations(sql);
}

export interface TestContext {
  server: FastifyInstance;
  sql: Sql;
}

export async function setup(overrides: Record<string, string> = {}): Promise<TestContext> {
  const sql = adminSql();
  await resetDatabase(sql);
  const server = await buildServer(testConfig(overrides));
  await server.ready();
  return { server, sql };
}

export async function teardown(ctx: TestContext | undefined): Promise<void> {
  if (!ctx) return;
  await ctx.server.close();
  await ctx.sql.end({ timeout: 5 });
}

let ipCounter = 1;
/** A fresh client IP per call so per-IP rate limits on auth routes don't trip during tests. */
export function freshIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  ip?: string;
  headers?: Record<string, string>;
}

export async function api(
  server: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: RequestOptions = {},
): Promise<LightMyRequestResponse> {
  return server.inject({
    method,
    url:
      url.startsWith('/api/') || url.startsWith('/health') || url.startsWith('/ready')
        ? url
        : `/api/v1${url}`,
    remoteAddress: options.ip ?? freshIp(),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
}

export interface TestUser {
  email: string;
  password: string;
  token: string;
  userId: string;
  masterKey: CryptoKey;
  recoveryCode: string;
  authKey: string;
  auth: AuthResponse;
}

let userCounter = 0;
export function uniqueEmail(prefix = 'user'): string {
  userCounter++;
  return `${prefix}-${Date.now().toString(36)}-${userCounter}@example.com`;
}

export async function registerUser(server: FastifyInstance, email = uniqueEmail()): Promise<TestUser> {
  const password = `correct horse battery ${userCounter}`;
  const { masterKey, recoveryCode, payload } = await createAccountMaterial(password, ITERATIONS);
  const res = await api(server, 'POST', '/auth/register', { body: { email, ...payload } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const auth = res.json<AuthResponse>();
  return {
    email: auth.user.email,
    password,
    token: auth.token,
    userId: auth.user.id,
    masterKey,
    recoveryCode,
    authKey: payload.auth_key,
    auth,
  };
}

export async function registerDevice(
  server: FastifyInstance,
  token: string,
  name = 'Test browser',
): Promise<string> {
  const res = await api(server, 'POST', '/devices/register', { token, body: { device_name: name } });
  if (res.statusCode !== 201) throw new Error(`device register failed: ${res.statusCode} ${res.body}`);
  return res.json<{ device: { id: string } }>().device.id;
}

/** Derive keys like a client would and check the server's crypto params unwrap the master key. */
export async function unwrapWithPassword(
  auth: { crypto: AuthResponse['crypto'] },
  password: string,
): Promise<CryptoKey> {
  const { wrappingKey } = await deriveAccountKeys(password, auth.crypto.salt, auth.crypto.kdf_iterations);
  return unwrapMasterKey(auth.crypto.encrypted_master_key, auth.crypto.master_key_iv, wrappingKey, true);
}

export const NIL_UUID = '00000000-0000-4000-8000-000000000000';
