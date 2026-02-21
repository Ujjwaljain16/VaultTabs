import { IDeviceService } from '../interfaces/device.service.js';
import { IDeviceRepository } from '../interfaces/device.repository.js';
import { Device } from '../interfaces/models.js';

export class DeviceService implements IDeviceService {
    constructor(private deviceRepository: IDeviceRepository) { }

    async registerDevice(userId: string, name: string): Promise<Device> {
        return this.deviceRepository.upsert({
            id: crypto.randomUUID(),
            user_id: userId,
            device_name: name,
            last_seen: new Date(),
        });
    }

    async listDevices(userId: string): Promise<Device[]> {
        return this.deviceRepository.findByUserId(userId);
    }

    async updateDeviceName(userId: string, deviceId: string, name: string): Promise<Device> {
        const device = await this.deviceRepository.findByDeviceId(deviceId);
        if (!device || device.user_id !== userId) {
            throw new Error('Device not found or access denied');
        }

        return this.deviceRepository.upsert({
            ...device,
            device_name: name,
            last_seen: new Date(),
        });
    }

    async deleteDevice(userId: string, deviceId: string): Promise<void> {
        const device = await this.deviceRepository.findByDeviceId(deviceId);
        if (!device || device.user_id !== userId) {
            throw new Error('Device not found or access denied');
        }

        await this.deviceRepository.delete(deviceId);
    }

    async heartbeat(userId: string, deviceId: string): Promise<void> {
        const device = await this.deviceRepository.findByDeviceId(deviceId);
        if (!device || device.user_id !== userId) {
            // If device doesn't exist, we could auto-create it or throw.
            // Current routes expect it to exist if it was registered.
            return;
        }

        await this.deviceRepository.upsert({
            ...device,
            last_seen: new Date(),
        });
    }
}
