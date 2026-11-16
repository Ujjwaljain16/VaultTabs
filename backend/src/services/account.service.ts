import type { AccountDevice, AccountInfoResponse } from '@vaulttabs/shared';
import { unauthorized } from '../errors.js';
import type { DeviceRepository } from '../repositories/device.repository.js';
import type { SnapshotRepository } from '../repositories/snapshot.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import { toPublicUser } from '../types.js';

export class AccountService {
  constructor(
    private readonly users: UserRepository,
    private readonly devices: DeviceRepository,
    private readonly snapshots: SnapshotRepository,
  ) {}

  async info(userId: string): Promise<AccountInfoResponse> {
    const [user, stats] = await Promise.all([this.users.findById(userId), this.users.getStats(userId)]);
    if (!user) throw unauthorized('Your session has ended. Please log in again.', 'token_invalid');
    return { account: toPublicUser(user), stats };
  }

  /** Set snapshots-per-device retention and apply it right away (saved sessions are kept). */
  async setRetention(userId: string, retention: number): Promise<void> {
    await this.users.updateRetention(userId, retention);
    await this.snapshots.pruneUser(userId);
  }

  devicesWithStats(userId: string): Promise<AccountDevice[]> {
    return this.devices.listWithStats(userId);
  }
}
