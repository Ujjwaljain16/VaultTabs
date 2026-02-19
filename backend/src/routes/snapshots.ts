/**
 * src/routes/snapshots.ts
 *
 * Snapshot routes — uploading and retrieving encrypted tab blobs.
 *
 * WHAT IS A SNAPSHOT?
 * A snapshot is a complete picture of all open tabs at a moment in time.
 * It's encrypted client-side before being sent here.
 * The server just stores the blob — it has no idea what's inside.
 *
 * ROUTES:
 * POST /snapshots           → Upload a new encrypted snapshot
 * GET  /snapshots/latest    → Get the latest snapshot per device (for mobile PWA)
 * GET  /snapshots/history   → Get recent snapshots for a specific device
 *
 * WHAT THE SERVER SEES:
 * - user_id (who sent it)
 * - device_id (which browser)
 * - captured_at (timestamp — when the client took the snapshot)
 * - iv (initialization vector — needed for AES-GCM decryption, not secret)
 * - encrypted_blob (the actual data — gibberish to the server)
 *
 * WHAT THE SERVER DOES NOT SEE:
 * - URLs
 * - Tab titles
 * - Number of tabs (blob size could hint at this, padding would fix it)
 * - Any browsing history
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import sql from '../db/client';
import { authenticate } from '../middleware/auth';

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

export async function snapshotRoutes(fastify: FastifyInstance) {

  // ── POST /snapshots ──────────────────────────────────────────────────────
  // Called by the extension every 15 seconds (or on tab change).
  // Stores the latest encrypted snapshot and prunes old ones.
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

    const { device_id, captured_at, iv, encrypted_blob } = parseResult.data;

    // Verify the device belongs to this user (prevents uploading to someone else's device)
    const [device] = await sql`
      SELECT id FROM devices
      WHERE id = ${device_id} AND user_id = ${userId}
      LIMIT 1
    `;

    if (!device) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'This device does not belong to your account.',
      });
    }

    // Insert the snapshot
    const [snapshot] = await sql`
      INSERT INTO snapshots (user_id, device_id, captured_at, iv, encrypted_blob)
      VALUES (${userId}, ${device_id}, ${captured_at}, ${iv}, ${encrypted_blob})
      RETURNING id, captured_at, created_at
    `;

    // Update device's last_seen timestamp
    await sql`
      UPDATE devices SET last_seen = NOW() WHERE id = ${device_id}
    `;

    // Prune old snapshots for this device — keep only the latest 10
    // This prevents the database from growing forever
    // In Phase 2, we'll add a proper history feature with explicit retention settings
    await sql`
      DELETE FROM snapshots
      WHERE device_id = ${device_id}
        AND id NOT IN (
          SELECT id FROM snapshots
          WHERE device_id = ${device_id}
          ORDER BY captured_at DESC
          LIMIT 10
        )
    `;

    return reply.status(201).send({
      message: 'Snapshot stored',
      snapshot_id: snapshot.id,
      captured_at: snapshot.captured_at,
    });
  });


  // ── GET /snapshots/latest ────────────────────────────────────────────────
  // Returns the most recent snapshot for each of the user's devices.
  // This is the main endpoint used by the mobile PWA.
  fastify.get('/snapshots/latest', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;

    // Get the latest snapshot per device using a DISTINCT ON query (PostgreSQL feature)
    // DISTINCT ON (device_id) keeps only one row per device — the most recent one
    const snapshots = await sql`
      SELECT DISTINCT ON (s.device_id)
        s.id,
        s.device_id,
        s.captured_at,
        s.iv,
        s.encrypted_blob,
        d.device_name,
        d.last_seen
      FROM snapshots s
      JOIN devices d ON d.id = s.device_id
      WHERE s.user_id = ${userId}
      ORDER BY s.device_id, s.captured_at DESC
    `;

    return reply.send({ snapshots });
  });


  // ── GET /snapshots/history?device_id=xxx&limit=20 ────────────────────────
  // Returns recent snapshots for a specific device.
  // Used for the timeline feature (Phase 2) but setting up the endpoint now.
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

    // Clamp limit between 1 and 50
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));

    // Verify device belongs to user
    const [device] = await sql`
      SELECT id FROM devices WHERE id = ${device_id} AND user_id = ${userId}
    `;

    if (!device) {
      return reply.status(403).send({ error: 'Device not found or access denied' });
    }

    const snapshots = await sql`
      SELECT id, device_id, captured_at, iv, encrypted_blob, created_at
      FROM snapshots
      WHERE device_id = ${device_id} AND user_id = ${userId}
      ORDER BY captured_at DESC
      LIMIT ${limitNum}
    `;

    return reply.send({ snapshots });
  });

}