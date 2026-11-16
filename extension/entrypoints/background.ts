/**
 * Background script: uploads encrypted tab snapshots and executes restore requests.
 *
 * Sync: tab/window events mark the state dirty and (re)start a 3 s debounce timer; a periodic
 * alarm is the fallback for when the MV3 service worker was suspended mid-debounce. Uploads are
 * skipped when the normalized tab list hash equals the last uploaded one (persisted per
 * user+device, so a worker restart does not re-upload).
 *
 * Restore: an SSE stream (GET /restore/stream) delivers requests; reconnects use exponential
 * backoff with jitter plus an alarm, and GET /restore/pending is polled on (re)connect and by
 * the fallback alarm so nothing is missed while disconnected.
 */

import {
  LIMITS,
  type PendingRestoreDetail,
  type PendingRestoreResponse,
  type RestoreErrorCode,
  type TabSnapshot,
} from '@vaulttabs/shared';
import { decryptRestorePayload, decryptSnapshot, encryptSnapshot, sha256Hex } from '@vaulttabs/shared/crypto';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { api, ApiRequestError, errorMessage, defaultDeviceName } from '../utils/api';
import type { BackgroundBroadcast, SyncNowResponse } from '../utils/messages';
import { isPopupRequest } from '../utils/messages';
import { readSse } from '../utils/sse';
import {
  getActiveSession,
  loadState,
  migrateLegacyState,
  patchState,
  setDeviceId,
  type ActiveSession,
  type StateKey,
} from '../utils/storage';
import { normalizeForHash, openSnapshotWindows, openUrlsInNewWindow, syncableTabs } from '../utils/tabs';

const ALARM_FALLBACK = 'vaulttabs-fallback';
const ALARM_RECONNECT = 'vaulttabs-reconnect';
const DEBOUNCE_MS = 3_000;
const FALLBACK_MINUTES = 3;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
/** Chrome clamps alarm delays to >= 30 s. */
const MIN_ALARM_MINUTES = 0.5;

const log = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.warn('[VaultTabs]', ...args);
};

function broadcast(message: BackgroundBroadcast): void {
  // Rejects when no popup is open.
  browser.runtime.sendMessage(message).catch(() => {});
}

export default defineBackground({
  // Firefox (MV2): keep the page alive so the restore stream stays connected.
  persistent: true,
  main() {
    // ─── Sync ───────────────────────────────────────────────────────────────────────────────────

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let syncChain: Promise<void> = Promise.resolve();
    let queuedSync: Promise<void> | null = null;
    let queuedForce = false;

    function markDirty(): void {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void requestSync('debounce').catch(() => {}), DEBOUNCE_MS);
    }

    /**
     * Syncs run one at a time. Requests made while one is running coalesce into a single
     * follow-up run (forced if any of them asked for it).
     */
    function requestSync(trigger: string, force = false): Promise<void> {
      queuedForce ||= force;
      if (queuedSync) return queuedSync;
      const run = syncChain.then(() => {
        const f = queuedForce;
        queuedForce = false;
        queuedSync = null;
        return performSync(trigger, f);
      });
      queuedSync = run;
      syncChain = run.catch(() => {});
      return run;
    }

    async function performSync(trigger: string, force: boolean): Promise<void> {
      const session = await getActiveSession();
      if (!session) return;
      const state = await loadState();
      if (state.sync_paused) return;

      const tabs = syncableTabs(await browser.tabs.query({}), state.excluded_domains ?? []);
      if (tabs.length === 0) {
        // Also protects against uploading an empty snapshot while the browser shuts down.
        log(`no syncable tabs, skipping (${trigger})`);
        return;
      }
      const hash = await sha256Hex(normalizeForHash(tabs));
      const last = state.last_upload;
      if (
        !force &&
        last &&
        last.user_id === session.userId &&
        last.device_id === session.deviceId &&
        last.hash === hash
      ) {
        return;
      }

      try {
        const capturedAt = await upload(session, tabs);
        const syncCount = (state.sync_count ?? 0) + 1;
        await patchState({
          last_sync_at: capturedAt,
          last_tab_count: tabs.length,
          sync_count: syncCount,
          last_error: undefined,
          last_upload: { user_id: session.userId, device_id: session.deviceId, hash },
        });
        log(`uploaded ${tabs.length} tabs (${trigger})`);
        broadcast({ type: 'SYNC_COMPLETE', tabCount: tabs.length, capturedAt });
      } catch (err) {
        if (err instanceof ApiRequestError && err.sessionEnded) return; // handled centrally
        const message = errorMessage(err, 'Sync failed.');
        console.warn('[VaultTabs] sync failed:', message);
        await patchState({ last_error: message });
        broadcast({ type: 'SYNC_FAILED', error: message });
        throw err;
      }
    }

    /** Encrypts and uploads; re-registers the device once if the server rejects it. */
    async function upload(session: ActiveSession, tabs: TabSnapshot[]): Promise<string> {
      let deviceId = session.deviceId;
      for (let attempt = 0; ; attempt++) {
        const capturedAt = new Date().toISOString();
        const encrypted = await encryptSnapshot(tabs, session.masterKey, {
          userId: session.userId,
          deviceId,
          capturedAt,
        });
        if (encrypted.encrypted_blob.length > LIMITS.maxSnapshotBlobChars) {
          throw new Error('Too many open tabs to sync in one snapshot.');
        }
        try {
          await api.uploadSnapshot({ device_id: deviceId, captured_at: capturedAt, ...encrypted });
          return capturedAt;
        } catch (err) {
          if (attempt === 0 && isDeviceRejected(err)) {
            deviceId = await reRegisterDevice(session);
            session = { ...session, deviceId };
            continue;
          }
          throw err;
        }
      }
    }

    /** 403: the device id belongs to someone else; 404: the device was removed. */
    function isDeviceRejected(err: unknown): boolean {
      return err instanceof ApiRequestError && (err.status === 403 || err.status === 404);
    }

    async function reRegisterDevice(session: ActiveSession): Promise<string> {
      log('device rejected by server, registering a new one');
      const { device } = await api.registerDevice({ device_name: session.deviceName || defaultDeviceName() });
      await setDeviceId(session.userId, device.id);
      await patchState({ device_name: device.device_name });
      // The stream was opened for the old device id.
      restartStream();
      return device.id;
    }

    async function heartbeat(): Promise<void> {
      const session = await getActiveSession();
      if (!session) return;
      try {
        await api.heartbeat(session.deviceId);
      } catch (err) {
        if (isDeviceRejected(err)) await reRegisterDevice(session).catch(() => {});
      }
    }

    // ─── Restore stream ─────────────────────────────────────────────────────────────────────────

    let stream: AbortController | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let streamConnected = false;
    const handledRequests = new Set<string>();

    function stopStream(): void {
      clearTimeout(reconnectTimer);
      void browser.alarms.clear(ALARM_RECONNECT);
      stream?.abort();
      stream = null;
      streamConnected = false;
    }

    function restartStream(): void {
      stopStream();
      reconnectAttempt = 0;
      void ensureStream();
    }

    function scheduleReconnect(): void {
      const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
      const delay = exp / 2 + Math.random() * (exp / 2); // "equal jitter"
      reconnectAttempt++;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => void ensureStream(), delay);
      // If the worker is suspended the timer is lost; the alarm wakes it up.
      void browser.alarms.create(ALARM_RECONNECT, {
        delayInMinutes: Math.max(MIN_ALARM_MINUTES, delay / 60_000),
      });
    }

    async function ensureStream(): Promise<void> {
      if (stream) return; // never two concurrent streams
      const controller = new AbortController();
      stream = controller;
      try {
        const session = await getActiveSession();
        if (!session || controller.signal.aborted) return;
        const response = await api.restoreStream(session.deviceId, controller.signal);
        if (!response.body) throw new Error('Stream has no body');
        streamConnected = true;
        log('restore stream connected');
        void pollPending(session);
        let reset = false;
        await readSse(
          response.body,
          {
            onEvent: data => {
              if (!reset) {
                reset = true;
                reconnectAttempt = 0;
              }
              let parsed: PendingRestoreResponse;
              try {
                parsed = JSON.parse(data) as PendingRestoreResponse;
              } catch {
                return;
              }
              void handleQueue(parsed);
            },
            onComment: () => {
              if (!reset) {
                reset = true;
                reconnectAttempt = 0;
              }
              // Any extension API call resets the MV3 service worker idle timer.
              void browser.runtime.getPlatformInfo();
            },
          },
          controller.signal,
        );
      } catch (err) {
        if (!controller.signal.aborted) console.warn('[VaultTabs] restore stream error:', errorMessage(err));
      } finally {
        if (stream === controller) {
          stream = null;
          streamConnected = false;
        }
      }
      if (!controller.signal.aborted && (await getActiveSession())) scheduleReconnect();
    }

    async function pollPending(session: ActiveSession): Promise<void> {
      try {
        const res = await api.pendingRestore(session.deviceId);
        await handleQueue(res);
      } catch {
        // The stream / next alarm will retry.
      }
    }

    // ─── Restore handling ───────────────────────────────────────────────────────────────────────

    /**
     * Open every queued request, oldest first. Tabs sent while this browser was closed wait on the
     * server (up to 24 h) and arrive here on the first connect after startup.
     */
    async function handleQueue(res: PendingRestoreResponse): Promise<void> {
      if (!res.pending) return;
      const queue = res.requests?.length ? res.requests : res.request ? [res.request] : [];
      for (const request of queue) await handleRestore(request);
    }

    async function handleRestore(request: PendingRestoreDetail): Promise<void> {
      if (handledRequests.has(request.id)) return;
      handledRequests.add(request.id);

      const result = await executeRestore(request);
      log(`restore ${request.id}: ${result.ok ? `opened ${result.count} tabs` : result.code}`);
      try {
        await api.completeRestore(
          request.id,
          result.ok ? { status: 'completed' } : { status: 'failed', error_code: result.code },
        );
      } catch (err) {
        console.warn('[VaultTabs] could not report restore result:', errorMessage(err));
      }
      if (result.ok) broadcast({ type: 'RESTORE_COMPLETE', tabCount: result.count });
    }

    type RestoreResult = { ok: true; count: number } | { ok: false; code: RestoreErrorCode };

    async function executeRestore(request: PendingRestoreDetail): Promise<RestoreResult> {
      const session = await getActiveSession();
      if (!session) return { ok: false, code: 'master_key_missing' };

      try {
        if (request.snapshot) {
          const snap = request.snapshot;
          let tabs: TabSnapshot[];
          try {
            tabs = await decryptSnapshot(snap.encrypted_blob, snap.iv, session.masterKey, snap.enc_version, {
              userId: session.userId,
              deviceId: snap.device_id,
              capturedAt: snap.captured_at,
            });
          } catch {
            return { ok: false, code: 'decrypt_failed' };
          }
          if (tabs.length === 0) return { ok: false, code: 'empty_snapshot' };
          const count = await openSnapshotWindows(tabs);
          return count > 0 ? { ok: true, count } : { ok: false, code: 'unsafe_url' };
        }

        if (request.encrypted_payload && request.payload_iv) {
          let urls: string[];
          try {
            ({ urls } = await decryptRestorePayload(
              request.encrypted_payload,
              request.payload_iv,
              session.masterKey,
              {
                userId: session.userId,
                targetDeviceId: session.deviceId,
              },
            ));
          } catch {
            return { ok: false, code: 'decrypt_failed' };
          }
          // decryptRestorePayload drops non-http(s) URLs.
          if (urls.length === 0) return { ok: false, code: 'unsafe_url' };
          return { ok: true, count: await openUrlsInNewWindow(urls) };
        }

        return { ok: false, code: 'empty_snapshot' };
      } catch (err) {
        console.warn('[VaultTabs] opening restored tabs failed:', errorMessage(err));
        return { ok: false, code: 'open_failed' };
      }
    }

    // ─── Session lifecycle ──────────────────────────────────────────────────────────────────────

    async function onSessionStarted(): Promise<void> {
      handledRequests.clear();
      restartStream();
      await requestSync('login', true).catch(() => {});
    }

    function onSessionEnded(): void {
      clearTimeout(debounceTimer);
      stopStream();
      handledRequests.clear();
    }

    // ─── Event wiring (registered synchronously so events wake the worker) ──────────────────────

    // onActivated is ignored on purpose: switching tabs does not change what is synced.
    browser.tabs.onCreated.addListener(markDirty);
    browser.tabs.onRemoved.addListener(markDirty);
    browser.tabs.onMoved.addListener(markDirty);
    browser.tabs.onAttached.addListener(markDirty);
    browser.tabs.onDetached.addListener(markDirty);
    browser.windows.onCreated.addListener(markDirty);
    browser.windows.onRemoved.addListener(markDirty);
    browser.tabs.onUpdated.addListener((_id, change) => {
      if (change.url !== undefined || change.title !== undefined || change.pinned !== undefined) markDirty();
    });

    browser.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM_FALLBACK) {
        void requestSync('fallback').catch(() => {});
        void heartbeat();
        if (!streamConnected) {
          void getActiveSession().then(s => s && pollPending(s));
          void ensureStream();
        }
      } else if (alarm.name === ALARM_RECONNECT) {
        void ensureStream();
      }
    });

    const SETTINGS_KEYS: StateKey[] = ['excluded_domains', 'sync_paused'];
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('token' in changes) {
        if (changes.token?.newValue) void onSessionStarted();
        else onSessionEnded();
        return;
      }
      if (SETTINGS_KEYS.some(k => k in changes)) markDirty();
    });

    browser.runtime.onMessage.addListener(
      (message: unknown, sender, sendResponse: (r: SyncNowResponse) => void) => {
        if (sender.id !== browser.runtime.id || !isPopupRequest(message)) return;
        requestSync('manual', true)
          .then(() => loadState())
          .then(s => sendResponse(s.last_error ? { ok: false, error: s.last_error } : { ok: true }))
          .catch(err => sendResponse({ ok: false, error: errorMessage(err, 'Sync failed.') }));
        return true; // async response
      },
    );

    void browser.alarms.get(ALARM_FALLBACK).then(existing => {
      if (!existing) void browser.alarms.create(ALARM_FALLBACK, { periodInMinutes: FALLBACK_MINUTES });
    });

    // Worker (re)start: resume if a session exists.
    void (async () => {
      await migrateLegacyState();
      if (!(await getActiveSession())) return;
      void ensureStream();
      await requestSync('startup').catch(() => {});
    })();
  },
});
