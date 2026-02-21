import { RestoreRequest } from './models.js';

export interface IRestoreRepository {
    findById(id: string): Promise<RestoreRequest | undefined>;
    findPendingByTargetDevice(targetDeviceId: string): Promise<RestoreRequest | undefined>;
    findPendingByTargetDeviceWithSnapshot(userId: string, targetDeviceId: string): Promise<any | undefined>;
    create(request: Omit<RestoreRequest, 'id' | 'created_at' | 'status'>): Promise<RestoreRequest>;
    updateStatus(id: string, status: RestoreRequest['status'], errorMsg?: string): Promise<void>;
    expireExistingPending(targetDeviceId: string): Promise<void>;
}
