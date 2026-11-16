'use client';

import { createContext, useContext } from 'react';
import type { SnapshotWithDevice } from '@vaulttabs/shared';
import type { ExportSource } from '@/lib/export';
import type { DecryptedSnapshot } from '@/lib/snapshots';

/** Cross-cutting dashboard actions, provided by <Dashboard> so nested components need no prop drilling. */
export interface DashboardActions {
  /** Pick a device, then send one URL to it (end-to-end encrypted payload). */
  sendTab: (url: string, title: string) => void;
  /** Pick a device, then ask it to reopen a whole snapshot. */
  restoreSnapshot: (row: SnapshotWithDevice, title: string) => void;
  /** Pin a snapshot as a saved session with an encrypted label. */
  saveSnapshot: (snap: DecryptedSnapshot) => void;
  /** Open the export dialog for these snapshots. */
  exportSnapshots: (sources: ExportSource[]) => void;
  /** Open the time-travel drawer for a device. */
  openHistory: (deviceId: string, deviceName: string) => void;
}

const noop = () => {};
const Ctx = createContext<DashboardActions>({
  sendTab: noop,
  restoreSnapshot: noop,
  saveSnapshot: noop,
  exportSnapshots: noop,
  openHistory: noop,
});

export const DashboardActionsProvider = Ctx.Provider;
export function useDashboardActions(): DashboardActions {
  return useContext(Ctx);
}
