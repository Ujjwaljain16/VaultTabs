// Interface for snapshot repository operations

import { Snapshot } from './models.js';

export interface ISnapshotRepository {
    findLatestByUserId(userId: string): Promise<Snapshot[]>;
    findByDeviceId(deviceId: string): Promise<Snapshot | undefined>;
    findById(id: string): Promise<Snapshot | undefined>;
    getRecentByDevice(deviceId: string, limit: number): Promise<Snapshot[]>;
    create(snapshot: Omit<Snapshot, 'id' | 'created_at'>): Promise<Snapshot>;
    deleteOldSnapshots(deviceId: string, keepCount: number): Promise<void>;
}
