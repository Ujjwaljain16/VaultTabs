'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LIMITS, type TabSnapshot } from '@vaulttabs/shared';
import { Dialog } from '@/components/ui/Dialog';
import ui from '@/components/ui/ui.module.css';
import { useVault } from '@/components/vault/VaultProvider';
import { api, errorMessage } from '@/lib/api';
import { dateTime, plural, relativeTime } from '@/lib/format';
import { decryptRows, diffTabs, type DecryptedSnapshot } from '@/lib/snapshots';
import { SnapshotActions } from './DeviceCard';
import { TabList } from './TabRow';
import styles from './dashboard.module.css';

const PAGE = Math.min(20, LIMITS.maxHistoryPage);

interface Props {
  deviceId: string;
  deviceName: string;
  /** The latest snapshot of this device, if already decrypted (baseline for diffs). */
  latest?: DecryptedSnapshot;
  /** Bumped by the dashboard when a snapshot was pinned elsewhere, so badges stay current. */
  pinnedIds: Set<string>;
  onClose: () => void;
}

/** Time travel: paginated history of one device with per-snapshot diff against the latest. */
export function HistoryDrawer({ deviceId, deviceName, latest, pinnedIds, onClose }: Props) {
  const { key, userId } = useVault();
  const [entries, setEntries] = useState<DecryptedSnapshot[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      setLoading(true);
      setError('');
      try {
        const res = await api.snapshotHistory(deviceId, { limit: PAGE, before });
        const decrypted = await decryptRows(res.snapshots, key, userId);
        setEntries(prev => {
          const seen = new Set(prev.map(e => e.row.id));
          return [...prev, ...decrypted.filter(d => !seen.has(d.row.id))];
        });
        setNextBefore(res.next_before);
      } catch (err) {
        setError(errorMessage(err, 'Could not load history.'));
      } finally {
        setLoading(false);
      }
    },
    [deviceId, key, userId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const baseline: TabSnapshot[] | null = latest?.tabs ?? entries[0]?.tabs ?? null;
  const baselineId = latest?.row.id ?? entries[0]?.row.id;
  const selected = entries.find(e => e.row.id === selectedId) ?? null;

  const selectedMarkers = useMemo(() => {
    if (!selected?.tabs || !baseline || selected.row.id === baselineId) return undefined;
    const { removed } = diffTabs(selected.tabs, baseline);
    const m = new Map<TabSnapshot, 'closed' | 'new'>();
    removed.forEach(t => m.set(t, 'closed'));
    return m;
  }, [selected, baseline, baselineId]);

  const isPinned = (e: DecryptedSnapshot) => e.row.pinned || pinnedIds.has(e.row.id);

  return (
    <Dialog
      variant="drawer"
      title={selected ? `${deviceName} · ${dateTime(selected.row.captured_at)}` : `History · ${deviceName}`}
      onClose={onClose}
    >
      {selected ? (
        <div className={styles.historyDetail}>
          <button
            type="button"
            className={ui.btnGhost}
            onClick={() => setSelectedId(null)}
            style={{ alignSelf: 'flex-start' }}
          >
            ← Back to timeline
          </button>
          {selected.error ? (
            <div className={ui.error}>{selected.error}</div>
          ) : (
            <>
              {selectedMarkers && (
                <p className={ui.hint}>
                  Tabs marked <span className={styles.badgeClosed}>closed since</span> are no longer open in
                  the latest snapshot.
                </p>
              )}
              <SnapshotActions
                snap={{ ...selected, row: { ...selected.row, pinned: isPinned(selected) } }}
                title={`${deviceName} — ${dateTime(selected.row.captured_at)}`}
              />
              <TabList tabs={selected.tabs ?? []} markers={selectedMarkers} />
            </>
          )}
        </div>
      ) : (
        <>
          <p className={ui.hint}>
            Past snapshots kept by your retention setting. Saved sessions are never pruned. Diffs compare each
            snapshot with the latest one.
          </p>
          {entries.length === 0 && !loading && !error && <div className={styles.noTabs}>No history yet.</div>}
          <ol className={styles.timeline}>
            {entries.map(e => {
              const diff = e.tabs && baseline && e.row.id !== baselineId ? diffTabs(e.tabs, baseline) : null;
              return (
                <li key={e.row.id} className={styles.timelineItem}>
                  <button
                    type="button"
                    className={styles.timelineBtn}
                    onClick={() => setSelectedId(e.row.id)}
                  >
                    <span className={styles.timelineDot} aria-hidden="true" />
                    <span className={styles.timelineText}>
                      <span className={styles.timelineTime}>
                        {dateTime(e.row.captured_at)}{' '}
                        <span className={styles.timelineAgo}>({relativeTime(e.row.captured_at)})</span>
                      </span>
                      <span className={styles.timelineMeta}>
                        {e.error ? (
                          'could not decrypt'
                        ) : (
                          <>
                            {plural(e.tabs?.length ?? 0, 'tab')}
                            {e.row.id === baselineId && <span className={styles.badgeNew}>latest</span>}
                            {diff && (diff.added.length > 0 || diff.removed.length > 0) && (
                              <span className={styles.diff} title="Change from this snapshot to the latest">
                                {' '}
                                since then: <span className={styles.diffAdd}>+{diff.added.length}</span>{' '}
                                <span className={styles.diffDel}>−{diff.removed.length}</span>
                              </span>
                            )}
                            {diff && diff.added.length === 0 && diff.removed.length === 0 && (
                              <span className={styles.diff}> same tabs as latest</span>
                            )}
                          </>
                        )}
                        {isPinned(e) && <span className={styles.badgeSaved}>saved</span>}
                      </span>
                    </span>
                    <span aria-hidden="true" className={styles.timelineChevron}>
                      ›
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {error && (
            <div className={ui.error} role="alert">
              {error}
            </div>
          )}
          {loading && (
            <div className={ui.spinner} style={{ margin: '8px auto' }} role="status" aria-label="Loading" />
          )}
          {!loading && nextBefore && (
            <button type="button" className={ui.btnSecondary} onClick={() => load(nextBefore)}>
              Load older snapshots
            </button>
          )}
        </>
      )}
    </Dialog>
  );
}
