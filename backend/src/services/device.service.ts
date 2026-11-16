import type { Device } from '@vaulttabs/shared';
import { conflict, notFound } from '../errors.js';
import type { DeviceRepository } from '../repositories/device.repository.js';
import { isUuid } from '../schemas.js';

export class DeviceService {
  constructor(
    private readonly devices: DeviceRepository,
    private readonly maxDevicesPerUser: number,
  ) {}

  /**
   * Re-register an existing device of the caller (refreshing name and last_seen), or create a new
   * one. A supplied `id` that does not exist or belongs to someone else is ignored: the new device
   * always gets a fresh server-generated id.
   */
  async register(userId: string, deviceName: string, id?: string): Promise<Device> {
    if (id && isUuid(id)) {
      const existing = await this.devices.touchOwned(userId, id, deviceName);
      if (existing) return existing;
    }
    const created = await this.devices.createWithinLimit(userId, deviceName, this.maxDevicesPerUser);
    if (!created) {
      throw conflict(
        `You have reached the limit of ${this.maxDevicesPerUser} devices. Remove an unused device first.`,
        'device_limit',
      );
    }
    return created;
  }

  list(userId: string): Promise<Device[]> {
    return this.devices.listByUser(userId);
  }

  async heartbeat(userId: string, id: string): Promise<void> {
    if (!(await this.devices.touchOwned(userId, id))) throw notFound('Device not found', 'device_not_found');
  }

  async rename(userId: string, id: string, deviceName: string): Promise<Device> {
    const device = await this.devices.rename(userId, id, deviceName);
    if (!device) throw notFound('Device not found', 'device_not_found');
    return device;
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!(await this.devices.deleteOwned(userId, id))) throw notFound('Device not found', 'device_not_found');
  }

  /** Throws 404 unless the device exists and is the caller's. */
  async assertOwned(userId: string, id: string): Promise<Device> {
    const device = await this.devices.findOwned(userId, id);
    if (!device) throw notFound('Device not found', 'device_not_found');
    return device;
  }
}
