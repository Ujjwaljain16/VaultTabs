import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Container } from '../container.js';
import { authenticate } from '../middleware/auth.js';

export async function accountRoutes(fastify: FastifyInstance, options: { container: Container }) {
  const { accountService, deviceService } = options.container;

  // ── GET /account ───────────────────────────────────────────────────────────
  fastify.get('/account', { preHandler: [authenticate] }, async (request, reply) => {
    const { userId } = request.user;
    try {
      const info = await accountService.getAccountInfo(userId);
      return reply.send(info);
    } catch (err) {
      return reply.status(404).send({ error: 'User not found' });
    }
  });


  // ── PATCH /account/retention ───────────────────────────────────────────────
  fastify.patch('/account/retention', { preHandler: [authenticate] }, async (request, reply) => {
    const { userId } = request.user;

    const schema = z.object({
      retention: z.number().int().min(0).max(500),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'retention must be an integer between 0 and 500 (0 = unlimited)',
      });
    }

    const { retention } = parsed.data;
    await accountService.updateRetention(userId, retention);

    return reply.send({
      message: `Retention updated to ${retention === 0 ? 'unlimited' : retention + ' snapshots per device'}`,
      retention,
    });
  });


  // ── GET /account/devices ───────────────────────────────────────────────────
  fastify.get('/account/devices', { preHandler: [authenticate] }, async (request, reply) => {
    const { userId } = request.user;
    const devices = await accountService.listDevicesWithStats(userId);
    return reply.send({ devices });
  });


  // ── PATCH /account/devices/:id ─────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>(
    '/account/devices/:id', { preHandler: [authenticate] },
    async (request, reply) => {
      const { userId } = request.user;
      const { id } = request.params;

      const schema = z.object({
        device_name: z.string().min(1).max(100).trim(),
      });

      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'device_name is required (max 100 chars)' });
      }

      try {
        const updated = await deviceService.updateDeviceName(userId, id, parsed.data.device_name);
        return reply.send({ message: 'Device renamed', device: updated });
      } catch (err) {
        return reply.status(404).send({ error: 'Device not found' });
      }
    }
  );


  // ── DELETE /account/devices/:id ────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/account/devices/:id', { preHandler: [authenticate] },
    async (request, reply) => {
      const { userId } = request.user;
      const { id } = request.params;

      try {
        await deviceService.deleteDevice(userId, id);
        return reply.send({
          message: 'Device and all its snapshots have been deleted.',
        });
      } catch (err) {
        return reply.status(404).send({ error: 'Device not found' });
      }
    }
  );


  // ── DELETE /account ────────────────────────────────────────────────────────
  fastify.delete('/account', {
    preHandler: [authenticate],
    config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { userId } = request.user;

    const schema = z.object({
      password: z.string().min(1, 'Password confirmation required'),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Password confirmation required' });
    }

    try {
      await accountService.deleteAccount(userId, parsed.data.password);
      return reply.send({
        message: 'Account permanently deleted. All your data has been wiped from our servers.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      if (msg === 'Incorrect password') {
        return reply.status(401).send({ error: 'Incorrect password. Account not deleted.' });
      }
      return reply.status(404).send({ error: msg });
    }
  });

}
