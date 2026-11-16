import type { preHandlerAsyncHookHandler } from 'fastify';
import { LIMITS } from '@vaulttabs/shared';
import { z } from 'zod';
import type { Container } from '../container.js';
import { notFound } from '../errors.js';
import { isUuid } from '../schemas.js';

export interface RouteDeps {
  container: Container;
  authenticate: preHandlerAsyncHookHandler;
  isOriginAllowed: (origin: string | undefined) => boolean;
}

/** `:id` path params: anything that is not a UUID cannot exist → 404 (never a database error). */
export function idParam(params: unknown, what = 'Resource'): string {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (!isUuid(id)) throw notFound(`${what} not found`);
  return id.toLowerCase();
}

export const deviceName = z
  .string({ error: 'device_name is required' })
  .trim()
  .min(1, 'device_name is required')
  .max(LIMITS.maxDeviceNameChars, `device_name must be at most ${LIMITS.maxDeviceNameChars} characters`);
