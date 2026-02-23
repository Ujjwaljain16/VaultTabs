'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiGetAccountDevices, apiDeleteDevice, apiRenameDevice, type AccountDevice } from '@/lib/api';
import { loadSession } from '@/lib/storage';
import styles from './devices.module.css';

export default function DevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError('');
    const session = loadSession();
    if (!session) { router.replace('/login'); return; }
    const result = await apiGetAccountDevices(session.jwt_token);
    if (!result.ok || !result.data) { setError(result.error || 'Failed to load devices'); }
    else { setDevices(result.data.devices); }
    setLoading(false);
  }

  async function handleDelete(deviceId: string) {
    if (confirmId !== deviceId) { setConfirmId(deviceId); return; }

    const originalDevices = [...devices];
    setDevices(prev => prev.filter(d => d.id !== deviceId));
    setConfirmId(null);
    setDeletingId(deviceId);

    const session = loadSession();
    if (!session) return;

    const result = await apiDeleteDevice(session.jwt_token, deviceId);
    if (!result.ok) {
      setError(result.error || 'Failed to delete device');
      setDevices(originalDevices);
    }
    setDeletingId(null);
  }

  async function handleRename(deviceId: string) {
    if (!renameValue.trim()) return;
    const session = loadSession();
    if (!session) return;

    const originalDevices = [...devices];
    const newName = renameValue.trim();
    setDevices(prev => prev.map(d =>
      d.id === deviceId ? { ...d, device_name: newName } : d
    ));
    setRenamingId(null);
    setRenameValue('');

    const result = await apiRenameDevice(session.jwt_token, deviceId, newName);
    if (!result.ok) {
      setError(result.error || 'Failed to rename device');
      setDevices(originalDevices);
    }
  }

  function formatRelative(iso: string | Date) {
    const d = iso instanceof Date ? iso : new Date(iso);
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => router.push('/dashboard')}>← Back</button>
        <h1 className={styles.title}>Devices</h1>
        <button className={styles.refreshBtn} onClick={load}>↻</button>
      </header>

      <div className={styles.hint}>
        Remove old devices from development or browsers you no longer use.
        Deleting a device also deletes all its snapshots.
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <div className={styles.loading}>Loading devices...</div>
      ) : devices.length === 0 ? (
        <div className={styles.empty}>No devices found</div>
      ) : (
        <div className={styles.list}>
          {devices.map(device => (
            <div key={device.id} className={styles.card}>

              {renamingId === device.id ? (
                <div className={styles.renameRow}>
                  <input
                    className={styles.renameInput}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleRename(device.id)}
                    autoFocus
                    placeholder="Device name"
                  />
                  <button className={styles.saveBtn} onClick={() => handleRename(device.id)}>Save</button>
                  <button className={styles.cancelBtn} onClick={() => { setRenamingId(null); setRenameValue(''); }}>Cancel</button>
                </div>
              ) : (
                <div className={styles.deviceInfo}>
                  <div className={styles.deviceName}>{device.device_name}</div>
                  <div className={styles.deviceMeta}>
                    Last seen {formatRelative(device.last_seen)} · {device.snapshot_count} snapshots
                  </div>
                </div>
              )}

              {renamingId !== device.id && (
                <div className={styles.actions}>
                  <button
                    className={styles.renameBtn}
                    onClick={() => { setRenamingId(device.id); setRenameValue(device.device_name); setConfirmId(null); }}
                  >
                    Rename
                  </button>

                  {confirmId === device.id ? (
                    <button
                      className={styles.confirmDeleteBtn}
                      onClick={() => handleDelete(device.id)}
                      disabled={deletingId === device.id}
                    >
                      {deletingId === device.id ? 'Deleting...' : 'Confirm delete'}
                    </button>
                  ) : (
                    <button
                      className={styles.deleteBtn}
                      onClick={() => handleDelete(device.id)}
                      disabled={deletingId === device.id}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}