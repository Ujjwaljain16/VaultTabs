import { Device } from './models.js';

export interface IDeviceRepository {
    findByUserId(userId: string): Promise<Device[]>;
    findByDeviceId(deviceId: string): Promise<Device | undefined>;
    getDevicesWithStats(userId: string): Promise<any[]>;
    upsert(device: Omit<Device, 'created_at'>): Promise<Device>;
    delete(deviceId: string): Promise<void>;
}
