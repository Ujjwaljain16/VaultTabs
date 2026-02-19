/**
 * src/routes/devices.ts
 *
 * Device management routes.
 *
 * WHAT IS A DEVICE?
 * Each browser where you install the extension is a "device".
 * - "MacBook Chrome"
 * - "Work Firefox"
 * - "Desktop Brave"
 *
 * When the extension first runs after login, it registers itself as a device.
 * It gets back a deviceId, which it stores locally and sends with every snapshot.
 *
 * ROUTES:
 * POST /devices/register  → Register this browser as a device, get deviceId
 * GET  /devices           → List all your registered devices (for the mobile PWA)
 * DELETE /devices/:id     → Remove a device (if you uninstall the extension)
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import sql from '../db/client';
import { authenticate } from '../middleware/auth';

// Validation schema for device registration
const RegisterDeviceSchema = z.object({
  device_name: z.string()
    .min(1, 'device_name is required')
    .max(100, 'device_name must be under 100 characters'),
});

type RegisterDeviceBody = z.infer<typeof RegisterDeviceSchema>;

export async function deviceRoutes(fastify: FastifyInstance) {

  // ── POST /devices/register ───────────────────────────────────────────────
  // Called once by the extension after first login.
  // Returns a deviceId the extension stores and uses forever (until reinstall).
  fastify.post<{ Body: RegisterDeviceBody }>('/devices/register', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;

    // Validate input
    const parseResult = RegisterDeviceSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { device_name } = parseResult.data;

    // Insert the device
    const [device] = await sql`
      INSERT INTO devices (user_id, device_name, last_seen)
      VALUES (${userId}, ${device_name}, NOW())
      RETURNING id, device_name, last_seen, created_at
    `;

    return reply.status(201).send({
      message: 'Device registered',
      device: {
        id: device.id,
        device_name: device.device_name,
        last_seen: device.last_seen,
        created_at: device.created_at,
      },
    });
  });


  // ── GET /devices ─────────────────────────────────────────────────────────
  // List all devices for the logged-in user.
  // Used by the mobile PWA to show "which device has which tabs".
  fastify.get('/devices', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;

    const devices = await sql`
      SELECT id, device_name, last_seen, created_at
      FROM devices
      WHERE user_id = ${userId}
      ORDER BY last_seen DESC
    `;

    return reply.send({ devices });
  });


  // ── PATCH /devices/:id/heartbeat ─────────────────────────────────────────
  // Called by the extension periodically to update "last_seen".
  // This lets the mobile app show "last active 2 minutes ago".
  fastify.patch<{ Params: { id: string } }>('/devices/:id/heartbeat', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { id: deviceId } = request.params;

    // Update last_seen, but only if this device belongs to the logged-in user
    const [updated] = await sql`
      UPDATE devices
      SET last_seen = NOW()
      WHERE id = ${deviceId} AND user_id = ${userId}
      RETURNING id, last_seen
    `;

    if (!updated) {
      return reply.status(404).send({ error: 'Device not found' });
    }

    return reply.send({ message: 'Heartbeat received', last_seen: updated.last_seen });
  });


  // ── DELETE /devices/:id ──────────────────────────────────────────────────
  // Remove a device (and all its snapshots, due to CASCADE in the DB schema).
  fastify.delete<{ Params: { id: string } }>('/devices/:id', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { id: deviceId } = request.params;

    const result = await sql`
      DELETE FROM devices
      WHERE id = ${deviceId} AND user_id = ${userId}
      RETURNING id
    `;

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Device not found' });
    }

    return reply.send({ message: 'Device removed' });
  });

}