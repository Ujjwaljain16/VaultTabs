'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LIMITS } from '@vaulttabs/shared';
import { ConfirmDialog } from '@/components/dashboard/Dialogs';
import ui from '@/components/ui/ui.module.css';
import { AppHeader } from '@/components/vault/AppHeader';
import { api, errorMessage, type AccountDevice } from '@/lib/api';
import { dateTime, plural, relativeTime } from '@/lib/format';
import styles from './devices.module.css';

export default function DevicesPage() {
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const [error, setError] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AccountDevice | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.accountDevices();
      setDevices(
        [...res.devices].sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime()),
      );
    } catch (err) {
      setError(errorMessage(err, 'Could not load devices.'));
      setDevices(prev => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rename(e: FormEvent, device: AccountDevice) {
    e.preventDefault();
    const name = renameValue.trim();
    if (!name || name === device.device_name) {
      setRenamingId(null);
      return;
    }
    setBusyId(device.id);
    setError('');
    try {
      const res = await api.renameDevice(device.id, name);
      setDevices(
        prev =>
          prev?.map(d => (d.id === device.id ? { ...d, device_name: res.device.device_name } : d)) ?? prev,
      );
      setRenamingId(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not rename the device.'));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(device: AccountDevice) {
    try {
      await api.deleteAccountDevice(device.id);
    } catch (err) {
      throw new Error(errorMessage(err, 'Could not delete the device.'));
    }
    setDevices(prev => prev?.filter(d => d.id !== device.id) ?? prev);
  }

  return (
    <div className={ui.page}>
      <AppHeader
        actions={
          <button
            type="button"
            className={ui.iconBtn}
            onClick={() => void load()}
            aria-label="Refresh devices"
            title="Refresh"
          >
            ↻
          </button>
        }
      />
      <main className={ui.pageMain}>
        <h1 className={ui.cardTitle}>Devices</h1>
        <p className={ui.hint}>
          Every browser where the extension is signed in. Device names, timestamps and snapshot counts are
          visible to the server; tab contents are not. Deleting a device deletes all of its snapshots,
          including saved sessions. A browser that is still signed in will re-register on its next sync.
        </p>
        {error && (
          <div className={ui.error} role="alert">
            {error}
          </div>
        )}
        {devices === null ? (
          <div
            className={ui.spinner}
            style={{ margin: '40px auto' }}
            role="status"
            aria-label="Loading devices"
          />
        ) : devices.length === 0 ? (
          <p className={ui.hint}>No devices yet. Install the extension and sign in to start syncing.</p>
        ) : (
          <ul className={styles.list}>
            {devices.map(d => (
              <li key={d.id} className={styles.card}>
                {renamingId === d.id ? (
                  <form className={styles.renameForm} onSubmit={e => rename(e, d)}>
                    <label htmlFor={`rename-${d.id}`} className={ui.srOnly}>
                      New name for {d.device_name}
                    </label>
                    <input
                      id={`rename-${d.id}`}
                      className={ui.input}
                      value={renameValue}
                      maxLength={LIMITS.maxDeviceNameChars}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => e.key === 'Escape' && setRenamingId(null)}
                      autoFocus
                      disabled={busyId === d.id}
                    />
                    <button type="submit" className={ui.btnPrimary} disabled={busyId === d.id}>
                      Save
                    </button>
                    <button type="button" className={ui.btnGhost} onClick={() => setRenamingId(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className={styles.info}>
                      <div className={styles.name}>{d.device_name}</div>
                      <div className={styles.meta}>
                        Last seen {relativeTime(d.last_seen)} · {plural(d.snapshot_count, 'snapshot')}
                        <br />
                        Last snapshot {d.last_snapshot_at ? dateTime(d.last_snapshot_at) : 'never'} · added{' '}
                        {dateTime(d.created_at)}
                      </div>
                    </div>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={ui.btnSecondary}
                        onClick={() => {
                          setRenamingId(d.id);
                          setRenameValue(d.device_name);
                        }}
                        aria-label={`Rename ${d.device_name}`}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className={ui.btnDanger}
                        onClick={() => setConfirmDelete(d)}
                        aria-label={`Delete ${d.device_name}`}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${confirmDelete.device_name}”?`}
          message={`This permanently deletes the device and its ${plural(confirmDelete.snapshot_count, 'snapshot')} (including saved sessions) from the server. This cannot be undone.`}
          confirmLabel="Delete device"
          danger
          onConfirm={() => remove(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
