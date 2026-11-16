import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, parseOrThrow } from '../errors.js';
import {
  authKey,
  credential,
  email,
  legacyPassword,
  passwordMaterial,
  recoveryMaterial,
} from '../schemas.js';
import type { RouteDeps } from './common.js';

// Strict per-IP limits on unauthenticated credential endpoints (the global limit still applies to
// everything else).
const limit = (max: number, timeWindow: string) => ({ rateLimit: { max, timeWindow } });

const PreloginBody = z.object({ email });
const RegisterBody = z.object({ email }).extend(passwordMaterial.shape).extend(recoveryMaterial.shape);
const LoginBody = z
  .object({ email, auth_key: z.string().max(100).optional(), password: legacyPassword.optional() })
  .refine(b => b.auth_key !== undefined || b.password !== undefined, {
    message: 'auth_key (or password for legacy accounts) is required',
    path: ['auth_key'],
  });
const UpgradeBody = z.object({ password: legacyPassword }).extend(passwordMaterial.shape);
const ChangePasswordBody = z.object({ current: credential, next: passwordMaterial });
const RegenerateRecoveryBody = z.object({ current: credential, recovery: recoveryMaterial });
const RecoveryMaterialBody = z.object({ email });
const RecoverBody = z.object({
  email,
  recovery_key_hash: z.string().max(100),
  next: passwordMaterial,
  recovery: recoveryMaterial,
});

export async function authRoutes(fastify: FastifyInstance, { container, authenticate }: RouteDeps) {
  const { authService } = container;

  fastify.post('/auth/prelogin', { config: limit(30, '1 minute') }, async request => {
    const body = parseOrThrow(PreloginBody, request.body);
    return authService.prelogin(body.email);
  });

  fastify.post('/auth/register', { config: limit(10, '1 hour') }, async (request, reply) => {
    const body = parseOrThrow(RegisterBody, request.body);
    const { email: address, ...rest } = body;
    const result = await authService.register(address, rest, rest);
    return reply.status(201).send(result);
  });

  fastify.post('/auth/login', { config: limit(10, '1 minute') }, async request => {
    const body = parseOrThrow(LoginBody, request.body);
    if (body.auth_key !== undefined && !authKey.safeParse(body.auth_key).success) {
      throw badRequest('auth_key must be base64 of 32 bytes', 'validation_failed');
    }
    return authService.login(body.email, { auth_key: body.auth_key, password: body.password });
  });

  fastify.post(
    '/auth/upgrade',
    { preHandler: authenticate, config: limit(10, '1 minute') },
    async request => {
      const { password, ...material } = parseOrThrow(UpgradeBody, request.body);
      return authService.upgrade(request.user.userId, password, material);
    },
  );

  fastify.get('/auth/me', { preHandler: authenticate }, async request => authService.me(request.user.userId));

  fastify.post(
    '/auth/change-password',
    { preHandler: authenticate, config: limit(10, '1 hour') },
    async request => {
      const body = parseOrThrow(ChangePasswordBody, request.body);
      return authService.changePassword(request.user.userId, body.current, body.next);
    },
  );

  fastify.post(
    '/auth/recovery-code',
    { preHandler: authenticate, config: limit(10, '1 hour') },
    async request => {
      const body = parseOrThrow(RegenerateRecoveryBody, request.body);
      await authService.regenerateRecovery(request.user.userId, body.current, body.recovery);
      return { message: 'Recovery code replaced. The old code no longer works.' };
    },
  );

  fastify.post('/auth/logout-all', { preHandler: authenticate, config: limit(10, '1 hour') }, async request =>
    authService.logoutAll(request.user.userId),
  );

  fastify.post('/auth/recovery-material', { config: limit(10, '1 minute') }, async request => {
    const body = parseOrThrow(RecoveryMaterialBody, request.body);
    return authService.recoveryMaterial(body.email);
  });

  fastify.post('/auth/recover', { config: limit(5, '1 minute') }, async request => {
    const body = parseOrThrow(RecoverBody, request.body);
    await authService.recover(body.email, body.recovery_key_hash, body.next, body.recovery);
    return {
      message: 'Account recovered. Log in with your new password; all other sessions were signed out.',
    };
  });
}
