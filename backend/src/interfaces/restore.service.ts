import { RestoreRequest } from './models.js';
import { EventEmitter } from 'events';

export interface IRestoreService {
    events: EventEmitter;
    createRequest(userId: string, targetDeviceId: string, snapshotId?: string, sourceDeviceId?: string, targetUrl?: string): Promise<RestoreRequest>;
    getPendingWithSnapshot(userId: string, targetDeviceId: string): Promise<any | undefined>;
    getPendingRequest(userId: string, targetDeviceId: string): Promise<RestoreRequest | undefined>;
    completeRequest(userId: string, requestId: string, status: 'completed' | 'failed', errorMsg?: string): Promise<void>;
    getRequestStatus(userId: string, requestId: string): Promise<RestoreRequest>;
}
