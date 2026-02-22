/**
 * entrypoints/popup/main.ts
 *
 * Popup UI controller. Handles all 4 screens:
 *   1. screen-loading  → shown while we check auth state
 *   2. screen-auth     → register or login forms
 *   3. screen-dashboard → live tab list + sync status
 *   4. screen-relogin  → password prompt when master key expired
 *
 * LIVE UPDATES:
 * The popup listens for SYNC_COMPLETE messages from the background worker.
 * When received, it refreshes the tab list and status WITHOUT closing/reopening.
 */

import {
  generateSalt, generateMasterKey,
  deriveWrappingKey, encryptMasterKey, decryptMasterKey,
  generateRecoveryCode, encryptMasterKeyForRecovery,
  hashRecoveryCode,
} from '../../utils/crypto';

import {
  saveToStorage, loadFromStorage,
  clearStorage, saveMasterKey, clearMasterKey, loadMasterKey,
} from '../../utils/storage';

import {
  apiRegister, apiLogin, apiRegisterDevice, apiRenameDevice, getDeviceName,
} from '../../utils/api';

// ─────────────────────────────────────────────────────────────────────────────
// ELEMENT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id) as T | null;
  if (!e) throw new Error(`#${id} not found`);
  return e;
}

function showScreen(id: string) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  el(id).classList.remove('hidden');
}

function showError(id: string, msg: string) {
  const e = el(id);
  e.textContent = msg;
  e.classList.remove('hidden');
}
function hideError(id: string) { el(id).classList.add('hidden'); }

function setLoading(btn: HTMLButtonElement, loading: boolean) {
  btn.disabled = loading;
  btn.querySelector('.btn-text')?.classList.toggle('hidden', loading);
  btn.querySelector('.btn-loading')?.classList.toggle('hidden', !loading);
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT — runs once when popup opens
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  showScreen('screen-loading');
  const storage = await loadFromStorage();

  if (!storage.is_logged_in || !storage.jwt_token) {
    // Pre-fill device name for registration/login
    const defaultName = getDeviceName();
    el<HTMLInputElement>('reg-device-name').value = defaultName;
    el<HTMLInputElement>('login-device-name').value = defaultName;

    showScreen('screen-auth');
    return;
  }

  // Logged in — but check if master key is still in IndexedDB
  // (It might be gone if browser storage was cleared)
  const masterKey = await loadMasterKey();
  if (!masterKey) {
    // Pre-fill email for convenience
    const emailInput = el<HTMLInputElement>('relogin-email');
    emailInput.value = storage.user_email || '';
    showScreen('screen-relogin');
    return;
  }

  // Also clear any stale error from storage
  if (storage.last_error) {
    await saveToStorage({ last_error: undefined });
  }

  showDashboard(storage);
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

async function showDashboard(storage: Awaited<ReturnType<typeof loadFromStorage>>) {
  showScreen('screen-dashboard');

  // Static fields
  el('user-email-display').textContent = storage.user_email || '';
  const deviceName = storage.device_name || '—';
  el('info-device').textContent = deviceName.length > 7
    ? deviceName.slice(0, 6) + '…' : deviceName;

  await refreshDashboard();
}

/**
 * Refreshes the dynamic parts of the dashboard:
 * - Tab list (live from chrome.tabs)
 * - Window count
 * - Sync status + sync count
 * - Error banner
 *
 * Called on open AND whenever background sends SYNC_COMPLETE.
 */
async function refreshDashboard() {
  const storage = await loadFromStorage();

  // ── ERROR BANNER ───────────────────────────────────────────────────────────
  const errorBanner = el('error-banner');
  if (storage.last_error) {
    el('error-banner-text').textContent = storage.last_error;
    errorBanner.classList.remove('hidden');
  } else {
    errorBanner.classList.add('hidden');
  }

  // ── TAB + WINDOW COUNT ─────────────────────────────────────────────────────
  const allTabs = await chrome.tabs.query({});
  const httpTabs = allTabs.filter(t => t.url?.startsWith('http'));
  const windows = await chrome.windows.getAll();

  el('info-tab-count').textContent = httpTabs.length.toString();
  el('info-window-count').textContent = windows.length.toString();

  // ── SYNC STATUS ────────────────────────────────────────────────────────────
  const dot = el('status-dot');
  const text = el('status-text');
  const detail = el('status-detail');
  const count = el('sync-count');

  if (storage.sync_count) {
    count.textContent = `↑ ${storage.sync_count}`;
  }

  if (storage.last_error) {
    dot.className = 'status-dot error';
    text.textContent = 'Sync error';
    detail.textContent = 'Will retry automatically';
  } else if (storage.last_sync_at) {
    const secondsAgo = Math.round((Date.now() - new Date(storage.last_sync_at).getTime()) / 1000);
    if (secondsAgo < 10) {
      dot.className = 'status-dot synced';
      text.textContent = 'Synced';
      detail.textContent = 'Just now';
    } else if (secondsAgo < 60) {
      dot.className = 'status-dot synced';
      text.textContent = 'Synced';
      detail.textContent = `${secondsAgo}s ago`;
    } else if (secondsAgo < 300) {
      dot.className = 'status-dot syncing';
      text.textContent = 'Pending sync';
      detail.textContent = `Last: ${Math.round(secondsAgo / 60)}m ago`;
    } else {
      dot.className = 'status-dot error';
      text.textContent = 'Sync stalled';
      detail.textContent = `Last: ${Math.round(secondsAgo / 60)}m ago`;
    }
  } else {
    dot.className = 'status-dot syncing';
    text.textContent = 'Awaiting first sync';
    detail.textContent = 'Open or close a tab to trigger';
  }

  // ── TAB LIST ───────────────────────────────────────────────────────────────
  renderTabList(httpTabs);
}

/**
 * Renders the live tab preview list.
 * Shows up to 12 tabs. Active tab is highlighted.
 * Each tab is a clickable link that focuses that tab.
 */
function renderTabList(tabs: chrome.tabs.Tab[]) {
  const list = el('tab-list');
  const hint = el('tabs-hint');
  const MAX = 12;

  // Sort: active tab first, then by window + index
  const sorted = [...tabs].sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.index - b.index;
  });

  const visible = sorted.slice(0, MAX);
  const hidden = sorted.length - visible.length;

  hint.textContent = hidden > 0 ? `+${hidden} more` : '';

  if (visible.length === 0) {
    list.innerHTML = '<div class="tab-list-empty">No HTTP tabs open</div>';
    return;
  }

  list.innerHTML = '';

  for (const tab of visible) {
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.title = tab.url || '';

    // Favicon
    const faviconEl = tab.favIconUrl
      ? (() => {
        const img = document.createElement('img');
        img.className = 'tab-favicon';
        img.src = tab.favIconUrl!;
        img.onerror = () => { img.replaceWith(makeFallbackFavicon()); };
        return img;
      })()
      : makeFallbackFavicon();

    // Title + URL
    const info = document.createElement('div');
    info.className = 'tab-info';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || 'Untitled';

    const url = document.createElement('div');
    url.className = 'tab-url';
    // Show just the hostname, not the full URL
    try { url.textContent = new URL(tab.url || '').hostname; }
    catch { url.textContent = tab.url || ''; }

    info.appendChild(title);
    info.appendChild(url);

    item.appendChild(faviconEl);
    item.appendChild(info);

    // Green dot for the active tab
    if (tab.active) {
      const dot = document.createElement('div');
      dot.className = 'tab-active-dot';
      dot.title = 'Active tab';
      item.appendChild(dot);
    }

    // Click → focus that tab
    item.addEventListener('click', () => {
      if (tab.id !== undefined) {
        chrome.tabs.update(tab.id, { active: true });
        chrome.windows.update(tab.windowId, { focused: true });
      }
    });

    list.appendChild(item);
  }

  // "X more" footer
  if (hidden > 0) {
    const more = document.createElement('div');
    more.className = 'tab-list-more';
    more.textContent = `+ ${hidden} more tab${hidden > 1 ? 's' : ''}`;
    list.appendChild(more);
  }
}

function makeFallbackFavicon(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'tab-favicon-fallback';
  div.textContent = '○';
  return div;
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER
// ─────────────────────────────────────────────────────────────────────────────

async function handleRegister(e: Event) {
  e.preventDefault();
  hideError('reg-error');

  const email = el<HTMLInputElement>('reg-email').value.trim();
  const password = el<HTMLInputElement>('reg-password').value;
  const confirm = el<HTMLInputElement>('reg-password-confirm').value;
  const deviceName = el<HTMLInputElement>('reg-device-name').value.trim() || getDeviceName();
  const btn = el<HTMLButtonElement>('btn-register');

  if (password !== confirm) { showError('reg-error', 'Passwords do not match.'); return; }

  setLoading(btn, true);
  try {
    // 1. Generate crypto material
    const salt = generateSalt();
    const wrappingKey = await deriveWrappingKey(password, salt);
    const masterKey = await generateMasterKey();
    const { encryptedMasterKey, iv: masterKeyIv } = await encryptMasterKey(masterKey, wrappingKey);

    // 2. Generate recovery key (happens client-side, never sent to server plaintext)
    const recoveryCode = generateRecoveryCode();
    const recovery = await encryptMasterKeyForRecovery(masterKey, recoveryCode);
    const recoveryKeyHash = await hashRecoveryCode(recoveryCode);

    // 3. Register account — send both the password-encrypted key AND the recovery-encrypted key
    const result = await apiRegister({
      email, password,
      encrypted_master_key: encryptedMasterKey,
      master_key_iv: masterKeyIv,
      salt,
      // Recovery key fields (server stores encrypted copy, not the code)
      recovery_encrypted_master_key: recovery.encryptedMasterKey,
      recovery_key_iv: recovery.iv,
      recovery_key_salt: recovery.salt,
      recovery_key_hash: recoveryKeyHash,
    });
    if (!result.ok || !result.data) { showError('reg-error', result.error || 'Registration failed.'); return; }

    const { token, user } = result.data;

    // 4. Register device (reuse existing device_id if present)
    await saveToStorage({ jwt_token: token, user_id: user.id, user_email: user.email });
    const existing = await loadFromStorage();
    let deviceId = existing.device_id;
    const finalDeviceName = deviceName || existing.device_name || getDeviceName();

    if (!deviceId) {
      const deviceResult = await apiRegisterDevice(finalDeviceName);
      if (!deviceResult.ok || !deviceResult.data) {
        showError('reg-error', 'Account created but device registration failed. Please login.');
        return;
      }
      deviceId = deviceResult.data.device.id;
    }

    // 5. Persist session
    await saveToStorage({
      jwt_token: token, user_id: user.id, user_email: user.email,
      device_id: deviceId, device_name: finalDeviceName,
      is_logged_in: true, sync_count: 0,
    });
    await saveMasterKey(masterKey);

    // 6. Tell background to start syncing
    chrome.runtime.sendMessage({ type: 'START_SYNC' });

    // 7. Show recovery key screen BEFORE dashboard
    //    User must acknowledge they've saved the code
    showRecoveryScreen(recoveryCode, email);

  } catch (err) {
    showError('reg-error', err instanceof Error ? err.message : 'Unexpected error.');
  } finally {
    setLoading(btn, false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECOVERY KEY SCREEN
//
// Shown once after registration. Displays the plaintext recovery code,
// lets user copy it or download it, and requires a checkbox before continuing.
// The code is never stored — this is the only time it's visible.
// ─────────────────────────────────────────────────────────────────────────────

function showRecoveryScreen(recoveryCode: string, email: string) {
  showScreen('screen-recovery');

  // Display the code
  el('recovery-code-text').textContent = recoveryCode;

  // Copy button
  const copyBtn = el('btn-copy-recovery');
  const copyLabel = el('copy-label');
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(recoveryCode);
    copyLabel.textContent = '✓ Copied';
    copyBtn.style.color = 'var(--accent)';
    setTimeout(() => { copyLabel.textContent = 'Copy'; copyBtn.style.color = ''; }, 2000);
  });

  // Download button — creates a .txt file with the code
  el('btn-download-recovery').addEventListener('click', () => {
    const content = [
      'VaultTabs Recovery Key',
      '======================',
      '',
      `Account: ${email}`,
      `Date:    ${new Date().toLocaleDateString()}`,
      '',
      `Recovery Key: ${recoveryCode}`,
      '',
      'IMPORTANT:',
      '- This is the only way to recover your account if you forget your password.',
      '- Store this in a password manager, printed document, or secure note.',
      '- The VaultTabs server does NOT have a copy of this code.',
      '- Delete this file after storing the key somewhere safe.',
    ].join('\n');

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vaulttabs-recovery-key-${email.split('@')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Checkbox gates the Continue button
  const checkbox = el<HTMLInputElement>('recovery-saved-check');
  const continueBtn = el<HTMLButtonElement>('btn-recovery-continue');

  checkbox.addEventListener('change', () => {
    continueBtn.disabled = !checkbox.checked;
  });

  continueBtn.addEventListener('click', async () => {
    // Proceed to dashboard — sync is already running
    showDashboard(await loadFromStorage());
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogin(e: Event) {
  e.preventDefault();
  hideError('login-error');

  const email = el<HTMLInputElement>('login-email').value.trim();
  const password = el<HTMLInputElement>('login-password').value;
  const deviceName = el<HTMLInputElement>('login-device-name').value.trim() || getDeviceName();
  const btn = el<HTMLButtonElement>('btn-login');

  setLoading(btn, true);
  try {
    await doLogin(email, password, 'login-error', deviceName);
  } finally {
    setLoading(btn, false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RE-LOGIN (session expired — master key missing from IndexedDB)
// ─────────────────────────────────────────────────────────────────────────────

async function handleRelogin(e: Event) {
  e.preventDefault();
  hideError('relogin-error');

  const email = el<HTMLInputElement>('relogin-email').value.trim();
  const password = el<HTMLInputElement>('relogin-password').value;
  const btn = el<HTMLButtonElement>('btn-relogin');

  setLoading(btn, true);
  try {
    // Relogin implies we already have a device_id in storage
    const storage = await loadFromStorage();
    await doLogin(email, password, 'relogin-error', storage.device_name);
  } finally {
    setLoading(btn, false);
  }
}

/**
 * Shared login logic used by both the login form and re-login form.
 * 1. Call /auth/login → get token + encrypted master key + salt
 * 2. Derive wrapping key from password + salt
 * 3. Decrypt master key locally
 * 4. Register as a device
 * 5. Save everything + show dashboard
 */
async function doLogin(email: string, password: string, errorElId: string, customDeviceName?: string) {
  const result = await apiLogin(email, password);
  if (!result.ok || !result.data) {
    showError(errorElId, result.error || 'Login failed. Check email and password.');
    return;
  }

  const { token, user, crypto } = result.data;
  if (!crypto) { showError(errorElId, 'Server error: missing crypto data.'); return; }

  let masterKey: CryptoKey;
  try {
    const wrappingKey = await deriveWrappingKey(password, crypto.salt);
    masterKey = await decryptMasterKey(crypto.encrypted_master_key, crypto.master_key_iv, wrappingKey);
  } catch {
    showError(errorElId, 'Decryption failed. Wrong password?');
    return;
  }

  await saveToStorage({ jwt_token: token, user_id: user.id, user_email: user.email });

  // ── Device registration ──────────────────────────────────────────────────
  // IMPORTANT: Only register a new device if we don't already have a device_id.
  // During development, the extension reloads frequently. Without this check,
  // every reload creates a new device entry in the database, causing stale
  // "ghost devices" to appear in the PWA.
  //
  // Priority order:
  //   1. Use existing device_id from storage (most common — extension reloaded)
  //   2. Register new device (first login on this browser)
  const existing = await loadFromStorage();
  let deviceId = existing.device_id;
  let deviceName = customDeviceName || existing.device_name || getDeviceName();

  if (!deviceId) {
    // First time on this browser — register a new device
    const deviceResult = await apiRegisterDevice(deviceName);
    if (!deviceResult.ok || !deviceResult.data) {
      showError(errorElId, 'Login ok but device registration failed. Try again.');
      return;
    }
    deviceId = deviceResult.data.device.id;
    deviceName = deviceResult.data.device.device_name;
  }

  await saveToStorage({
    jwt_token: token, user_id: user.id, user_email: user.email,
    device_id: deviceId, device_name: deviceName,
    is_logged_in: true, sync_count: 0, last_error: undefined,
  });
  await saveMasterKey(masterKey);

  chrome.runtime.sendMessage({ type: 'START_SYNC' });
  showDashboard(await loadFromStorage());
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogout() {
  chrome.runtime.sendMessage({ type: 'STOP_SYNC' });
  await clearStorage();
  await clearMasterKey();
  showScreen('screen-auth');
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────

// Auth tab toggle
el('btn-show-register').addEventListener('click', () => {
  el('btn-show-register').classList.add('active');
  el('btn-show-login').classList.remove('active');
  el('form-register').classList.remove('hidden');
  el('form-login').classList.add('hidden');
});
el('btn-show-login').addEventListener('click', () => {
  el('btn-show-login').classList.add('active');
  el('btn-show-register').classList.remove('active');
  el('form-login').classList.remove('hidden');
  el('form-register').classList.add('hidden');
});

el('form-register').addEventListener('submit', handleRegister);
el('form-login').addEventListener('submit', handleLogin);
el('form-relogin').addEventListener('submit', handleRelogin);
el('btn-logout').addEventListener('click', handleLogout);

// Live updates from background worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SYNC_COMPLETE') {
    const dashboard = document.getElementById('screen-dashboard');
    if (dashboard && !dashboard.classList.contains('hidden')) {
      refreshDashboard();
    }
  }

  if (message.type === 'RESTORE_COMPLETE') {
    const toast = el('restore-toast');
    el('restore-toast-text').textContent = `✓ ${message.tabCount} tabs restored to desktop`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 4000);
    const dashboard = document.getElementById('screen-dashboard');
    if (dashboard && !dashboard.classList.contains('hidden')) refreshDashboard();
  }
});

// ── RENAME DEVICE ────────────────────────────────────────────────────────────

el('stat-device-box').addEventListener('click', async () => {
  const storage = await loadFromStorage();
  const input = el<HTMLInputElement>('rename-input');
  input.value = storage.device_name || '';
  el('rename-overlay').classList.remove('hidden');
  hideError('rename-error');
  input.focus();
});

el('btn-cancel-rename').addEventListener('click', () => {
  el('rename-overlay').classList.add('hidden');
});

el('btn-save-rename').addEventListener('click', handleRenameDevice);

el('rename-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleRenameDevice();
  if (e.key === 'Escape') el('rename-overlay').classList.add('hidden');
});

async function handleRenameDevice() {
  const input = el<HTMLInputElement>('rename-input');
  const newName = input.value.trim();
  if (!newName) return;

  const btn = el<HTMLButtonElement>('btn-save-rename');
  const storage = await loadFromStorage();
  const deviceId = storage.device_id;

  if (!deviceId) return;

  setLoading(btn, true);
  hideError('rename-error');

  try {
    const result = await apiRenameDevice(deviceId, newName);
    if (!result.ok) {
      showError('rename-error', result.error || 'Failed to rename device');
      return;
    }

    // Update local storage and UI
    await saveToStorage({ device_name: newName });
    el('info-device').textContent = newName.length > 7
      ? newName.slice(0, 6) + '…' : newName;
    el('rename-overlay').classList.add('hidden');

  } catch (err) {
    showError('rename-error', 'An unexpected error occurred');
  } finally {
    setLoading(btn, false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

init();