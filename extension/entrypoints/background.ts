/**
 * entrypoints/background.ts
 *
 * The background service worker — production-grade, event-driven sync.
 *
 * ═══════════════════════════════════════════════════════════════
 * SYNC STRATEGY (why it's designed this way)
 * ═══════════════════════════════════════════════════════════════
 *
 * ❌ OLD (bad): Poll every 15 seconds
 *    - Wastes CPU, battery, bandwidth even when nothing changed
 *    - Fights against MV3's philosophy (service worker should sleep)
 *
 * ✅ NEW (correct): Event-driven + debounce + periodic fallback
 *
 *   LAYER 1 — Event triggers (primary)
 *   Tab created/removed/updated/moved, window created/removed.
 *   Any real state mutation fires these instantly.
 *
 *   LAYER 2 — 3-second debounce (batching)
 *   User opens 10 tabs in 2 seconds → only 1 upload, not 10.
 *   Debounce resets on every new event within the window.
 *   We use chrome.alarms (not setTimeout) because setTimeout
 *   dies when the service worker sleeps between events.
 *
 *   LAYER 3 — Periodic 3-minute fallback alarm
 *   Safety net: catches anything missed while service worker was asleep.
 *   Also handles the case where the network failed and we need to retry.
 *
 *   LAYER 4 — Hash comparison (skip redundant uploads)
 *   After building a snapshot, we SHA-256 hash the serialized tabs.
 *   If the hash matches the last uploaded snapshot → skip the upload.
 *   This handles events that fire but don't change real tab state
 *   (e.g. chrome.tabs.onActivated doesn't change URLs or titles).
 *
 * RESULT:
 *   CPU: near zero when idle
 *   Bandwidth: only when tabs actually change
 *   Battery: safe
 *   Latency: ~3 seconds after a tab change (feels real-time)
 * ═══════════════════════════════════════════════════════════════
 */

import { encryptSnapshot, decryptSnapshot, TabSnapshot } from '../utils/crypto';
import { loadFromStorage, saveToStorage, loadMasterKey } from '../utils/storage';
import { apiUploadSnapshot, apiHeartbeat, apiGetPendingRestore, apiCompleteRestore, apiConnectRestoreStream } from '../utils/api';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Alarm names — must be unique strings
const ALARM_DEBOUNCE = 'vaulttabs-debounce';   // Fires 3s after last tab event
const ALARM_FALLBACK = 'vaulttabs-fallback';   // Fires every 3 minutes as safety net
const ALARM_RECONNECT = 'vaulttabs-reconnect';  // Fires if SSE drops

const DEBOUNCE_SECONDS = 3;
const FALLBACK_MINUTES = 3;
const RECONNECT_SECONDS = 5;                   // Reconnect delay
const MAX_SYNC_AGE_MS = FALLBACK_MINUTES * 60 * 1000;

export default defineBackground(() => {
  console.log('[VaultTabs] Background service worker started');

  // ── STARTUP: CHECK MASTER KEY IS STILL IN INDEXEDDB ───────────────────────
  // When Chrome restarts, the service worker starts fresh.
  // IndexedDB persists across restarts, BUT in rare cases it can be cleared
  // (user cleared site data, extension was reinstalled, etc.).
  // If the token exists but the master key is gone → tell popup to re-login.
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

  // ── IN-MEMORY STATE ────────────────────────────────────────────────────────
  // These live in memory while the service worker is alive.
  // They're reset when the service worker is killed by Chrome (that's fine —
  // the periodic alarm will wake us up and re-sync from scratch).

  /** SHA-256 hash of the last successfully uploaded snapshot. Used to skip redundant uploads. */
  let lastUploadedHash: string | null = null;

  /** True if a tab event has fired since the last sync. */
  let isDirty = false;

  // ── SETUP PERSISTENT ALARMS ────────────────────────────────────────────────
  chrome.alarms.create(ALARM_FALLBACK, { periodInMinutes: FALLBACK_MINUTES });

  // ── TAB EVENT LISTENERS ────────────────────────────────────────────────────
  // All of these call markDirty() which starts the 3-second debounce.

  // A new tab was opened
  chrome.tabs.onCreated.addListener(() => {
    markDirty('tab created');
  });

  // A tab was closed
  chrome.tabs.onRemoved.addListener(() => {
    markDirty('tab removed');
  });

  // A tab's URL, title, or status changed
  // We filter to only URL changes — status changes fire constantly during page load
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    // changeInfo.url is set only when the tab navigates to a new URL
    // changeInfo.title is set when the page title changes (after load)
    if (changeInfo.url || changeInfo.title) {
      markDirty('tab updated');
    }
  });

  // A tab was moved to a different position in the window
  chrome.tabs.onMoved.addListener(() => {
    markDirty('tab moved');
  });

  // A tab was moved between windows
  chrome.tabs.onAttached.addListener(() => markDirty('tab attached'));
  chrome.tabs.onDetached.addListener(() => markDirty('tab detached'));

  // A new window was opened or closed
  chrome.windows.onCreated.addListener(() => markDirty('window created'));
  chrome.windows.onRemoved.addListener(() => markDirty('window removed'));

  // NOTE: We intentionally do NOT listen to onActivated (tab focus changes).
  // Switching which tab is active doesn't change the data we care about
  // (URLs, titles, open/closed state). Listening to it would cause unnecessary
  // debounce resets every time the user clicks a tab.

  // ── ALARM LISTENER ─────────────────────────────────────────────────────────
  chrome.alarms.onAlarm.addListener(async (alarm) => {

    if (alarm.name === ALARM_DEBOUNCE) {
      // Debounce timer expired — enough time has passed since the last tab event.
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

      // Safety net: always ensure restore stream is active during fallback wakeups
      setupRestoreStream();
    }

    if (alarm.name === ALARM_RECONNECT) {
      setupRestoreStream();
    }
  });

  // ── MESSAGE LISTENER ───────────────────────────────────────────────────────
  // Popup sends messages when user logs in or out
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'START_SYNC') {
      console.log('[VaultTabs] Login detected → immediate sync');
      // Reset hash so we definitely upload on first login
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

  // ─────────────────────────────────────────────────────────────────────────────
  // MARK DIRTY — called by every tab event
  //
  // Sets the dirty flag and resets the debounce alarm.
  // If the user opens 10 tabs in 2 seconds:
  //   - markDirty is called 10 times
  //   - Each call resets the 3-second alarm back to 0
  //   - The alarm only fires once, 3 seconds after the LAST tab event
  //   - Result: 1 upload instead of 10
  // ─────────────────────────────────────────────────────────────────────────────

  function markDirty(reason: string) {
    isDirty = true;
    console.log(`[VaultTabs] Tab change (${reason}) → debounce reset`);

    // chrome.alarms minimum is 0.016 minutes (~1 second).
    // We want 3 seconds = 0.05 minutes.
    // Creating an alarm that already exists replaces it — this is the debounce mechanism.
    chrome.alarms.create(ALARM_DEBOUNCE, {
      delayInMinutes: DEBOUNCE_SECONDS / 60,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PERFORM SYNC — the actual work
  //
  // Called by the debounce alarm or the fallback alarm.
  // Steps:
  //   1. Auth check
  //   2. Read tabs
  //   3. Hash comparison (skip if unchanged)
  //   4. Encrypt
  //   5. Upload
  // ─────────────────────────────────────────────────────────────────────────────

  async function performSync(trigger: string) {
    try {
      // ── 1. AUTH CHECK ──────────────────────────────────────────────────────
      const storage = await loadFromStorage();
      if (!storage.is_logged_in || !storage.jwt_token || !storage.device_id) {
        console.log('[VaultTabs] Not logged in — skipping sync');
        isDirty = false;
        return;
      }

      // ── 2. LOAD MASTER KEY ─────────────────────────────────────────────────
      const masterKey = await loadMasterKey();
      if (!masterKey) {
        console.warn('[VaultTabs] Master key missing — user may need to re-login');
        return;
      }

      // ── 3. READ TABS ───────────────────────────────────────────────────────
      const chromeTabs = await chrome.tabs.query({});

      // Only capture HTTP/HTTPS tabs — skip chrome://, about:, extension pages
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

      // ── 4. HASH COMPARISON ─────────────────────────────────────────────────
      // Serialize tabs to JSON, then SHA-256 hash it.
      // Compare with the last uploaded hash.
      // If identical → skip upload (nothing actually changed).
      //
      // WHY THIS MATTERS:
      // Some tab events fire without changing real state.
      // e.g. chrome.tabs.onUpdated fires during page load progress
      // even if the URL didn't change. The hash catches these.
      const serialized = JSON.stringify(tabs);
      const currentHash = await hashString(serialized);

      if (currentHash === lastUploadedHash) {
        console.log(`[VaultTabs] Hash unchanged — skipping upload (trigger: ${trigger})`);
        isDirty = false;
        return;
      }

      console.log(`[VaultTabs] Hash changed — uploading ${tabs.length} tabs (trigger: ${trigger})`);

      // ── 5. ENCRYPT ────────────────────────────────────────────────────────
      const capturedAt = new Date().toISOString();
      const { encryptedBlob, iv } = await encryptSnapshot(tabs, masterKey);

      // ── 6. UPLOAD ─────────────────────────────────────────────────────────
      const result = await apiUploadSnapshot({
        device_id: storage.device_id,
        captured_at: capturedAt,
        iv,
        encrypted_blob: encryptedBlob,
      });

      if (!result.ok) {
        console.error('[VaultTabs] Upload failed:', result.error);
        // Keep isDirty = true so the fallback alarm retries
        return;
      }

      // ── 7. SUCCESS ────────────────────────────────────────────────────────
      lastUploadedHash = currentHash;
      isDirty = false;

      const newCount = (storage.sync_count ?? 0) + 1;
      await saveToStorage({
        last_sync_at: capturedAt,
        last_tab_count: tabs.length,
        sync_count: newCount,
        last_error: undefined,   // Clear any previous error
      });

      await apiHeartbeat(storage.device_id);

      console.log(`[VaultTabs] ✓ Synced ${tabs.length} tabs at ${capturedAt} (trigger: ${trigger}, total: ${newCount})`);

      // Notify popup to refresh its display (if it's open)
      chrome.runtime.sendMessage({
        type: 'SYNC_COMPLETE',
        tabCount: tabs.length,
        capturedAt,
        syncCount: newCount,
      }).catch(() => { /* popup not open — that's fine */ });

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[VaultTabs] Sync error:', errorMsg);
      // Save the error so popup can show it
      await saveToStorage({ last_error: errorMsg }).catch(() => { });
      // Keep isDirty = true — fallback alarm will retry
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SERVER-SENT EVENTS (SSE) STREAMING
  //
  // Replaces the old 5-second polling interval! 
  // Keeps an open connection to the backend. The backend pushes events to us
  // instantly when the user clicks 'Restore to this device' on their phone.
  // The backend also sends a 20s heartbeat, which effectively resets the 30s 
  // idle timeout of the MV3 Service Worker, keeping it awake while Chrome runs!
  // ─────────────────────────────────────────────────────────────────────────────

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

      // Open all tabs
      await openRestoredTabs(tabs);

      // Mark completed on backend
      await apiCompleteRestore(req.id, 'completed');

      console.log(`[VaultTabs] ✓ Restored ${tabs.length} tabs from snapshot ${req.snapshot_id}`);

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

  async function openRestoredTabs(tabs: TabSnapshot[]) {
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

      // Open remaining tabs in that window
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

  // ─────────────────────────────────────────────────────────────────────────────
  // HASH UTILITY
  //
  // SHA-256 hash of a string using the WebCrypto API.
  // Returns a hex string like "a3f2bc9e..."
  //
  // Used for snapshot comparison only — not for security.
  // We just need a fast, reliable way to detect content changes.
  // ─────────────────────────────────────────────────────────────────────────────

  async function hashString(input: string): Promise<string> {
    const bytes = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

});