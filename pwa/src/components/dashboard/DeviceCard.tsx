'use client';

import { useId } from 'react';
import { dateTime, plural, relativeTime } from '@/lib/format';
import { groupByWindow, openSafe, safeUrls, type DecryptedSnapshot } from '@/lib/snapshots';
import { useDashboardActions } from './actions';
import { TabList } from './TabRow';
import styles from './dashboard.module.css';

/** Opens every http(s) tab of a snapshot here. Browsers may block all but the first popup. */
export function openAll(urls: string[]): void {
  urls.slice(0, 50).forEach(u => openSafe(u));
}

export function SnapshotActions({
  snap,
  title,
  compact,
}: {
  snap: DecryptedSnapshot;
  title: string;
  compact?: boolean;
}) {
  const actions = useDashboardActions();
  const tabs = snap.tabs ?? [];
  return (
    <div className={styles.actionsRow}>
      <button
        type="button"
        className={styles.restoreBtn}
        onClick={() => actions.restoreSnapshot(snap.row, title)}
        disabled={tabs.length === 0}
      >
        ⟳ Restore to device…
      </button>
      <button
        type="button"
        className={styles.openAllBtn}
        onClick={() => openAll(safeUrls(tabs))}
        disabled={tabs.length === 0}
        title="Open every tab in this browser (your popup blocker may ask for permission)"
      >
        ↗ Open here
      </button>
      {!compact && !snap.row.pinned && (
        <button type="button" className={styles.openAllBtn} onClick={() => actions.saveSnapshot(snap)}>
          ★ Save
        </button>
      )}
      <button
        type="button"
        className={styles.openAllBtn}
        onClick={() =>
          actions.exportSnapshots([
            { title, deviceName: snap.row.device_name, capturedAt: snap.row.captured_at, tabs },
          ])
        }
        disabled={tabs.length === 0}
      >
        ⤓ Export
      </button>
    </div>
  );
}

interface Props {
  snap: DecryptedSnapshot;
  expanded: boolean;
  onToggle: () => void;
}

export function DeviceCard({ snap, expanded, onToggle }: Props) {
  const { openHistory } = useDashboardActions();
  const panelId = useId();
  const { row, tabs, error } = snap;
  const windows = tabs ? groupByWindow(tabs).length : 0;

  return (
    <section className={styles.deviceCard} aria-label={row.device_name}>
      <div className={styles.deviceHeaderRow}>
        <button
          type="button"
          className={styles.deviceHeader}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
        >
          <span className={styles.deviceIcon} aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {error ? (
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              ) : (
                <>
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </>
              )}
            </svg>
          </span>
          <span className={styles.deviceText}>
            <span className={styles.deviceName}>{row.device_name}</span>
            <span className={styles.deviceMeta} title={dateTime(row.captured_at)}>
              {error
                ? error
                : `${plural(tabs?.length ?? 0, 'tab')} · ${plural(windows, 'window')} · synced ${relativeTime(row.captured_at)}`}
            </span>
          </span>
          {!error && <span className={styles.tabCount}>{tabs?.length ?? 0}</span>}
          <span className={styles.chevron} data-open={expanded} aria-hidden="true">
            ▾
          </span>
        </button>
        <button
          type="button"
          className={styles.historyBtn}
          onClick={() => openHistory(row.device_id, row.device_name)}
          title={`History of ${row.device_name}`}
          aria-label={`Open snapshot history of ${row.device_name}`}
        >
          ⏱
        </button>
      </div>

      {expanded && (
        <div id={panelId} className={styles.tabsContainer}>
          {error ? (
            <div className={styles.noTabs}>{error}</div>
          ) : (
            <>
              <SnapshotActions snap={snap} title={`${row.device_name} — ${dateTime(row.captured_at)}`} />
              <TabList tabs={tabs ?? []} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
