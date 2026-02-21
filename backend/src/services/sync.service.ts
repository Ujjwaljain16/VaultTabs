import { ISyncService } from '../interfaces/sync.service.js';
import { ISnapshotRepository } from '../interfaces/snapshot.repository.js';
import { IDeviceRepository } from '../interfaces/device.repository.js';
import { Snapshot } from '../interfaces/models.js';
import { IUserRepository } from '../interfaces/user.repository.js';

export class SyncService implements ISyncService {
    constructor(
        private snapshotRepository: ISnapshotRepository,
        private deviceRepository: IDeviceRepository,
        private userRepository: IUserRepository
    ) { }

    async uploadSnapshot(userId: string, data: Omit<Snapshot, 'id' | 'created_at' | 'user_id'>): Promise<Snapshot> {
        // 1. Verify device belongs to user
        const device = await this.deviceRepository.findByDeviceId(data.device_id);
        if (!device || device.user_id !== userId) {
            throw new Error('This device does not belong to your account.');
        }

        // 2. Insert snapshot
        const snapshot = await this.snapshotRepository.create({
            ...data,
            user_id: userId,
        });

        // 3. Update device last_seen
        await this.deviceRepository.upsert({
            ...device,
            last_seen: new Date(),
        });

        // 4. Prune old snapshots based on user retention limit
        const user = await this.userRepository.findById(userId);
        const keepCount = user?.snapshot_retention || 50;
        await this.snapshotRepository.deleteOldSnapshots(data.device_id, keepCount);

        return snapshot;
    }

    async getLatestSnapshots(userId: string): Promise<any[]> {
        const snapshots = await this.snapshotRepository.findLatestByUserId(userId);

        const devices = await this.deviceRepository.findByUserId(userId);
        const deviceMap = new Map(devices.map(d => [d.id, d]));

        return snapshots.map(s => {
            const d = deviceMap.get(s.device_id);
            return {
                ...s,
                device_name: d?.device_name || 'Unknown',
                last_seen: d?.last_seen,
            };
        });
    }

    async getSnapshotHistory(userId: string, deviceId: string, limit: number): Promise<Snapshot[]> {
        const device = await this.deviceRepository.findByDeviceId(deviceId);
        if (!device || device.user_id !== userId) {
            throw new Error('Device not found or access denied');
        }

        return this.snapshotRepository.getRecentByDevice(deviceId, limit);
    }
}
