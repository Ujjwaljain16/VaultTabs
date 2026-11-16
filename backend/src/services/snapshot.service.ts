import type { SnapshotHistoryResponse, SnapshotWithDevice, UploadSnapshotResponse } from '@vaulttabs/shared';
import { conflict, badRequest, notFound } from '../errors.js';
import type { DeviceService } from './device.service.js';
import type { NewSnapshot, SnapshotPatch, SnapshotRepository } from '../repositories/snapshot.repository.js';

export class SnapshotService {
  constructor(
    private readonly snapshots: SnapshotRepository,
    private readonly devices: DeviceService,
    private readonly maxSaved: number,
  ) {}

  async upload(userId: string, snapshot: NewSnapshot): Promise<UploadSnapshotResponse> {
    const row = await this.snapshots.insertAndPrune(userId, snapshot);
    if (!row) throw notFound('Device not found. Register this device again.', 'device_not_found');
    return { snapshot_id: row.id, captured_at: row.captured_at };
  }

  latest(userId: string): Promise<SnapshotWithDevice[]> {
    return this.snapshots.latest(userId);
  }

  async history(
    userId: string,
    deviceId: string | null,
    before: Date | null,
    limit: number,
  ): Promise<SnapshotHistoryResponse> {
    if (deviceId) await this.devices.assertOwned(userId, deviceId);
    const rows = await this.snapshots.history(userId, deviceId, before, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      snapshots: page,
      next_before: rows.length > limit && last ? new Date(last.captured_at).toISOString() : null,
    };
  }

  saved(userId: string): Promise<SnapshotWithDevice[]> {
    return this.snapshots.saved(userId);
  }

  async get(userId: string, id: string): Promise<SnapshotWithDevice> {
    const snapshot = await this.snapshots.findOwned(userId, id);
    if (!snapshot) throw notFound('Snapshot not found', 'snapshot_not_found');
    return snapshot;
  }

  async update(userId: string, id: string, patch: SnapshotPatch): Promise<SnapshotWithDevice> {
    const result = await this.snapshots.update(userId, id, patch, this.maxSaved);
    switch (result.kind) {
      case 'ok':
        return result.snapshot;
      case 'not_found':
        throw notFound('Snapshot not found', 'snapshot_not_found');
      case 'saved_limit':
        throw conflict(`You can keep at most ${this.maxSaved} saved sessions.`, 'saved_limit');
      case 'not_saved':
        throw badRequest('Only saved (pinned) sessions can have a label.', 'not_saved');
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!(await this.snapshots.deleteOwned(userId, id)))
      throw notFound('Snapshot not found', 'snapshot_not_found');
  }
}
