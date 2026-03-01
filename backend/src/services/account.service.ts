import { IAccountService } from '../interfaces/account.service.js';
import { IUserRepository } from '../interfaces/user.repository.js';
import { IDeviceRepository } from '../interfaces/device.repository.js';
import { ISnapshotRepository } from '../interfaces/snapshot.repository.js';
import { verifyPassword } from '../crypto/serverCrypto.js';

export class AccountService implements IAccountService {
    constructor(
        private userRepository: IUserRepository,
        private deviceRepository: IDeviceRepository,
        private snapshotRepository: ISnapshotRepository
    ) { }

    async getAccountInfo(userId: string): Promise<any> {
        const user = await this.userRepository.findById(userId);
        if (!user) throw new Error('User not found');

        const stats = await this.userRepository.getStats(userId);

        return {
            account: {
                id: user.id,
                email: user.email,
                snapshot_retention: (user as any).snapshot_retention,
                has_recovery_key: !!(user as any).recovery_key_hash,
                created_at: user.created_at,
            },
            stats: {
                device_count: parseInt(stats.device_count) || 0,
                snapshot_count: parseInt(stats.snapshot_count) || 0,
                last_sync_at: stats.last_sync_at,
            }
        };
    }

    async updateRetention(userId: string, retention: number): Promise<void> {
        await this.userRepository.updateRetention(userId, retention);

        if (retention > 0) {
            const devices = await this.deviceRepository.findByUserId(userId);
            for (const device of devices) {
                await this.snapshotRepository.deleteOldSnapshots(device.id, retention);
            }
        }
    }

    async deleteAccount(userId: string, passwordPlaintext: string): Promise<void> {
        const user = await this.userRepository.findById(userId);
        if (!user) throw new Error('User not found');

        const valid = await verifyPassword(passwordPlaintext, user.password_hash);
        if (!valid) throw new Error('Incorrect password');

        await this.userRepository.delete(userId);
    }

    async listDevicesWithStats(userId: string): Promise<any[]> {
        return this.deviceRepository.getDevicesWithStats(userId);
    }
}
