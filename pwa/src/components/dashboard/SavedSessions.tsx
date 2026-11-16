'use client';

import { useCallback, useEffect, useState } from 'react';
import { LIMITS } from '@vaulttabs/shared';
import { encryptLabel } from '@vaulttabs/shared/crypto';
import ui from '@/components/ui/ui.module.css';
import { useVault } from '@/components/vault/VaultProvider';
import { api, errorMessage } from '@/lib/api';
import { dateTime, plural } from '@/lib/format';
import { decryptRows, type DecryptedSnapshot } from '@/lib/snapshots';
import { useDashboardActions } from './actions';
import { SnapshotActions } from './DeviceCard';
import { ConfirmDialog, LabelDialog } from './Dialogs';
import { TabList } from './TabRow';
import styles from './dashboard.module.css';

export function sessionTitle(s: DecryptedSnapshot): string {
  return s.label || `${s.row.device_name} — ${dateTime(s.row.captured_at)}`;
}

/** Saved sessions (pinned snapshots): rename, unpin, delete, restore, open, export. */
export function SavedSessions({ reloadToken, onChanged }: { reloadToken: number; onChanged: () => void }) {
  const { key, userId } = useVault();
  const { exportSnapshots } = useDashboardActions();
  const [items, setItems] = useState<DecryptedSnapshot[] | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<DecryptedSnapshot | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'unpin' | 'delete'; item: DecryptedSnapshot } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.savedSnapshots();
      const rows = await decryptRows(res.snapshots, key, userId);
      rows.sort((a, b) => new Date(b.row.captured_at).getTime() - new Date(a.row.captured_at).getTime());
      setItems(rows);
    } catch (err) {
      setError(errorMessage(err, 'Could not load saved sessions.'));
      setItems(prev => prev ?? []);
    }
  }, [key, userId]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  async function rename(item: DecryptedSnapshot, label: string) {
    const enc = await encryptLabel(label, key, userId, item.row.id);
    await api.updateSnapshot(item.row.id, { label_enc: enc.label_enc, label_iv: enc.label_iv });
    setItems(prev => prev?.map(i => (i.row.id === item.row.id ? { ...i, label } : i)) ?? prev);
  }

  async function unpin(item: DecryptedSnapshot) {
    await api.updateSnapshot(item.row.id, { pinned: false, label_enc: null, label_iv: null });
    setItems(prev => prev?.filter(i => i.row.id !== item.row.id) ?? prev);
    onChanged();
  }

  async function remove(item: DecryptedSnapshot) {
    await api.deleteSnapshot(item.row.id);
    setItems(prev => prev?.filter(i => i.row.id !== item.row.id) ?? prev);
    onChanged();
  }

  if (items === null) {
    return (
      <div
        className={ui.spinner}
        style={{ margin: '40px auto' }}
        role="status"
        aria-label="Loading saved sessions"
      />
    );
  }

  return (
    <div className={styles.deviceList}>
      {error && (
        <div className={ui.error} role="alert">
          {error}{' '}
          <button type="button" className={ui.btnGhost} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {items.length > 0 && (
        <div className={styles.sectionBar}>
          <span>{plural(items.length, 'saved session')}</span>
          <button
            type="button"
            className={styles.openAllBtn}
            onClick={() =>
              exportSnapshots(
                items
                  .filter(i => i.tabs)
                  .map(i => ({
                    title: sessionTitle(i),
                    deviceName: i.row.device_name,
                    capturedAt: i.row.captured_at,
                    tabs: i.tabs ?? [],
                  })),
              )
            }
          >
            ⤓ Export all
          </button>
        </div>
      )}
      {items.length === 0 && !error && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon} aria-hidden="true">
            ★
          </div>
          <div className={styles.emptyTitle}>No saved sessions</div>
          <div className={styles.emptyDesc}>
            Use “★ Save” on any device or past snapshot to keep it forever (retention never deletes saved
            sessions). Up to {LIMITS.maxSavedSessions}.
          </div>
        </div>
      )}
      {items.map(item => {
        const title = sessionTitle(item);
        const open = expanded === item.row.id;
        return (
          <section key={item.row.id} className={styles.deviceCard} aria-label={title}>
            <div className={styles.deviceHeaderRow}>
              <button
                type="button"
                className={styles.deviceHeader}
                onClick={() => setExpanded(open ? null : item.row.id)}
                aria-expanded={open}
              >
                <span className={styles.deviceIcon} aria-hidden="true">
                  ★
                </span>
                <span className={styles.deviceText}>
                  <span className={styles.deviceName}>{title}</span>
                  <span className={styles.deviceMeta}>
                    {item.error ??
                      `${plural(item.tabs?.length ?? 0, 'tab')} · ${item.row.device_name} · ${dateTime(item.row.captured_at)}`}
                  </span>
                </span>
                <span className={styles.chevron} data-open={open} aria-hidden="true">
                  ▾
                </span>
              </button>
            </div>
            {open && (
              <div className={styles.tabsContainer}>
                <div className={styles.actionsRow}>
                  <button type="button" className={styles.openAllBtn} onClick={() => setRenaming(item)}>
                    ✎ Rename
                  </button>
                  <button
                    type="button"
                    className={styles.openAllBtn}
                    onClick={() => setConfirm({ kind: 'unpin', item })}
                  >
                    ☆ Unpin
                  </button>
                  <button
                    type="button"
                    className={`${styles.openAllBtn} ${styles.dangerText}`}
                    onClick={() => setConfirm({ kind: 'delete', item })}
                  >
                    ✕ Delete
                  </button>
                </div>
                {item.error ? (
                  <div className={styles.noTabs}>{item.error}</div>
                ) : (
                  <>
                    <SnapshotActions snap={item} title={title} compact />
                    <TabList tabs={item.tabs ?? []} />
                  </>
                )}
              </div>
            )}
          </section>
        );
      })}

      {renaming && (
        <LabelDialog
          title="Rename saved session"
          initial={renaming.label ?? ''}
          submitLabel="Rename"
          onSubmit={label => rename(renaming, label)}
          onClose={() => setRenaming(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'unpin' ? 'Unpin saved session?' : 'Delete saved session?'}
          message={
            confirm.kind === 'unpin'
              ? 'It goes back to normal history and may be pruned by your retention setting.'
              : 'This snapshot is permanently deleted from the server. This cannot be undone.'
          }
          confirmLabel={confirm.kind === 'unpin' ? 'Unpin' : 'Delete'}
          danger={confirm.kind === 'delete'}
          onConfirm={() => (confirm.kind === 'unpin' ? unpin(confirm.item) : remove(confirm.item))}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
