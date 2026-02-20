/**
 * src/routes/restore.ts
 *
 * Tab restore routes — lets the PWA trigger session restoration on a desktop.
 *
 * THE FLOW:
 *
 *   PWA (mobile)                  Backend              Extension (desktop)
 *      │                             │                        │
 *      │── POST /restore ──────────► │                        │
 *      │   {target_device_id,        │ Creates restore_request│
 *      │    snapshot_id}             │ status="pending"       │
 *      │                             │                        │
 *      │◄─ {request_id} ────────────│                        │
 *      │                             │                        │
 *      │   (polls every 3s)          │◄─ GET /restore/pending─┤
 *      │                             │   {device_id}          │
 *      │                             │── {request} ──────────►│
 *      │                             │                        │ (opens tabs)
 *      │                             │◄─ PATCH /restore/:id ──┤
 *      │                             │   status="completed"   │
 *      │                             │                        │
 *      │◄─ GET /restore/:id ─────────│                        │
 *      │   status="completed" ✓      │                        │
 *
 * ROUTES:
 *   POST  /restore              → PWA creates a restore request
 *   GET   /restore/pending      → Extension polls for pending requests
 *   PATCH /restore/:id          → Extension marks request completed/failed
 *   GET   /restore/:id          → PWA polls for request status
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import sql from '../db/client';
import { authenticate } from '../middleware/auth';

export async function restoreRoutes(fastify: FastifyInstance) {

  // ── POST /restore ────────────────────────────────────────────────────────
  // Called by PWA when user taps "Restore to Desktop"
  fastify.post<{
    Body: { target_device_id: string; snapshot_id?: string }
  }>('/restore', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;

    const schema = z.object({
      target_device_id: z.string().uuid(),
      snapshot_id:      z.string().uuid().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    const { target_device_id, snapshot_id } = parsed.data;

    // Verify device belongs to this user
    const [device] = await sql`
      SELECT id FROM devices WHERE id = ${target_device_id} AND user_id = ${userId}
    `;
    if (!device) {
      return reply.status(403).send({ error: 'Device not found or access denied' });
    }

    // If no snapshot_id given, find the latest snapshot for that device
    let resolvedSnapshotId = snapshot_id;
    if (!resolvedSnapshotId) {
      const [latest] = await sql`
        SELECT id FROM snapshots
        WHERE device_id = ${target_device_id} AND user_id = ${userId}
        ORDER BY captured_at DESC
        LIMIT 1
      `;
      if (!latest) {
        return reply.status(404).send({ error: 'No snapshots found for this device' });
      }
      resolvedSnapshotId = latest.id;
    }

    // Expire any existing pending requests for this device (only one at a time)
    await sql`
      UPDATE restore_requests
      SET status = 'expired', updated_at = NOW()
      WHERE target_device_id = ${target_device_id}
        AND status = 'pending'
    `;


    // Ensure resolvedSnapshotId is defined before using in query
    if (!resolvedSnapshotId) {
      return reply.status(400).send({ error: 'No snapshot_id could be resolved for this device.' });
    }

    // Create the new restore request
    const [req] = await sql`
      INSERT INTO restore_requests (user_id, target_device_id, snapshot_id)
      VALUES (${userId}, ${target_device_id}, ${resolvedSnapshotId})
      RETURNING id, status, created_at, expires_at
    `;

    return reply.status(201).send({
      message: 'Restore request created',
      request_id: req.id,
      status:     req.status,
      expires_at: req.expires_at,
    });
  });


  // ── GET /restore/pending ─────────────────────────────────────────────────
  // Called by the extension every 5 seconds.
  // Returns any pending restore request for this device.
  // Includes the encrypted snapshot so the extension can decrypt + restore locally.
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

    // Verify ownership
    const [device] = await sql`
      SELECT id FROM devices WHERE id = ${device_id} AND user_id = ${userId}
    `;
    if (!device) {
      return reply.status(403).send({ error: 'Device not found or access denied' });
    }

    // Find a pending, non-expired restore request for this device
    // Join with snapshots to get the encrypted blob the extension needs
    const [pending] = await sql`
      SELECT
        r.id,
        r.status,
        r.created_at,
        r.expires_at,
        s.id          AS snapshot_id,
        s.iv          AS snapshot_iv,
        s.encrypted_blob
      FROM restore_requests r
      JOIN snapshots s ON s.id = r.snapshot_id
      WHERE r.target_device_id = ${device_id}
        AND r.user_id          = ${userId}
        AND r.status           = 'pending'
        AND r.expires_at       > NOW()
      ORDER BY r.created_at DESC
      LIMIT 1
    `;

    if (!pending) {
      return reply.send({ pending: false });
    }

    return reply.send({
      pending: true,
      request: {
        id:             pending.id,
        snapshot_id:    pending.snapshot_id,
        snapshot_iv:    pending.snapshot_iv,
        encrypted_blob: pending.encrypted_blob,
        created_at:     pending.created_at,
        expires_at:     pending.expires_at,
      },
    });
  });


  // ── PATCH /restore/:id ───────────────────────────────────────────────────
  // Called by the extension after attempting to restore tabs.
  // Marks the request as completed or failed.
  fastify.patch<{
    Params: { id: string };
    Body:   { status: 'completed' | 'failed'; error_msg?: string };
  }>('/restore/:id', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { id }     = request.params;

    const schema = z.object({
      status:    z.enum(['completed', 'failed']),
      error_msg: z.string().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed' });
    }

    const { status, error_msg } = parsed.data;

    const [updated] = await sql`
      UPDATE restore_requests
      SET
        status     = ${status},
        error_msg  = ${error_msg ?? null},
        updated_at = NOW()
      WHERE id      = ${id}
        AND user_id = ${userId}
        AND status  = 'pending'
      RETURNING id, status, updated_at
    `;

    if (!updated) {
      return reply.status(404).send({ error: 'Request not found or already resolved' });
    }

    return reply.send({
      message: `Restore request ${status}`,
      request_id: updated.id,
      status:     updated.status,
    });
  });


  // ── GET /restore/:id ─────────────────────────────────────────────────────
  // Called by PWA to check if the extension completed the restore.
  fastify.get<{ Params: { id: string } }>('/restore/:id', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { id }     = request.params;

    const [req] = await sql`
      SELECT id, status, error_msg, created_at, updated_at, expires_at
      FROM restore_requests
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `;

    if (!req) {
      return reply.status(404).send({ error: 'Restore request not found' });
    }

    return reply.send({ request: req });
  });

}