import fs from 'node:fs';
import { STATE_DIR } from './support/env';
import {
  buildAll,
  logFile,
  resetDatabase,
  startBackend,
  startPwa,
  startSite,
  stopAll,
} from './support/servers';

export default async function globalSetup(): Promise<() => Promise<void>> {
  stopAll(); // leftovers from an interrupted run
  buildAll();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const name of ['backend', 'pwa']) fs.rmSync(logFile(name), { force: true });

  await resetDatabase();
  const site = await startSite();
  try {
    await startBackend();
    await startPwa();
  } catch (err) {
    stopAll();
    site.close();
    throw err;
  }

  return async () => {
    stopAll();
    await new Promise<void>(resolve => site.close(() => resolve()));
  };
}
