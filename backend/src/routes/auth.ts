import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Container } from '../container.js';
import { authenticate } from '../middleware/auth.js';

const RegisterSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  encrypted_master_key: z.string().min(1, 'encrypted_master_key is required'),
  master_key_iv: z.string().min(1, 'master_key_iv is required'),
  salt: z.string().min(1, 'salt is required'),
  recovery_encrypted_master_key: z.string().optional(),
  recovery_key_iv: z.string().optional(),
  recovery_key_salt: z.string().optional(),
  recovery_key_hash: z.string().optional(),
});

const LoginSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type RegisterBody = z.infer<typeof RegisterSchema>;
type LoginBody = z.infer<typeof LoginSchema>;

export async function authRoutes(fastify: FastifyInstance, options: { container: Container }) {
  const { authService } = options.container;

  fastify.post<{ Body: RegisterBody }>('/auth/register', async (request, reply) => {
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
          has_recovery_key: !!(result.user as any).recovery_encrypted_master_key
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

  fastify.post<{ Body: LoginBody }>('/auth/login', async (request, reply) => {
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
    // ...
  });

  fastify.post<{ Body: { email: string } }>('/auth/recovery-material', async (request, reply) => {
    const { email } = request.body;
    if (!email) return reply.status(400).send({ error: 'Email required' });

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

  fastify.post<{
    Body: {
      email: string;
      recovery_code: string;
      new_password: string;
      new_encrypted_master_key: string;
      new_master_key_iv: string;
      new_salt: string;
    }
  }>('/auth/recover', async (request, reply) => {
    const {
      email,
      recovery_code,
      new_password,
      new_encrypted_master_key,
      new_master_key_iv,
      new_salt
    } = request.body;

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
