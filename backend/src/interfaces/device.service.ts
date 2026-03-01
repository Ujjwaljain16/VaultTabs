// Interface for device management operations

import { Device } from './models.js';

export interface IDeviceService {
    registerDevice(userId: string, name: string, fingerprint?: string): Promise<Device>;
    listDevices(userId: string): Promise<Device[]>;
    updateDeviceName(userId: string, deviceId: string, name: string): Promise<Device>;
    deleteDevice(userId: string, deviceId: string): Promise<void>;
    heartbeat(userId: string, deviceId: string): Promise<void>;
}
