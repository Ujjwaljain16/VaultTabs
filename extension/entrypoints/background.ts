// The background service worker manages event-driven syncing of tabs to the VaultTabs backend.
//   Uses a debounce mechanism and periodic fallback alarms to optimize network and CPU usage

import { encryptSnapshot, decryptSnapshot, TabSnapshot } from '../utils/crypto';
import { loadFromStorage, saveToStorage, loadMasterKey } from '../utils/storage';
import { apiUploadSnapshot, apiHeartbeat, apiGetPendingRestore, apiCompleteRestore, apiConnectRestoreStream, apiRegisterDevice, getDeviceName } from '../utils/api';
import { getBrowserFingerprint } from '../utils/fingerprint';


const ALARM_DEBOUNCE = 'vaulttabs-debounce';   // Fires 3s after last tab event
const ALARM_FALLBACK = 'vaulttabs-fallback';   // Fires every 3 minutes as safety net
const ALARM_RECONNECT = 'vaulttabs-reconnect';  // Fires if SSE drops

const DEBOUNCE_SECONDS = 3;
const FALLBACK_MINUTES = 3;
const RECONNECT_SECONDS = 5;               
const MAX_SYNC_AGE_MS = FALLBACK_MINUTES * 60 * 1000;

export default defineBackground(() => {
  console.log('[VaultTabs] Background service worker started');
  (async () => {
    const storage = await loadFromStorage();
    if (storage.is_logged_in && storage.master_key_stored) {
      const key = await loadMasterKey();
      if (!key) {
        console.warn('[VaultTabs] Master key missing from IndexedDB after restart → forcing re-login');
        // Clear auth state so popup shows login form
        await saveToStorage({ is_logged_in: false, last_error: 'Session expired. Please log in again.' });
      } else {
        console.log('[VaultTabs] Master key found — session restored');
        // Sync immediately on startup so data is fresh
        await performSync('startup');
        setupRestoreStream();
      }
    }
  })();

  let lastUploadedHash: string | null = null;
  let isDirty = false;

  chrome.alarms.create(ALARM_FALLBACK, { periodInMinutes: FALLBACK_MINUTES });

  chrome.tabs.onCreated.addListener(() => {
    markDirty('tab created');
  });
  chrome.tabs.onRemoved.addListener(() => {
    markDirty('tab removed');
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title) {
      markDirty('tab updated');
    }
  });
  chrome.tabs.onMoved.addListener(() => {
    markDirty('tab moved');
  });

  chrome.tabs.onAttached.addListener(() => markDirty('tab attached'));
  chrome.tabs.onDetached.addListener(() => markDirty('tab detached'));

  chrome.windows.onCreated.addListener(() => markDirty('window created'));
  chrome.windows.onRemoved.addListener(() => markDirty('window removed'));

  // NOTE: We intentionally do NOT listen to onActivated (tab focus changes).
  // Switching which tab is active doesn't change the data we care about
  // (URLs, titles, open/closed state). Listening to it would cause unnecessary
  // debounce resets every time the user clicks a tab.
  chrome.alarms.onAlarm.addListener(async (alarm) => {

    if (alarm.name === ALARM_DEBOUNCE) {
      // Debounce timer expired enough time has passed since the last tab event.
      // Now actually do the sync.
      console.log('[VaultTabs] Debounce complete → syncing');
      await performSync('debounce');
    }

    if (alarm.name === ALARM_FALLBACK) {
      const storage = await loadFromStorage();
      const lastSync = storage.last_sync_at ? new Date(storage.last_sync_at).getTime() : 0;
      const timeSinceSync = Date.now() - lastSync;
      if (isDirty || timeSinceSync > MAX_SYNC_AGE_MS) {
        console.log(`[VaultTabs] Fallback alarm → syncing`);
        await performSync('fallback');
      }
      setupRestoreStream();
    }

    if (alarm.name === ALARM_RECONNECT) {
      setupRestoreStream();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'START_SYNC') {
      console.log('[VaultTabs] Login detected → immediate sync');
      lastUploadedHash = null;
      isDirty = true;
      performSync('login');
    }

    if (message.type === 'STOP_SYNC') {
      console.log('[VaultTabs] Logout detected → clearing alarms');
      chrome.alarms.clear(ALARM_DEBOUNCE);
      chrome.alarms.clear(ALARM_RECONNECT);
      isStreamActive = false;
      lastUploadedHash = null;
      isDirty = false;
    }
  });

  function markDirty(reason: string) {
    isDirty = true;
    console.log(`[VaultTabs] Tab change (${reason}) → debounce reset`);
    chrome.alarms.create(ALARM_DEBOUNCE, {
      delayInMinutes: DEBOUNCE_SECONDS / 60,
    });
  }

  // PERFORM SYNC the actual work
  // Called by the debounce alarm or the fallback alarm.
  // Steps:
  //   1. Auth check
  //   2. Read tabs
  //   3. Hash comparison (skip if unchanged)
  //   4. Encrypt
  //   5. Upload

  async function performSync(trigger: string) {
    try {
      const storage = await loadFromStorage();
      if (!storage.is_logged_in || !storage.jwt_token || !storage.device_id) {
        console.log('[VaultTabs] Not logged in — skipping sync');
        isDirty = false;
        return;
      }
      const masterKey = await loadMasterKey();
      if (!masterKey) {
        console.warn('[VaultTabs] Master key missing — user may need to re-login');
        return;
      }

    
      const chromeTabs = await chrome.tabs.query({});

      const tabs: TabSnapshot[] = chromeTabs
        .filter(tab => tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://')))
        .map(tab => ({
          id: tab.id ?? 0,
          url: tab.url ?? '',
          title: tab.title ?? 'Untitled',
          favIconUrl: tab.favIconUrl,
          windowId: tab.windowId,
          index: tab.index,
          active: tab.active,
          pinned: tab.pinned,
        }));

      if (tabs.length === 0) {
        console.log('[VaultTabs] No HTTP tabs open — skipping sync');
        isDirty = false;
        return;
      }
      const serialized = JSON.stringify(tabs);
      const currentHash = await hashString(serialized);

      if (currentHash === lastUploadedHash) {
        console.log(`[VaultTabs] Hash unchanged — skipping upload (trigger: ${trigger})`);
        isDirty = false;
        return;
      }

      console.log(`[VaultTabs] Hash changed — uploading ${tabs.length} tabs (trigger: ${trigger})`);

      const capturedAt = new Date().toISOString();
      const { encryptedBlob, iv } = await encryptSnapshot(tabs, masterKey);

      const result = await apiUploadSnapshot({
        device_id: storage.device_id,
        captured_at: capturedAt,
        iv,
        encrypted_blob: encryptedBlob,
      });

      if (!result.ok) {
        console.error('[VaultTabs] Upload failed:', result.error);

        if (result.error?.includes('This device does not belong to your account')) {
          console.warn('[VaultTabs] Device identity mismatch — attempting auto-recovery...');
          const fingerprint = await getBrowserFingerprint();
          const deviceName = storage.device_name || getDeviceName();
          const regResult = await apiRegisterDevice(deviceName, fingerprint);

          if (regResult.ok && regResult.data) {
            const newId = regResult.data.device.id;
            console.log('[VaultTabs] Device identity successfully recovered:', newId);
            await saveToStorage({ device_id: newId });
          }
        }
        return;
      }

      lastUploadedHash = currentHash;
      isDirty = false;

      const newCount = (storage.sync_count ?? 0) + 1;
      await saveToStorage({
        last_sync_at: capturedAt,
        last_tab_count: tabs.length,
        sync_count: newCount,
        last_error: undefined,
      });

      await apiHeartbeat(storage.device_id);

      console.log(`[VaultTabs] Synced ${tabs.length} tabs at ${capturedAt} (trigger: ${trigger}, total: ${newCount})`);

      chrome.runtime.sendMessage({
        type: 'SYNC_COMPLETE',
        tabCount: tabs.length,
        capturedAt,
        syncCount: newCount,
      }).catch(() => { });

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[VaultTabs] Sync error:', errorMsg);
      await saveToStorage({ last_error: errorMsg }).catch(() => { });
    }
  }

  // SERVER-SENT EVENTS (SSE) STREAMING

  let isStreamActive = false;

  async function setupRestoreStream() {
    if (isStreamActive) return;

    const storage = await loadFromStorage();
    if (!storage.is_logged_in || !storage.jwt_token || !storage.device_id) return;

    console.log('[VaultTabs] Connecting to SSE Restore Stream...');
    isStreamActive = true;

    apiConnectRestoreStream(
      storage.device_id,
      async (data) => {
        if (data.pending && data.request) {
          console.log(`[VaultTabs] SSE event: Restore request received: ${data.request.id}`);
          await handleIncomingRestore(data.request);
        }
      },
      (error) => {
        isStreamActive = false;
        if (error) {
          console.error('[VaultTabs] SSE Stream error:', error.message);
        } else {
          console.log('[VaultTabs] SSE Stream closed gracefully.');
        }

        // 1. Fast reconnect using setTimeout (works as long as SW is awake)
        setTimeout(() => {
          setupRestoreStream();
        }, RECONNECT_SECONDS * 1000);

        // 2. Fallback reconnect using Chrome Alarms (if SW happens to suspend)
        // Note: Chrome rounds delays < 1 min to 1 min in production
        chrome.alarms.create(ALARM_RECONNECT, { delayInMinutes: Math.max(1, RECONNECT_SECONDS / 60) });
      }
    );
  }

  // Handle individual incoming restore request
  async function handleIncomingRestore(req: any) {
    try {
      // Load master key
      const masterKey = await loadMasterKey();
      if (!masterKey) {
        await apiCompleteRestore(req.id, 'failed', 'Master key not available — please re-login');
        return;
      }

      // Decrypt the snapshot
      let tabs: TabSnapshot[];
      try {
        tabs = await decryptSnapshot(req.encrypted_blob, req.snapshot_iv, masterKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Decryption failed';
        console.error('[VaultTabs] Restore decrypt failed:', msg);
        await apiCompleteRestore(req.id, 'failed', msg);
        return;
      }

      if (tabs.length === 0) {
        await apiCompleteRestore(req.id, 'failed', 'Snapshot contains no tabs');
        return;
      }

      // Open tabs (either one specific URL or the whole snapshot)
      await openRestoredTabs(tabs, req.target_url);

      // Mark completed on backend
      await apiCompleteRestore(req.id, 'completed');

      console.log(`[VaultTabs] Restored ${tabs.length} tabs from snapshot ${req.snapshot_id}`);

      // Notify popup
      chrome.runtime.sendMessage({
        type: 'RESTORE_COMPLETE',
        tabCount: tabs.length,
      }).catch(() => { });

    } catch (err) {
      console.error('[VaultTabs] incoming restore error:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // OPEN RESTORED TABS
  //
  // Opens tabs from a snapshot in an organised way:
  //   - Groups tabs by their original windowId
  //   - Creates one new window per group (preserving window layout)
  //   - Opens pinned tabs first within each window
  //   - Sets the originally-active tab as active
  //
  // WHY GROUP BY WINDOW?
  // If the user had 3 windows with different projects open,
  // restoring into one window would be a mess.
  // We recreate the original window structure.
  // ─────────────────────────────────────────────────────────────────────────────

  async function openRestoredTabs(tabs: TabSnapshot[], targetUrl?: string) {
    if (targetUrl) {
      console.log(`[VaultTabs] Single site restore: ${targetUrl}`);
      // Find the tab in the snapshot to get original metadata if possible,
      // though for a single URL we can just open it.
      const existingTab = tabs.find(t => t.url === targetUrl);

      await chrome.windows.create({
        url: targetUrl,
        focused: true,
      });
      return;
    }

    // Group tabs by original windowId
    const windowGroups = new Map<number, TabSnapshot[]>();
    for (const tab of tabs) {
      if (!windowGroups.has(tab.windowId)) windowGroups.set(tab.windowId, []);
      windowGroups.get(tab.windowId)!.push(tab);
    }

    for (const [, windowTabs] of windowGroups) {
      // Sort: pinned first, then by original index
      const sorted = [...windowTabs].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return a.index - b.index;
      });

      // Create a new window with the first tab
      const firstTab = sorted[0];
      const newWindow = await chrome.windows.create({
        url: firstTab.url,
        focused: true,
      });

      const newWindowId = newWindow.id!;

      for (let i = 1; i < sorted.length; i++) {
        await chrome.tabs.create({
          windowId: newWindowId,
          url: sorted[i].url,
          pinned: sorted[i].pinned,
          active: sorted[i].active,
        });
      }
    }
  }

  async function hashString(input: string): Promise<string> {
    const bytes = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

});