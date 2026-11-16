'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Device, SnapshotWithDevice, TabSnapshot } from '@vaulttabs/shared';
import { encryptLabel } from '@vaulttabs/shared/crypto';
import ui from '@/components/ui/ui.module.css';
import { AppHeader } from '@/components/vault/AppHeader';
import { useVault } from '@/components/vault/VaultProvider';
import { api, errorMessage } from '@/lib/api';
import type { ExportSource } from '@/lib/export';
import { dateTime, hostname, plural, relativeTime } from '@/lib/format';
import { decryptRows, type DecryptedSnapshot } from '@/lib/snapshots';
import { DashboardActionsProvider, type DashboardActions } from './actions';
import { DeviceCard } from './DeviceCard';
import { DevicePickerDialog, ExportDialog, LabelDialog, RestoreStatusDialog } from './Dialogs';
import { HistoryDrawer } from './HistoryDrawer';
import { SavedSessions } from './SavedSessions';
import { TabRow } from './TabRow';
import { useRestore, type RestoreTarget } from './useRestore';
import styles from './dashboard.module.css';

type View = 'devices' | 'saved';

function matches(tab: TabSnapshot, q: string): boolean {
  return (
    (tab.title || '').toLowerCase().includes(q) ||
    tab.url.toLowerCase().includes(q) ||
    hostname(tab.url).toLowerCase().includes(q)
  );
}

export function Dashboard() {
  const { key, userId, session } = useVault();
  const [view, setView] = useState<View>('devices');
  const [latest, setLatest] = useState<DecryptedSnapshot[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState<RestoreTarget | null>(null);
  const [saving, setSaving] = useState<DecryptedSnapshot | null>(null);
  const [exporting, setExporting] = useState<ExportSource[] | null>(null);
  const [history, setHistory] = useState<{ deviceId: string; deviceName: string } | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());
  const [savedReload, setSavedReload] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const restore = useRestore(key, userId);

  // ── Load latest snapshots + device list ───────────────────────────────────────────────────
  const load = useCallback(async () => {
    setRefreshing(true);
    setLoadError('');
    try {
      const [snaps, devs] = await Promise.allSettled([api.latestSnapshots(), api.listDevices()]);
      if (devs.status === 'fulfilled') setDevices(devs.value.devices);
      if (snaps.status === 'rejected') throw snaps.reason;
      const decrypted = await decryptRows(snaps.value.snapshots, key, userId);
      decrypted.sort((a, b) => new Date(b.row.captured_at).getTime() - new Date(a.row.captured_at).getTime());
      setLatest(decrypted);
      setExpanded(prev => prev ?? decrypted[0]?.row.device_id ?? null);
      setLastRefresh(new Date());
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load your tabs.'));
      setLatest(prev => prev ?? []);
    } finally {
      setRefreshing(false);
    }
  }, [key, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── "/" focuses search, Escape clears it ──────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setView('devices');
      searchRef.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── Actions shared with nested components ─────────────────────────────────────────────────
  const actions = useMemo<DashboardActions>(
    () => ({
      sendTab: (url, title) => setPicker({ kind: 'tab', url, title }),
      restoreSnapshot: (row: SnapshotWithDevice, title: string) =>
        setPicker({ kind: 'snapshot', snapshotId: row.id, title }),
      saveSnapshot: snap => setSaving(snap),
      exportSnapshots: sources => setExporting(sources),
      openHistory: (deviceId, deviceName) => setHistory({ deviceId, deviceName }),
    }),
    [],
  );

  async function saveSession(snap: DecryptedSnapshot, label: string) {
    const enc = await encryptLabel(label, key, userId, snap.row.id);
    try {
      await api.updateSnapshot(snap.row.id, {
        pinned: true,
        label_enc: enc.label_enc,
        label_iv: enc.label_iv,
      });
    } catch (err) {
      throw new Error(errorMessage(err, 'Could not save the session.'));
    }
    setPinnedIds(prev => new Set(prev).add(snap.row.id));
    setLatest(
      prev =>
        prev?.map(s => (s.row.id === snap.row.id ? { ...s, row: { ...s.row, pinned: true }, label } : s)) ??
        prev,
    );
    setSavedReload(n => n + 1);
  }

  // ── Search across all devices ─────────────────────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q || !latest) return null;
    return latest
      .filter(s => s.tabs)
      .map(s => ({ snap: s, tabs: (s.tabs ?? []).filter(t => matches(t, q)) }))
      .filter(r => r.tabs.length > 0);
  }, [q, latest]);
  const resultCount = results?.reduce((n, r) => n + r.tabs.length, 0) ?? 0;

  const totalTabs = latest?.reduce((n, s) => n + (s.tabs?.length ?? 0), 0) ?? 0;
  const newestSync = latest?.[0]?.row.captured_at ?? null;

  const exportAllLatest = () =>
    setExporting(
      (latest ?? [])
        .filter(s => s.tabs)
        .map(s => ({
          title: `${s.row.device_name} — ${dateTime(s.row.captured_at)}`,
          deviceName: s.row.device_name,
          capturedAt: s.row.captured_at,
          tabs: s.tabs ?? [],
        })),
    );

  const latestForHistory = history ? latest?.find(s => s.row.device_id === history.deviceId) : undefined;

  return (
    <DashboardActionsProvider value={actions}>
      <div className={ui.page}>
        <AppHeader
          actions={
            <>
              <button
                type="button"
                className={ui.iconBtn}
                onClick={exportAllLatest}
                disabled={!latest || totalTabs === 0}
                title="Export the latest tabs of every device"
                aria-label="Export tabs"
              >
                ⤓
              </button>
              <button
                type="button"
                className={ui.iconBtn}
                onClick={() => {
                  void load();
                  setSavedReload(n => n + 1);
                }}
                disabled={refreshing}
                title="Refresh"
                aria-label="Refresh"
              >
                <span className={refreshing ? styles.spinning : undefined} aria-hidden="true">
                  ↻
                </span>
              </button>
            </>
          }
        />

        <div className={styles.statsBar}>
          <div className={styles.stat}>
            <span className={styles.statValue}>{latest ? latest.length : '–'}</span>
            <span className={styles.statLabel}>devices</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{latest ? totalTabs : '–'}</span>
            <span className={styles.statLabel}>tabs</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValueSmall} title={dateTime(newestSync)}>
              {newestSync ? relativeTime(newestSync) : '–'}
            </span>
            <span className={styles.statLabel}>last sync</span>
          </div>
          <div className={styles.encBadge} title="Tab data is decrypted only in this browser">
            <span className={styles.encDot} aria-hidden="true" />
            E2EE
          </div>
        </div>

        <main className={ui.pageMain}>
          <div className={styles.toolbar}>
            <div className={styles.searchWrap}>
              <label htmlFor="global-search" className={ui.srOnly}>
                Search tabs on all devices
              </label>
              <span className={styles.searchIcon} aria-hidden="true">
                ⌕
              </span>
              <input
                ref={searchRef}
                id="global-search"
                type="search"
                className={styles.searchInput}
                placeholder="Search titles, URLs, sites…"
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  if (view !== 'devices') setView('devices');
                }}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    setQuery('');
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <kbd className={styles.kbd} aria-hidden="true">
                /
              </kbd>
            </div>
            <div className={styles.segmented} role="tablist" aria-label="View">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'devices'}
                className={styles.segment}
                onClick={() => setView('devices')}
              >
                Devices
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'saved'}
                className={styles.segment}
                onClick={() => {
                  setView('saved');
                  setQuery('');
                }}
              >
                Saved
              </button>
            </div>
          </div>

          {loadError && (
            <div className={ui.error} role="alert">
              {loadError}{' '}
              <button type="button" className={ui.btnGhost} onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}

          {view === 'saved' ? (
            <SavedSessions reloadToken={savedReload} onChanged={() => void load()} />
          ) : latest === null ? (
            <div className={styles.deviceList} aria-busy="true">
              {[1, 2, 3].map(i => (
                <div
                  key={i}
                  className={`${styles.deviceCard} ${styles.skeletonCard}`}
                  style={{ opacity: 1 - i * 0.2 }}
                >
                  <div className={styles.skeleton} style={{ width: '40%', height: 14 }} />
                  <div className={styles.skeleton} style={{ width: '70%', height: 10 }} />
                </div>
              ))}
            </div>
          ) : results ? (
            <section aria-label="Search results" className={styles.deviceList}>
              <p className={styles.resultsSummary} role="status" aria-live="polite">
                {resultCount === 0
                  ? `No tabs match “${query.trim()}”.`
                  : `${plural(resultCount, 'tab')} on ${plural(results.length, 'device')}`}
              </p>
              {results.map(r => (
                <div key={r.snap.row.id} className={styles.deviceCard}>
                  <div className={styles.resultsHeader}>
                    <span className={styles.deviceName}>{r.snap.row.device_name}</span>
                    <span className={styles.windowBadge}>{r.tabs.length}</span>
                  </div>
                  <ul className={styles.tabUl}>
                    {r.tabs.map((t, i) => (
                      <TabRow key={`${t.id}-${i}`} tab={t} query={q} showUrl />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ) : latest.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon} aria-hidden="true">
                ◈
              </div>
              <div className={styles.emptyTitle}>No snapshots yet</div>
              <div className={styles.emptyDesc}>
                Install the VaultTabs extension in a browser and sign in with this account (
                {session.user.email}). Your tabs appear here a few seconds later.
              </div>
            </div>
          ) : (
            <div className={styles.deviceList}>
              {latest.map(s => (
                <DeviceCard
                  key={s.row.device_id}
                  snap={s}
                  expanded={expanded === s.row.device_id}
                  onToggle={() => setExpanded(expanded === s.row.device_id ? null : s.row.device_id)}
                />
              ))}
              {lastRefresh && (
                <p className={styles.footNote}>
                  Updated {relativeTime(lastRefresh)} · pull fresh data with ↻
                </p>
              )}
            </div>
          )}
        </main>
      </div>

      {history && (
        <HistoryDrawer
          deviceId={history.deviceId}
          deviceName={history.deviceName}
          latest={latestForHistory}
          pinnedIds={pinnedIds}
          onClose={() => setHistory(null)}
        />
      )}
      {saving && (
        <LabelDialog
          title="Save session"
          description="Pinned snapshots are kept forever (never pruned by retention). The name is encrypted before upload."
          initial={`${saving.row.device_name} — ${dateTime(saving.row.captured_at)}`}
          submitLabel="Save"
          onSubmit={label => saveSession(saving, label)}
          onClose={() => setSaving(null)}
        />
      )}
      {exporting && <ExportDialog sources={exporting} onClose={() => setExporting(null)} />}
      {picker && (
        <DevicePickerDialog
          title={picker.kind === 'tab' ? 'Send tab to…' : 'Restore to…'}
          description={picker.title}
          devices={devices}
          onClose={() => setPicker(null)}
          onPick={d => {
            const target = picker;
            setPicker(null);
            void restore.start(target, d);
          }}
        />
      )}
      <RestoreStatusDialog state={restore.state} onClose={restore.reset} />
    </DashboardActionsProvider>
  );
}
