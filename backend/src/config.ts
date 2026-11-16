// Environment configuration, validated once at startup.
//
// Nothing here reads files or has side effects: `.env` loading (dotenv) happens only in the CLI
// entry points (server.ts, db/migrate.ts, db/cleanup.ts), and never overrides variables that are
// already set. Tests build a Config from an explicit object.

import { createHmac } from 'node:crypto';
import { z } from 'zod';

export type DatabaseSsl = 'require' | 'insecure' | 'disable';
export type NodeEnv = 'development' | 'production' | 'test';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface DatabaseConfig {
  databaseUrl: string;
  databaseSsl: DatabaseSsl;
  databasePoolMax: number;
}

export interface Config extends DatabaseConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  jwtSecret: string;
  jwtExpiry: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  /** Exact origins or `*` wildcard patterns. Empty: any origin in development, none in production. */
  allowedOrigins: string[];
  trustProxy: boolean;
  tls: { certFile: string; keyFile: string } | null;
  maxDevicesPerUser: number;
  /** 0 disables the in-process cleanup job. */
  cleanupIntervalMinutes: number;
  /** Key for the deterministic fake prelogin/recovery data returned for unknown emails. */
  preloginSecret: Buffer;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const JWT_SECRET_PLACEHOLDERS = [
  'your_64_char_hex_secret_here',
  'changeme',
  'change-me',
  'change_me',
  'secret',
  'replace-me',
  'replace_me',
  'your-secret',
  'your_secret',
];

function isPlaceholderSecret(value: string): boolean {
  const v = value.toLowerCase();
  if (
    JWT_SECRET_PLACEHOLDERS.includes(v) ||
    /^your[_-]|changeme|change[_-]me|placeholder|replace[_-]me/.test(v)
  ) {
    return true;
  }
  // A single repeated character ("aaaa…", "0000…") is not a secret.
  return new Set(value).size < 8;
}

const boolString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .optional()
  .transform(v => v === 'true' || v === '1' || v === 'yes');

const databaseSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// or postgresql:// URL'),
  DATABASE_SSL: z.enum(['require', 'insecure', 'disable']).default('require'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

const fullSchema = databaseSchema
  .extend({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    JWT_SECRET: z
      .string({
        error:
          "JWT_SECRET is required (generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")",
      })
      .min(32, 'JWT_SECRET must be at least 32 characters')
      .refine(v => !isPlaceholderSecret(v), 'JWT_SECRET looks like a placeholder; generate a random one'),
    JWT_EXPIRY: z
      .string()
      .regex(/^\d+\s*(s|m|h|d|w)$/, 'JWT_EXPIRY must look like 3600s, 60m, 12h, 30d or 2w')
      .default('30d'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    ALLOWED_ORIGINS: z.string().default(''),
    TRUST_PROXY: boolString,
    TLS_CERT_FILE: z.string().optional(),
    TLS_KEY_FILE: z.string().optional(),
    MAX_DEVICES_PER_USER: z.coerce.number().int().min(1).max(10_000).default(25),
    CLEANUP_INTERVAL_MINUTES: z.coerce
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60)
      .default(60),
    PRELOGIN_SECRET: z.string().min(32, 'PRELOGIN_SECRET must be at least 32 characters').optional(),
  })
  .refine(e => Boolean(e.TLS_CERT_FILE) === Boolean(e.TLS_KEY_FILE), {
    message: 'TLS_CERT_FILE and TLS_KEY_FILE must be set together (or both left empty)',
    path: ['TLS_CERT_FILE'],
  });

/** Treat empty strings (e.g. `FOO=` in .env or `${FOO:-}` in compose) as unset. */
function clean(env: Env): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map(i => `  - ${i.path.join('.') || '(env)'}: ${i.message}`).join('\n');
}

export function loadDatabaseConfig(env: Env = process.env): DatabaseConfig {
  const parsed = databaseSchema.safeParse(clean(env));
  if (!parsed.success)
    throw new ConfigError(`Invalid database configuration:\n${formatIssues(parsed.error)}`);
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    databaseSsl: parsed.data.DATABASE_SSL,
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
  };
}

export function loadConfig(env: Env = process.env): Config {
  const parsed = fullSchema.safeParse(clean(env));
  if (!parsed.success) throw new ConfigError(`Invalid configuration:\n${formatIssues(parsed.error)}`);
  const e = parsed.data;
  const preloginSecret = e.PRELOGIN_SECRET
    ? Buffer.from(e.PRELOGIN_SECRET, 'utf8')
    : // Distinct label so the derived key is independent of the JWT signing key.
      createHmac('sha256', e.JWT_SECRET).update('vaulttabs/prelogin-secret/v1').digest();

  return {
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    jwtSecret: e.JWT_SECRET,
    jwtExpiry: e.JWT_EXPIRY.replace(/\s+/g, ''),
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    allowedOrigins: e.ALLOWED_ORIGINS.split(',')
      .map(o => o.trim())
      .filter(Boolean),
    trustProxy: e.TRUST_PROXY,
    tls: e.TLS_CERT_FILE && e.TLS_KEY_FILE ? { certFile: e.TLS_CERT_FILE, keyFile: e.TLS_KEY_FILE } : null,
    maxDevicesPerUser: e.MAX_DEVICES_PER_USER,
    cleanupIntervalMinutes: e.CLEANUP_INTERVAL_MINUTES,
    preloginSecret,
  };
}
