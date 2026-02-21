import { Snapshot } from './models.js';

export interface ISyncService {
    uploadSnapshot(userId: string, data: Omit<Snapshot, 'id' | 'created_at' | 'user_id'>): Promise<Snapshot>;
    getLatestSnapshots(userId: string): Promise<any[]>; // Matches frontend expectation
    getSnapshotHistory(userId: string, deviceId: string, limit: number): Promise<Snapshot[]>;
}
