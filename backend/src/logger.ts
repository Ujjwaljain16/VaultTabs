import pino from 'pino';
import type { LogLevel } from './config.js';

/** The subset of the pino / Fastify logger API used outside request handlers. */
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Never log credentials or key material, wherever they appear in a logged object. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'password',
  'auth_key',
  'token',
  'recovery_key_hash',
  '*.password',
  '*.auth_key',
  '*.token',
  '*.recovery_key_hash',
  '*.recovery_encrypted_master_key',
  '*.encrypted_master_key',
  '*.current',
  '*.next',
  '*.recovery',
];

export function createCliLogger(level: LogLevel = 'info'): pino.Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
}
