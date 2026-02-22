'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { apiGetLatestSnapshots, apiCreateRestoreRequest, apiGetRestoreStatus } from '@/lib/api';
import { decryptSnapshot } from '@/lib/crypto';
import { loadSession, loadMasterKey, clearSession, clearMasterKey } from '@/lib/storage';
import type { DeviceSnapshot } from '@/types';
import type { TabSnapshot } from '@vaulttabs/shared';
import styles from './dashboard.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

type RestoreState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'waiting'; requestId: string; deviceName: string }
  | { phase: 'success'; tabCount: number; deviceName: string }
  | { phase: 'error'; message: string };

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState('');
  const [devices, setDevices] = useState<DeviceSnapshot[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [globalError, setGlobalError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestoreState>({ phase: 'idle' });
  const [devicePicker, setDevicePicker] = useState<{ url: string; snapshotId: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load + decrypt snapshots ───────────────────────────────────────────────
  const loadSnapshots = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoadState('loading');

    try {
      const session = loadSession();
      const masterKey = await loadMasterKey();

      if (!session || !masterKey) { router.replace('/login'); return; }

      setUserEmail(session.user_email);

      const result = await apiGetLatestSnapshots(session.jwt_token);
      if (!result.ok || !result.data) {
        setGlobalError(result.error || 'Failed to fetch snapshots');
        setLoadState('error');
        return;
      }

      const { snapshots } = result.data;

      if (snapshots.length === 0) {
        setDevices([]); setLoadState('ready');
        setLastRefresh(new Date()); return;
      }

      // Show loading placeholders immediately
      setDevices(snapshots.map(s => ({
        snapshotId: s.id,
        deviceId: s.device_id, deviceName: s.device_name,
        capturedAt: s.captured_at, lastSeen: s.last_seen,
        tabs: [], status: 'loading',
      })));
      setLoadState('ready');
      setExpandedDevice(prev => prev ?? snapshots[0].device_id);

      // Decrypt all in parallel
      const decrypted = await Promise.all(
        snapshots.map(async (snap): Promise<DeviceSnapshot> => {
          try {
            const tabs = await decryptSnapshot(snap.encrypted_blob, snap.iv, masterKey);
            return {
              snapshotId: snap.id,
              deviceId: snap.device_id, deviceName: snap.device_name,
              capturedAt: snap.captured_at, lastSeen: snap.last_seen, tabs, status: 'ready'
            };
          } catch (err) {
            return {
              snapshotId: snap.id,
              deviceId: snap.device_id, deviceName: snap.device_name,
              capturedAt: snap.captured_at, lastSeen: snap.last_seen, tabs: [], status: 'error',
              errorMsg: err instanceof Error ? err.message : 'Decryption failed'
            };
          }
        })
      );

      decrypted.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
      setDevices(decrypted);
      setLastRefresh(new Date());

    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : 'Unexpected error');
      setLoadState('error');
    } finally {
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  // Cleanup restore poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Restore to device ─────────────────────────────────────────────────────
  async function handleRestoreToDevice(targetDeviceId: string, targetDeviceName: string, snapshotId?: string, targetUrl?: string) {
    const session = loadSession();
    if (!session) { router.replace('/login'); return; }

    setRestore({ phase: 'sending' });

    const result = await apiCreateRestoreRequest(session.jwt_token, targetDeviceId, snapshotId, targetUrl);
    if (!result.ok || !result.data) {
      setRestore({ phase: 'error', message: result.error || 'Failed to send restore request' });
      return;
    }

    const requestId = result.data.request_id;
    setRestore({ phase: 'waiting', requestId, deviceName: targetDeviceName });

    // Poll for completion every 2 seconds (extension polls every 5s, so ~7s max wait)
    pollRef.current = setInterval(async () => {
      const pollSession = loadSession();
      if (!pollSession) { clearInterval(pollRef.current!); return; }

      const status = await apiGetRestoreStatus(pollSession.jwt_token, requestId);
      if (!status.ok || !status.data) return;

      const req = status.data.request;

      if (req.status === 'completed') {
        clearInterval(pollRef.current!);
        setRestore({ phase: 'success', tabCount: 0, deviceName: targetDeviceName });
        // Auto-reset after 6 seconds
        setTimeout(() => setRestore({ phase: 'idle' }), 6000);
      }

      if (req.status === 'failed') {
        clearInterval(pollRef.current!);
        setRestore({ phase: 'error', message: req.error_msg || 'Restore failed on desktop' });
      }

      if (req.status === 'expired') {
        clearInterval(pollRef.current!);
        setRestore({ phase: 'error', message: 'Request expired. Is the extension running on that browser?' });
      }
    }, 2000);

    // Timeout after 90 seconds
    setTimeout(() => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        setRestore(prev =>
          prev.phase === 'waiting'
            ? { phase: 'error', message: 'Timed out. Make sure the extension is open and online.' }
            : prev
        );
      }
    }, 90_000);
  }

  function cancelRestore() {
    if (pollRef.current) clearInterval(pollRef.current);
    setRestore({ phase: 'idle' });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function handleLogout() {
    clearSession(); await clearMasterKey(); router.replace('/login');
  }

  function openTab(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function formatRelativeTime(iso: string | Date): string {
    const d = iso instanceof Date ? iso : new Date(iso);
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function getHostname(url: string): string {
    try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
  }

  function totalTabs(devs: DeviceSnapshot[]) {
    return devs.reduce((sum, d) => sum + d.tabs.length, 0);
  }

  // ── Dashboard Shell ───────────────────────────────────────────────────────
  const renderHeader = () => (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="8" fill="#0f0f0f" />
          <path d="M16 6L8 10V16C8 20.4 11.6 24.5 16 26C20.4 24.5 24 20.4 24 16V10L16 6Z" fill="#39ff85" opacity="0.9" />
          <path d="M13 16L15 18L19 14" stroke="#080808" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className={styles.headerTitle}>VaultTabs</div>
      </div>
      <div className={styles.headerRight}>
        <button className={styles.refreshBtn} onClick={() => router.push('/devices')} title="Manage devices">⊟</button>
        <button className={styles.refreshBtn} onClick={() => loadSnapshots(true)} disabled={refreshing || loadState === 'loading'} title="Refresh">
          <span style={{ display: 'inline-block', animation: (refreshing || loadState === 'loading') ? 'spin 1s linear infinite' : 'none' }}>↻</span>
        </button>
        <button className={styles.logoutBtn} onClick={handleLogout} title="Logout">↩</button>
      </div>
    </header>
  );

  const renderStats = (isSkeleton = false) => (
    <div className={styles.statsBar}>
      <div className={styles.stat}>
        <span className={isSkeleton ? `${styles.statValue} ${styles.skeleton}` : styles.statValue} style={isSkeleton ? { width: '20px', height: '18px' } : {}}>
          {isSkeleton ? '' : devices.length}
        </span>
        <span className={styles.statLabel}>devices</span>
      </div>
      <div className={styles.statDivider} />
      <div className={styles.stat}>
        <span className={isSkeleton ? `${styles.statValue} ${styles.skeleton}` : styles.statValue} style={isSkeleton ? { width: '30px', height: '18px' } : {}}>
          {isSkeleton ? '' : totalTabs(devices)}
        </span>
        <span className={styles.statLabel}>total tabs</span>
      </div>
      <div className={styles.statDivider} />
      <div className={styles.stat}>
        <span className={isSkeleton ? `${styles.statValue} ${styles.skeleton}` : styles.statValue} style={isSkeleton ? { width: '40px', height: '18px', fontSize: '11px' } : { fontSize: '11px' }}>
          {isSkeleton ? '' : (lastRefresh ? formatRelativeTime(lastRefresh.toISOString()) : '—')}
        </span>
        <span className={styles.statLabel}>refreshed</span>
      </div>
      <div className={styles.encBadge}><span className={styles.encDot} />E2E</div>
    </div>
  );

  if (loadState === 'loading') {
    return (
      <div className={styles.root}>
        {renderHeader()}
        {renderStats(true)}
        <div className={styles.userRow}>
          <div className={`${styles.userEmail} ${styles.skeleton}`} style={{ width: '120px', height: '12px' }} />
        </div>
        <div className={styles.scroll}>
          <div className={styles.deviceList}>
            {[1, 2, 3].map(i => (
              <div key={i} className={styles.deviceCard} style={{ opacity: 1 - (i * 0.2) }}>
                <div className={styles.deviceHeader}>
                  <div className={styles.deviceLeft}>
                    <div className={`${styles.skeleton}`} style={{ width: '14px', height: '14px', borderRadius: '50%' }} />
                    <div style={{ flex: 1 }}>
                      <div className={`${styles.skeleton}`} style={{ width: '40%', height: '14px', marginBottom: '6px' }} />
                      <div className={`${styles.skeleton}`} style={{ width: '70%', height: '10px' }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className={styles.root}>
        {renderHeader()}
        <div className={styles.loadingScreen} style={{ height: 'auto', flex: 1 }}>
          <div className={styles.errorBox}>
            <div className={styles.errorTitle}>Connection failed</div>
            <div className={styles.errorMsg}>{globalError}</div>
            <button className={styles.retryBtn} onClick={() => loadSnapshots()}>↻ RETRY</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>

      {/* ── Device picker overlay for single tab restore ────────────── */}
      {devicePicker && (
        <div className={styles.restoreOverlay} onClick={() => setDevicePicker(null)}>
          <div className={styles.restoreCard} onClick={e => e.stopPropagation()}>
            <div className={styles.restoreTitle}>Restore Tab To...</div>
            <div className={styles.restoreDesc}>Select a device to open this tab on:</div>
            <div className={styles.pickerList}>
              {devices.map(d => (
                <button
                  key={d.deviceId}
                  className={styles.pickerItem}
                  onClick={() => {
                    handleRestoreToDevice(d.deviceId, d.deviceName, devicePicker.snapshotId, devicePicker.url);
                    setDevicePicker(null);
                  }}
                >
                  <span className={styles.pickerIcon}>◉</span>
                  <div className={styles.pickerName}>{d.deviceName}</div>
                </button>
              ))}
            </div>
            <button className={styles.restoreCancelBtn} onClick={() => setDevicePicker(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Restore overlay ─────────────────────────────────────────────── */}
      {restore.phase !== 'idle' && (
        <div className={styles.restoreOverlay}>
          <div className={styles.restoreCard}>

            {restore.phase === 'sending' && (
              <>
                <div className={styles.restoreSpinner} />
                <div className={styles.restoreTitle}>Sending request...</div>
                <div className={styles.restoreDesc}>Contacting the backend</div>
              </>
            )}

            {restore.phase === 'waiting' && (
              <>
                <div className={styles.restoreSpinner} />
                <div className={styles.restoreTitle}>Waiting for desktop</div>
                <div className={styles.restoreDesc}>
                  The extension on <strong>{restore.deviceName}</strong> will open your tabs shortly.
                  Make sure that browser is running.
                </div>
                <div className={styles.restorePulse}>
                  <span className={styles.restoreDot} />
                  <span className={styles.restoreDot} style={{ animationDelay: '0.3s' }} />
                  <span className={styles.restoreDot} style={{ animationDelay: '0.6s' }} />
                </div>
                <button className={styles.restoreCancelBtn} onClick={cancelRestore}>Cancel</button>
              </>
            )}

            {restore.phase === 'success' && (
              <>
                <div className={styles.restoreSuccessIcon}>✓</div>
                <div className={styles.restoreTitle}>Session restored!</div>
                <div className={styles.restoreDesc}>
                  Your tabs are now open on <strong>{restore.deviceName}</strong>.
                </div>
              </>
            )}

            {restore.phase === 'error' && (
              <>
                <div className={styles.restoreErrorIcon}>✕</div>
                <div className={styles.restoreTitle}>Restore failed</div>
                <div className={styles.restoreDesc}>{restore.message}</div>
                <button className={styles.restoreCancelBtn} onClick={cancelRestore}>Dismiss</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────── */}
      {renderHeader()}

      {/* ── Stats bar ───────────────────────────────────────────────────── */}
      {renderStats()}

      <div className={styles.userRow}>
        <span className={styles.userEmail}>{userEmail}</span>
      </div>

      {/* ── Device list ─────────────────────────────────────────────────── */}
      <div className={styles.scroll}>
        {devices.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>◈</div>
            <div className={styles.emptyTitle}>No snapshots yet</div>
            <div className={styles.emptyDesc}>Open a tab on your desktop browser. VaultTabs syncs within 3 seconds.</div>
          </div>
        ) : (
          <div className={styles.deviceList}>
            {devices.map(device => (
              <DeviceCard
                key={device.deviceId}
                device={device}
                allDevices={devices}
                expanded={expandedDevice === device.deviceId}
                onToggle={() => setExpandedDevice(expandedDevice === device.deviceId ? null : device.deviceId)}
                onOpenTab={openTab}
                onRestoreToDevice={(targetId, targetName, targetUrl) => handleRestoreToDevice(targetId, targetName, device.snapshotId, targetUrl)}
                onShowDevicePicker={(url) => setDevicePicker({ url, snapshotId: device.snapshotId })}
                formatRelativeTime={formatRelativeTime}
                getHostname={getHostname}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── DeviceCard ─────────────────────────────────────────────────────────────────

interface DeviceCardProps {
  device: DeviceSnapshot;
  allDevices: DeviceSnapshot[];
  expanded: boolean;
  onToggle: () => void;
  onOpenTab: (url: string) => void;
  onRestoreToDevice: (targetDeviceId: string, targetDeviceName: string, targetUrl?: string) => void;
  onShowDevicePicker: (url: string) => void;
  formatRelativeTime: (s: string | Date) => string;
  getHostname: (url: string) => string;
}

function DeviceCard({ device, allDevices, expanded, onToggle, onOpenTab, onRestoreToDevice, onShowDevicePicker, formatRelativeTime, getHostname }: DeviceCardProps) {
  const isLoading = device.status === 'loading';
  const isError = device.status === 'error';

  return (
    <div className={styles.deviceCard}>

      <button className={styles.deviceHeader} onClick={onToggle}>
        <div className={styles.deviceLeft}>
          <div className={styles.deviceIcon}>{isLoading ? '○' : isError ? '✕' : '◉'}</div>
          <div>
            <div className={styles.deviceName}>{device.deviceName}</div>
            <div className={styles.deviceMeta}>
              {isLoading ? 'decrypting...'
                : isError ? device.errorMsg
                  : `${device.tabs.length} tabs · ${formatRelativeTime(device.capturedAt)}`}
            </div>
          </div>
        </div>
        <div className={styles.deviceRight}>
          {!isLoading && !isError && <span className={styles.tabCount}>{device.tabs.length}</span>}
          <span className={styles.chevron} style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>↓</span>
        </div>
      </button>

      {expanded && !isLoading && !isError && (
        <div className={styles.tabsContainer}>

          {/* Action row — restore + open on phone */}
          <div className={styles.actionsRow}>
            <span style={{ fontSize: '11px', color: '#888', fontWeight: 600, letterSpacing: '0.5px', marginRight: '8px' }}>RESTORE TO:</span>
            {allDevices.map(targetDev => (
              <button
                key={targetDev.deviceId}
                className={styles.restoreBtn}
                onClick={(e) => { e.stopPropagation(); onRestoreToDevice(targetDev.deviceId, targetDev.deviceName); }}
                title={`Reopen all these tabs on ${targetDev.deviceName}`}
                style={{ marginRight: '8px', padding: '6px 12px' }}
              >
                ⟳ {targetDev.deviceId === device.deviceId ? 'THIS DEVICE' : targetDev.deviceName.toUpperCase()}
              </button>
            ))}

            <div style={{ flex: 1 }} />

            {/* SECONDARY: Open all on this phone */}
            <button
              className={styles.openAllBtn}
              onClick={(e) => {
                e.stopPropagation();
                device.tabs.forEach((tab, i) => setTimeout(() => window.open(tab.url, '_blank', 'noopener,noreferrer'), i * 100));
              }}
            >
              ↗ OPEN HERE
            </button>
          </div>

          {device.tabs.length === 0 ? (
            <div className={styles.noTabs}>No HTTP tabs in this snapshot</div>
          ) : (
            <div className={styles.tabRows}>
              {device.tabs.map((tab, i) => (
                <button key={i} className={`${styles.tabRow} ${tab.active ? styles.tabRowActive : ''}`} onClick={() => onOpenTab(tab.url)}>
                  <div className={styles.favicon}>
                    {tab.favIconUrl
                      ? <img src={tab.favIconUrl} alt="" width={14} height={14} style={{ borderRadius: 2 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      : <span className={styles.faviconFallback}>○</span>
                    }
                  </div>
                  <div className={styles.tabInfo}>
                    <div className={styles.tabTitle}>{tab.title || 'Untitled'}</div>
                    <div className={styles.tabUrl}>{getHostname(tab.url)}</div>
                  </div>
                  <div className={styles.tabMeta}>
                    {tab.active && <span className={styles.activeDot} />}
                    {tab.pinned && <span className={styles.pinnedIcon}>◆</span>}
                    {/* Simple restore button - restores to the same device as the snapshot by default */}
                    <div className={styles.tabActions}>
                      <button
                        className={styles.miniRestoreBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          onShowDevicePicker(tab.url);
                        }}
                        title="Restore this tab only"
                      >
                        ⟳
                      </button>
                      <span className={styles.openIcon}>↗</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}