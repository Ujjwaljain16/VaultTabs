import { LIMITS } from '@vaulttabs/shared';
import type { Config } from './config.js';
import type { Sql } from './db/client.js';
import type { Logger } from './logger.js';
import { DeviceRepository } from './repositories/device.repository.js';
import { RestoreRepository } from './repositories/restore.repository.js';
import { SnapshotRepository } from './repositories/snapshot.repository.js';
import { UserRepository } from './repositories/user.repository.js';
import { AccountService } from './services/account.service.js';
import { AuthService, type SignToken } from './services/auth.service.js';
import { DeviceService } from './services/device.service.js';
import { RestoreNotifier } from './services/restore.notifier.js';
import { RestoreService } from './services/restore.service.js';
import { SnapshotService } from './services/snapshot.service.js';

export function createContainer(deps: { config: Config; sql: Sql; signToken: SignToken; log: Logger }) {
  const { config, sql, signToken, log } = deps;

  const userRepository = new UserRepository(sql);
  const deviceRepository = new DeviceRepository(sql);
  const snapshotRepository = new SnapshotRepository(sql);
  const restoreRepository = new RestoreRepository(sql);

  const deviceService = new DeviceService(deviceRepository, config.maxDevicesPerUser);

  return {
    config,
    sql,
    userRepository,
    authService: new AuthService(userRepository, signToken, config.preloginSecret),
    deviceService,
    snapshotService: new SnapshotService(snapshotRepository, deviceService, LIMITS.maxSavedSessions),
    restoreService: new RestoreService(restoreRepository, snapshotRepository, deviceService),
    accountService: new AccountService(userRepository, deviceRepository, snapshotRepository),
    restoreNotifier: new RestoreNotifier(sql, log),
  };
}

export type Container = ReturnType<typeof createContainer>;
