import { IDeviceService } from '../interfaces/device.service.js';
import { IDeviceRepository } from '../interfaces/device.repository.js';
import { Device } from '../interfaces/models.js';

export class DeviceService implements IDeviceService {
    constructor(private deviceRepository: IDeviceRepository) { }

    async registerDevice(userId: string, name: string, fingerprint?: string, deviceId?: string): Promise<Device> {
        // 1. Try finding by deviceId first (most reliable)
        if (deviceId) {
            const existing = await this.deviceRepository.findByDeviceId(deviceId);
            if (existing && existing.user_id === userId) {
                return this.deviceRepository.upsert({
                    ...existing,
                    device_name: name,
                    last_seen: new Date(),
                });
            }
        }

        // 2. Try finding by fingerprint + name (robust identification for profiles on same machine)
        if (fingerprint) {
            const existing = await this.deviceRepository.findByFingerprint(userId, fingerprint);
            // Only reuse if the name ALSO matches, or if we don't have a name match elsewhere.
            // This prevents "hijacking" a different profile's device record.
            if (existing && existing.device_name === name) {
                return this.deviceRepository.upsert({
                    ...existing,
                    last_seen: new Date(),
                });
            }
        }

        // 3. Otherwise create new
        return this.deviceRepository.upsert({
            id: deviceId || crypto.randomUUID(),
            user_id: userId,
            device_name: name,
            fingerprint,
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
