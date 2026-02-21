import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Container } from '../container.js';
import { authenticate } from '../middleware/auth.js';

// Validation schema for snapshot upload
const UploadSnapshotSchema = z.object({
  device_id: z.string().uuid('device_id must be a valid UUID'),
  captured_at: z.string().datetime('captured_at must be an ISO datetime string'),
  iv: z.string().min(1, 'iv is required'),

  // The encrypted blob — stored as base64 string
  // We cap at 500KB to prevent abuse. A typical 200-tab snapshot is ~100KB.
  encrypted_blob: z.string().min(1).max(500_000, 'Snapshot blob too large (max 500KB)'),
});

type UploadSnapshotBody = z.infer<typeof UploadSnapshotSchema>;

export async function snapshotRoutes(fastify: FastifyInstance, options: { container: Container }) {
  const { syncService } = options.container;

  // ── POST /snapshots ──────────────────────────────────────────────────────
  fastify.post<{ Body: UploadSnapshotBody }>('/snapshots', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;

    // Validate input
    const parseResult = UploadSnapshotSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    try {
      const snapshot = await syncService.uploadSnapshot(userId, {
        ...parseResult.data,
        captured_at: new Date(parseResult.data.captured_at),
      });

      return reply.status(201).send({
        message: 'Snapshot stored',
        snapshot_id: snapshot.id,
        captured_at: snapshot.captured_at,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      if (msg === 'This device does not belong to your account.') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: msg,
        });
      }
      throw err;
    }
  });


  // ── GET /snapshots/latest ────────────────────────────────────────────────
  fastify.get('/snapshots/latest', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const snapshots = await syncService.getLatestSnapshots(userId);
    return reply.send({ snapshots });
  });


  // ── GET /snapshots/history?device_id=xxx&limit=20 ────────────────────────
  fastify.get<{
    Querystring: { device_id: string; limit?: string }
  }>('/snapshots/history', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { device_id, limit = '20' } = request.query;

    if (!device_id) {
      return reply.status(400).send({ error: 'device_id query param is required' });
    }

    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));

    try {
      const snapshots = await syncService.getSnapshotHistory(userId, device_id, limitNum);
      return reply.send({ snapshots });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch history';
      if (msg === 'Device not found or access denied') {
        return reply.status(403).send({ error: msg });
      }
      throw err;
    }
  });

}
