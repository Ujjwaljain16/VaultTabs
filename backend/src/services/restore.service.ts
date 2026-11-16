import type {
  CreateRestoreResponse,
  PendingRestoreResponse,
  RestoreErrorCode,
  RestoreRequest,
} from '@vaulttabs/shared';
import { conflict, notFound } from '../errors.js';
import type { RestoreContent, RestoreRepository } from '../repositories/restore.repository.js';
import type { SnapshotRepository } from '../repositories/snapshot.repository.js';
import type { DeviceService } from './device.service.js';

export class RestoreService {
  constructor(
    private readonly restores: RestoreRepository,
    private readonly snapshots: SnapshotRepository,
    private readonly devices: DeviceService,
  ) {}

  async create(
    userId: string,
    targetDeviceId: string,
    content: RestoreContent,
  ): Promise<CreateRestoreResponse> {
    await this.devices.assertOwned(userId, targetDeviceId);
    if ('snapshotId' in content && !(await this.snapshots.findOwned(userId, content.snapshotId))) {
      throw notFound('Snapshot not found', 'snapshot_not_found');
    }
    const request = await this.restores.create(userId, targetDeviceId, content);
    return { request_id: request.id, status: request.status, expires_at: request.expires_at };
  }

  /** Current pending request for one of the caller's devices (404 if the device is not theirs). */
  async pending(userId: string, deviceId: string): Promise<PendingRestoreResponse> {
    await this.devices.assertOwned(userId, deviceId);
    return this.pendingUnchecked(userId, deviceId);
  }

  /** As `pending`, for callers that already verified device ownership (the SSE stream). */
  async pendingUnchecked(userId: string, deviceId: string): Promise<PendingRestoreResponse> {
    const request = await this.restores.findPendingDetail(userId, deviceId);
    return request ? { pending: true, request } : { pending: false };
  }

  async complete(
    userId: string,
    id: string,
    status: 'completed' | 'failed',
    errorCode: RestoreErrorCode | null,
  ): Promise<void> {
    const result = await this.restores.complete(
      userId,
      id,
      status,
      status === 'failed' ? (errorCode ?? 'unknown') : null,
    );
    if (result === 'not_found') throw notFound('Restore request not found', 'restore_not_found');
    if (result === 'not_pending') throw conflict('This restore request is no longer pending.', 'not_pending');
  }

  async get(userId: string, id: string): Promise<RestoreRequest> {
    const request = await this.restores.findOwned(userId, id);
    if (!request) throw notFound('Restore request not found', 'restore_not_found');
    return request;
  }
}
