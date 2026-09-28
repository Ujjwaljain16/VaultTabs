import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Container } from '../container.js';
import { authenticate } from '../middleware/auth.js';

// NOTE: `password` is the user's real account password, sent to the server over TLS and hashed
// with scrypt. The same password also derives the client-side key-wrapping key, so this endpoint
// is a point where the server operator could learn it. See README "Security model & limitations".
const RegisterSchema = z.object({
  email: z.string().email('Must be a valid email address').max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(1024),
  encrypted_master_key: z.string().min(1, 'encrypted_master_key is required').max(1024),
  master_key_iv: z.string().min(1, 'master_key_iv is required').max(64),
  salt: z.string().min(1, 'salt is required').max(128),
  recovery_encrypted_master_key: z.string().max(1024).optional(),
  recovery_key_iv: z.string().max(64).optional(),
  recovery_key_salt: z.string().max(128).optional(),
  recovery_key_hash: z.string().max(128).optional(),
});

const LoginSchema = z.object({
  email: z.string().email('Must be a valid email address').max(254),
  password: z.string().min(1, 'Password is required').max(1024),
});

const RecoveryMaterialSchema = z.object({
  email: z.string().email().max(254),
});

const RecoverSchema = z.object({
  email: z.string().email().max(254),
  recovery_code: z.string().min(1).max(128),
  new_password: z.string().min(8, 'Password must be at least 8 characters').max(1024),
  new_encrypted_master_key: z.string().min(1).max(1024),
  new_master_key_iv: z.string().min(1).max(64),
  new_salt: z.string().min(1).max(128),
});

// Stricter per-IP limits than the global 100/min for credential-guessing targets.
const AUTH_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const REGISTER_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: '1 hour' } };

type RegisterBody = z.infer<typeof RegisterSchema>;
type LoginBody = z.infer<typeof LoginSchema>;

export async function authRoutes(fastify: FastifyInstance, options: { container: Container }) {
  const { authService } = options.container;

  fastify.post<{ Body: RegisterBody }>('/auth/register', { config: REGISTER_RATE_LIMIT }, async (request, reply) => {
    const parseResult = RegisterSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const {
      email,
      password,
      encrypted_master_key,
      master_key_iv,
      salt,
      recovery_encrypted_master_key,
      recovery_key_iv,
      recovery_key_salt,
      recovery_key_hash
    } = parseResult.data;

    try {
      const result = await authService.register({
        email,
        password_plaintext: password,
        encrypted_master_key,
        master_key_iv,
        salt,
        recovery_encrypted_master_key,
        recovery_key_iv,
        recovery_key_salt,
        recovery_key_hash,
      });

      return reply.status(201).send({
        message: 'Account created successfully',
        token: result.token,
        user: {
          ...result.user,
          has_recovery_key: !!(result.user as any).recovery_encrypted_master_key,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      if (msg === 'Email already registered') {
        return reply.status(409).send({
          error: 'Email already registered',
          message: 'An account with this email already exists. Please log in instead.',
        });
      }
      throw err;
    }
  });

  fastify.post<{ Body: LoginBody }>('/auth/login', { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const parseResult = LoginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { email, password } = parseResult.data;

    try {
      const result = await authService.login(email, password);

      return reply.status(200).send({
        message: 'Login successful',
        ...result,
        user: {
          ...result.user,
          has_recovery_key: !!(result as any).user.recovery_encrypted_master_key
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      if (msg === 'Invalid credentials') {
        await new Promise(r => setTimeout(r, 100));
        return reply.status(401).send({
          error: 'Invalid credentials',
          message: 'Email or password is incorrect.',
        });
      }
      throw err;
    }
  });

  fastify.get('/auth/me', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    try {
      const { token: _unused, ...me } = await authService.getMe(request.user.userId);
      return reply.send(me);
    } catch {
      return reply.status(404).send({ error: 'User not found' });
    }
  });

  fastify.post<{ Body: { email: string } }>('/auth/recovery-material', { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const parsedBody = RecoveryMaterialSchema.safeParse(request.body);
    if (!parsedBody.success) return reply.status(400).send({ error: 'Valid email required' });
    const { email } = parsedBody.data;

    try {
      const material = await authService.getRecoveryMaterial(email);
      return reply.send(material);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Not found';
      if (msg === 'Recovery material not found') {
        return reply.status(404).send({
          error: 'Not found',
          message: 'No recovery key found for this account.'
        });
      }
      throw err;
    }
  });

  fastify.post('/auth/recover', { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const parsedBody = RecoverSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsedBody.error.flatten().fieldErrors,
      });
    }
    const {
      email,
      recovery_code,
      new_password,
      new_encrypted_master_key,
      new_master_key_iv,
      new_salt
    } = parsedBody.data;

    const { userRepository } = options.container;
    const user = await userRepository.findByEmail(email);

    if (!user || !user.recovery_key_hash) {
      return reply.status(404).send({ error: 'Recovery not available' });
    }

    const { verifyPassword, hashPassword } = await import('../crypto/serverCrypto.js');
    const isValid = await verifyPassword(recovery_code, user.recovery_key_hash);

    if (!isValid) {
      return reply.status(401).send({ error: 'Invalid recovery code' });
    }

    const newPasswordHash = await hashPassword(new_password);
    await userRepository.updateSecurityParams(email, {
      password_hash: newPasswordHash,
      encrypted_master_key: new_encrypted_master_key,
      master_key_iv: new_master_key_iv,
      salt: new_salt
    });

    return reply.send({ message: 'Recovery successful. Password updated.' });
  });

}
