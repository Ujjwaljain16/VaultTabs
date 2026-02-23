import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Container } from '../container.js';
import { authenticate } from '../middleware/auth.js';

export async function restoreRoutes(fastify: FastifyInstance, options: { container: Container }) {
  const { restoreService } = options.container;

  fastify.post<{
    Body: { target_device_id: string; snapshot_id?: string; target_url?: string }
  }>('/restore', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;

    const schema = z.object({
      source_device_id: z.string().uuid().optional(),
      target_device_id: z.string().uuid(),
      snapshot_id: z.string().uuid().optional(),
      target_url: z.string().url().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const { source_device_id, target_device_id, snapshot_id, target_url } = parsed.data;

    try {
      const req = await restoreService.createRequest(userId, target_device_id, snapshot_id, source_device_id, target_url);

      return reply.status(201).send({
        message: 'Restore request created',
        request_id: req.id,
        status: req.status,
        expires_at: req.expires_at,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      return reply.status(400).send({ error: msg });
    }
  });

  fastify.get<{
    Querystring: { device_id: string }
  }>('/restore/stream', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { device_id } = request.query;

    if (!device_id) {
      return reply.status(400).send({ error: 'device_id query param required' });
    }

    // Set headers for Server-Sent Events (SSE)
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.flushHeaders();

    // Initial Check
    try {
      const initialPending = await restoreService.getPendingWithSnapshot(userId, device_id);
      if (initialPending) {
        const payload = {
          pending: true,
          request: {
            id: initialPending.id,
            snapshot_id: initialPending.snapshot_id,
            snapshot_iv: initialPending.snapshot_iv,
            encrypted_blob: initialPending.encrypted_blob,
            target_url: initialPending.target_url,
            created_at: initialPending.created_at,
            expires_at: initialPending.expires_at,
          }
        };
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    } catch (err) {
      request.log.error(err, '[SSE Initialize Error]');
      reply.raw.end();
      return;
    }

    // Heartbeat
    const interval = setInterval(() => {
      reply.raw.write(': heartbeat\n\n'); // SSE comment
    }, 20000);

    const eventName = `restore:${device_id}`;
    const onRestoreRequest = async (req: any) => {
      try {
        const pending = await restoreService.getPendingWithSnapshot(userId, device_id);
        if (pending && pending.id === req.id) {
          const payload = {
            pending: true,
            request: {
              id: pending.id,
              snapshot_id: pending.snapshot_id,
              snapshot_iv: pending.snapshot_iv,
              encrypted_blob: pending.encrypted_blob,
              target_url: pending.target_url,
              created_at: pending.created_at,
              expires_at: pending.expires_at,
            }
          };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch (err) {
        request.log.error(err, '[SSE Event Handler Error]');
      }
    };

    restoreService.events.on(eventName, onRestoreRequest);

    request.raw.on('close', () => {
      clearInterval(interval);
      restoreService.events.off(eventName, onRestoreRequest);
    });

    return new Promise((resolve) => {
      request.raw.on('close', () => resolve(undefined));
    });
  });

  fastify.get<{
    Querystring: { device_id: string }
  }>('/restore/pending', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { device_id } = request.query;

    if (!device_id) {
      return reply.status(400).send({ error: 'device_id query param required' });
    }

    const pending = await restoreService.getPendingWithSnapshot(userId, device_id);

    if (!pending) {
      return reply.send({ pending: false });
    }

    return reply.send({
      pending: true,
      request: {
        id: pending.id,
        snapshot_id: pending.snapshot_id,
        snapshot_iv: pending.snapshot_iv,
        encrypted_blob: pending.encrypted_blob,
        target_url: pending.target_url,
        created_at: pending.created_at,
        expires_at: pending.expires_at,
      },
    });
  });

  fastify.patch<{
    Params: { id: string };
    Body: { status: 'completed' | 'failed'; error_msg?: string };
  }>('/restore/:id', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params;

    const schema = z.object({
      status: z.enum(['completed', 'failed']),
      error_msg: z.string().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed' });
    }

    const { status, error_msg } = parsed.data;

    try {
      await restoreService.completeRequest(userId, id, status, error_msg);
      return reply.send({
        message: `Restore request ${status}`,
        request_id: id,
        status,
      });
    } catch (err) {
      return reply.status(404).send({ error: 'Request not found' });
    }
  });

  fastify.get<{ Params: { id: string } }>('/restore/:id', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { id } = request.params;

    try {
      const req = await restoreService.getRequestStatus(userId, id);
      return reply.send({ request: req });
    } catch (err) {
      return reply.status(404).send({ error: 'Restore request not found' });
    }
  });

}
