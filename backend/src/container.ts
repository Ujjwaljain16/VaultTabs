import { PostgresUserRepository } from './repositories/postgresUser.repository.js';
import { PostgresDeviceRepository } from './repositories/postgresDevice.repository.js';
import { PostgresSnapshotRepository } from './repositories/postgresSnapshot.repository.js';
import { PostgresRestoreRepository } from './repositories/postgresRestore.repository.js';

import { AuthService } from './services/auth.service.js';
import { DeviceService } from './services/device.service.js';
import { SyncService } from './services/sync.service.js';
import { RestoreService } from './services/restore.service.js';
import { AccountService } from './services/account.service.js';

import { FastifyInstance } from 'fastify';

export function createContainer(fastify: FastifyInstance) {
    // Repositories
    const userRepository = new PostgresUserRepository();
    const deviceRepository = new PostgresDeviceRepository();
    const snapshotRepository = new PostgresSnapshotRepository();
    const restoreRepository = new PostgresRestoreRepository();

    // Services
    const authService = new AuthService(
        userRepository,
        process.env.JWT_SECRET as string,
        (payload, options) => fastify.jwt.sign(payload, options)
    );

    const deviceService = new DeviceService(deviceRepository);

    const syncService = new SyncService(snapshotRepository, deviceRepository, userRepository);

    const restoreService = new RestoreService(restoreRepository, snapshotRepository);

    const accountService = new AccountService(userRepository, deviceRepository, snapshotRepository);

    return {
        authService,
        deviceService,
        syncService,
        restoreService,
        accountService,
        userRepository,
    };
}

export type Container = ReturnType<typeof createContainer>;
