import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LIMITS } from '@vaulttabs/shared';
import { SNAPSHOT_ENC_CURRENT } from '@vaulttabs/shared/crypto';
import { z } from 'zod';
import { isBase64OfLength } from '../crypto/serverCrypto.js';
import { badRequest, parseOrThrow } from '../errors.js';
import type { SnapshotPatch } from '../repositories/snapshot.repository.js';
import { uuid } from '../schemas.js';
import { idParam, type RouteDeps } from './common.js';

const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
const MAX_LABEL_ENC_CHARS = 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const iv12 = (name: string) =>
  z.string().refine(v => isBase64OfLength(v, 12), `${name} must be base64 of 12 bytes`);

const UploadBody = z.object({
  device_id: uuid,
  captured_at: z.iso.datetime({ offset: true, error: 'captured_at must be an ISO 8601 timestamp' }),
  iv: iv12('iv'),
  encrypted_blob: z
    .string()
    .min(1, 'encrypted_blob is required')
    .max(
      LIMITS.maxSnapshotBlobChars,
      `encrypted_blob must be at most ${LIMITS.maxSnapshotBlobChars} characters`,
    )
    .regex(BASE64_RE, 'encrypted_blob must be base64'),
  enc_version: z.literal(SNAPSHOT_ENC_CURRENT),
});

const HistoryQuery = z.object({
  device_id: uuid.optional(),
  limit: z.coerce.number().int().catch(20).optional(),
  before: z.iso.datetime({ offset: true, error: 'before must be an ISO 8601 timestamp' }).optional(),
});

const PatchBody = z
  .object({
    pinned: z.boolean().optional(),
    label_enc: z
      .string()
      .min(1)
      .max(MAX_LABEL_ENC_CHARS, `label_enc must be at most ${MAX_LABEL_ENC_CHARS} characters`)
      .regex(BASE64_RE, 'label_enc must be base64')
      .nullable()
      .optional(),
    label_iv: iv12('label_iv').nullable().optional(),
  })
  .refine(b => (b.label_enc === undefined) === (b.label_iv === undefined), {
    message: 'label_enc and label_iv must be sent together',
    path: ['label_enc'],
  })
  .refine(b => (b.label_enc === null) === (b.label_iv === null), {
    message: 'label_enc and label_iv must both be null to clear the label',
    path: ['label_enc'],
  });

export async function snapshotRoutes(fastify: FastifyInstance, { container, authenticate }: RouteDeps) {
  const { snapshotService } = container;

  fastify.post(
    '/snapshots',
    {
      preHandler: authenticate,
      // Base64 blob + JSON overhead.
      bodyLimit: LIMITS.maxSnapshotBlobChars + 64 * 1024,
      config: {
        // Per user, after authentication (several browsers may share one IP).
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          hook: 'preHandler',
          keyGenerator: (request: FastifyRequest) => `snapshots:${request.user?.userId ?? request.ip}`,
        },
      },
    },
    async (request, reply) => {
      const raw = request.body as { enc_version?: unknown } | null | undefined;
      if (raw && typeof raw === 'object' && raw.enc_version !== SNAPSHOT_ENC_CURRENT) {
        throw badRequest(
          'This snapshot format (enc_version 1) is no longer accepted. Please update your VaultTabs extension.',
          'unsupported_enc_version',
        );
      }
      const body = parseOrThrow(UploadBody, request.body);
      const capturedAt = new Date(body.captured_at);
      if (capturedAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
        throw badRequest('captured_at is in the future. Check the device clock.', 'captured_at_in_future');
      }
      const result = await snapshotService.upload(request.user.userId, {
        device_id: body.device_id.toLowerCase(),
        captured_at: capturedAt,
        iv: body.iv,
        encrypted_blob: body.encrypted_blob,
        enc_version: body.enc_version,
      });
      return reply.status(201).send(result);
    },
  );

  fastify.get('/snapshots/latest', { preHandler: authenticate }, async request => ({
    snapshots: await snapshotService.latest(request.user.userId),
  }));

  fastify.get('/snapshots/history', { preHandler: authenticate }, async request => {
    const query = parseOrThrow(HistoryQuery, request.query);
    const limit = Math.min(LIMITS.maxHistoryPage, Math.max(1, query.limit ?? 20));
    return snapshotService.history(
      request.user.userId,
      query.device_id?.toLowerCase() ?? null,
      query.before ? new Date(query.before) : null,
      limit,
    );
  });

  fastify.get('/snapshots/saved', { preHandler: authenticate }, async request => ({
    snapshots: await snapshotService.saved(request.user.userId),
  }));

  fastify.get('/snapshots/:id', { preHandler: authenticate }, async request => ({
    snapshot: await snapshotService.get(request.user.userId, idParam(request.params, 'Snapshot')),
  }));

  fastify.patch('/snapshots/:id', { preHandler: authenticate }, async request => {
    const id = idParam(request.params, 'Snapshot');
    const body = parseOrThrow(PatchBody, request.body);
    const patch: SnapshotPatch = { pinned: body.pinned };
    if (body.label_enc !== undefined && body.label_iv !== undefined) {
      patch.label =
        body.label_enc === null || body.label_iv === null
          ? null
          : { label_enc: body.label_enc, label_iv: body.label_iv };
    }
    return { snapshot: await snapshotService.update(request.user.userId, id, patch) };
  });

  fastify.delete('/snapshots/:id', { preHandler: authenticate }, async request => {
    await snapshotService.remove(request.user.userId, idParam(request.params, 'Snapshot'));
    return { message: 'Snapshot deleted.' };
  });
}
