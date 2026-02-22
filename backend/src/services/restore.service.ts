import { IRestoreService } from '../interfaces/restore.service.js';
import { IRestoreRepository } from '../interfaces/restore.repository.js';
import { ISnapshotRepository } from '../interfaces/snapshot.repository.js';
import { RestoreRequest } from '../interfaces/models.js';
import { EventEmitter } from 'events';

export class RestoreService implements IRestoreService {
    public events: EventEmitter;

    constructor(
        private restoreRepository: IRestoreRepository,
        private snapshotRepository: ISnapshotRepository
    ) {
        this.events = new EventEmitter();
        // Increase max listeners since many devices might connect
        this.events.setMaxListeners(100);
    }

    async createRequest(userId: string, targetDeviceId: string, snapshotId?: string, sourceDeviceId?: string, targetUrl?: string): Promise<RestoreRequest> {
        // 1. Get snapshot (latest if not specified)
        let snapshot;
        if (snapshotId) {
            snapshot = await this.snapshotRepository.findById(snapshotId);
        } else {
            snapshot = await this.snapshotRepository.findByDeviceId(targetDeviceId);
        }

        if (!snapshot || snapshot.user_id !== userId) {
            throw new Error('No snapshots found');
        }

        // 2. Expire old requests
        await this.restoreRepository.expireExistingPending(targetDeviceId);

        // 3. Create request
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 5);

        const request = await this.restoreRepository.create({
            user_id: userId,
            source_device_id: snapshot.device_id, // The device that captured the snapshot
            target_device_id: targetDeviceId,     // The device receiving the restore
            snapshot_id: snapshot.id,
            target_url: targetUrl,
            expires_at: expiresAt,
        });

        // Emit an event to any connected SSE listeners for this specific device
        this.events.emit(`restore:${targetDeviceId}`, request);

        return request;
    }

    async getPendingWithSnapshot(userId: string, targetDeviceId: string): Promise<any | undefined> {
        return this.restoreRepository.findPendingByTargetDeviceWithSnapshot(userId, targetDeviceId);
    }

    async getPendingRequest(userId: string, targetDeviceId: string): Promise<RestoreRequest | undefined> {
        const request = await this.restoreRepository.findPendingByTargetDevice(targetDeviceId);
        if (!request) return undefined;

        // Check ownership (optional but good)
        return request;
    }

    async completeRequest(userId: string, requestId: string, status: 'completed' | 'failed', errorMsg?: string): Promise<void> {
        await this.restoreRepository.updateStatus(requestId, status, errorMsg);
    }

    async getRequestStatus(userId: string, requestId: string): Promise<RestoreRequest> {
        const request = await this.restoreRepository.findById(requestId);
        if (!request) {
            throw new Error('Restore request not found');
        }
        return request;
    }
}
