import type { FastifyInstance } from 'fastify';
import { RESTORE_ERROR_CODES, type PendingRestoreResponse, type RestoreErrorCode } from '@vaulttabs/shared';
import { z } from 'zod';
import { HttpError, parseOrThrow } from '../errors.js';
import { uuid } from '../schemas.js';
import { isBase64OfLength } from '../crypto/serverCrypto.js';
import { idParam, type RouteDeps } from './common.js';

/** Encrypted "send tab" payloads: up to LIMITS.maxRestoreUrls URLs, base64 ciphertext. */
const MAX_PAYLOAD_CHARS = 1_000_000;
const PING_INTERVAL_MS = 20_000;
const MAX_STREAMS_PER_USER = 10;

const CreateBody = z
  .object({
    target_device_id: uuid,
    snapshot_id: uuid.optional(),
    encrypted_payload: z
      .string()
      .min(1)
      .max(MAX_PAYLOAD_CHARS, `encrypted_payload must be at most ${MAX_PAYLOAD_CHARS} characters`)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'encrypted_payload must be base64')
      .optional(),
    payload_iv: z
      .string()
      .refine(v => isBase64OfLength(v, 12), 'payload_iv must be base64 of 12 bytes')
      .optional(),
  })
  .refine(b => (b.encrypted_payload === undefined) === (b.payload_iv === undefined), {
    message: 'encrypted_payload and payload_iv must be sent together',
    path: ['encrypted_payload'],
  })
  .refine(b => (b.snapshot_id === undefined) !== (b.encrypted_payload === undefined), {
    message: 'send exactly one of snapshot_id or encrypted_payload + payload_iv',
    path: ['snapshot_id'],
  });

const DeviceQuery = z.object({ device_id: uuid });

const CompleteBody = z.object({
  status: z.enum(['completed', 'failed'], { error: "status must be 'completed' or 'failed'" }),
  // Unknown codes (newer/older clients) are stored as 'unknown'; free text is never stored.
  error_code: z.string().max(64).optional(),
});

function toErrorCode(code: string | undefined): RestoreErrorCode | null {
  if (code === undefined) return null;
  return (RESTORE_ERROR_CODES as readonly string[]).includes(code) ? (code as RestoreErrorCode) : 'unknown';
}

export async function restoreRoutes(
  fastify: FastifyInstance,
  { container, authenticate, isOriginAllowed }: RouteDeps,
) {
  const { restoreService, deviceService, restoreNotifier, userRepository: users } = container;

  const streamsPerUser = new Map<string, number>();
  const openStreams = new Set<() => void>();
  // End open SSE responses on shutdown so server.close() does not wait for them.
  fastify.addHook('preClose', async () => {
    for (const close of [...openStreams]) close();
  });

  fastify.post(
    '/restore',
    { preHandler: authenticate, bodyLimit: MAX_PAYLOAD_CHARS + 16 * 1024 },
    async (request, reply) => {
      const body = parseOrThrow(CreateBody, request.body);
      const content =
        body.snapshot_id !== undefined
          ? { snapshotId: body.snapshot_id.toLowerCase() }
          : { encryptedPayload: body.encrypted_payload!, payloadIv: body.payload_iv! };
      const result = await restoreService.create(
        request.user.userId,
        body.target_device_id.toLowerCase(),
        content,
      );
      restoreNotifier.publish(result.request_id, body.target_device_id.toLowerCase());
      return reply.status(201).send(result);
    },
  );

  fastify.get('/restore/pending', { preHandler: authenticate }, async request => {
    const { device_id } = parseOrThrow(DeviceQuery, request.query);
    return restoreService.pending(request.user.userId, device_id.toLowerCase());
  });

  fastify.get(
    '/restore/stream',
    { preHandler: authenticate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { userId, tokenVersion } = request.user;
      const deviceId = parseOrThrow(DeviceQuery, request.query).device_id.toLowerCase();
      await deviceService.assertOwned(userId, deviceId);

      const open = streamsPerUser.get(userId) ?? 0;
      if (open >= MAX_STREAMS_PER_USER) {
        throw new HttpError(429, 'Too many open restore streams for this account.', 'too_many_streams');
      }
      const initial = await restoreService.pendingUnchecked(userId, deviceId);

      streamsPerUser.set(userId, open + 1);
      reply.hijack();
      const res = reply.raw;
      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      };
      // The hijacked response bypasses @fastify/cors: echo the origin only if it is allowed.
      const origin = request.headers.origin;
      if (origin && isOriginAllowed(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
      }
      res.writeHead(200, headers);

      let closed = false;
      const send = (event: PendingRestoreResponse) => {
        if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // The token was checked when the stream opened. A revocation since then ("sign out
      // everywhere", password change, recovery, account deletion) must end the stream too, or a
      // signed-out browser would keep receiving (and opening) tabs. The client then reconnects,
      // gets 401 token_invalid and ends its session.
      const stillAuthorized = async () => {
        const state = await users.findTokenState(userId);
        if (state?.token_version === tokenVersion) return true;
        close();
        return false;
      };

      const ping = setInterval(() => {
        if (closed) return;
        stillAuthorized()
          .then(ok => {
            if (ok && !closed) res.write(': ping\n\n');
          })
          .catch((err: unknown) => request.log.warn({ err }, 'restore stream: token check failed'));
      }, PING_INTERVAL_MS);

      const unsubscribe = restoreNotifier.subscribe(deviceId, requestId => {
        stillAuthorized()
          .then(ok => (ok ? restoreService.pendingUnchecked(userId, deviceId) : null))
          .then(state => {
            if (state?.pending && state.request?.id === requestId) send(state);
          })
          .catch((err: unknown) => request.log.warn({ err }, 'restore stream: failed to load request'));
      });

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        openStreams.delete(close);
        const remaining = (streamsPerUser.get(userId) ?? 1) - 1;
        if (remaining > 0) streamsPerUser.set(userId, remaining);
        else streamsPerUser.delete(userId);
      };
      const close = () => {
        cleanup();
        res.end();
      };
      openStreams.add(close);
      res.on('close', cleanup);
      res.on('error', cleanup);

      send(initial);
    },
  );

  fastify.patch('/restore/:id', { preHandler: authenticate }, async request => {
    const id = idParam(request.params, 'Restore request');
    const body = parseOrThrow(CompleteBody, request.body);
    await restoreService.complete(request.user.userId, id, body.status, toErrorCode(body.error_code));
    return { message: `Restore request marked ${body.status}.` };
  });

  fastify.get('/restore/:id', { preHandler: authenticate }, async request => ({
    request: await restoreService.get(request.user.userId, idParam(request.params, 'Restore request')),
  }));
}
