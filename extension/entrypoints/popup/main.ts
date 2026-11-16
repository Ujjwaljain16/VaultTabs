/**
 * Popup UI. Screens: loading, auth (login/register), recovery key, re-login, main. The main
 * screen has three views: this browser's tabs, other devices, settings.
 *
 * All untrusted text (tab titles/URLs, device names, server messages) is inserted with
 * textContent / DOM APIs only.
 */

import {
  LIMITS,
  RESTORE_ERROR_MESSAGES,
  type Device,
  type RestoreErrorCode,
  type SnapshotWithDevice,
  type TabSnapshot,
} from '@vaulttabs/shared';
import { decryptSnapshot, encryptRestorePayload, isSafeTabUrl } from '@vaulttabs/shared/crypto';
import { browser, type Browser } from 'wxt/browser';
import { api, defaultDeviceName, errorMessage, SESSION_ENDED_MESSAGE } from '../../utils/api';
import { LegacyUpgradeConsentRequired, login, passwordStrength, register } from '../../utils/auth';
import { DASHBOARD_URL } from '../../utils/config';
import { normalizeDomainInput } from '../../utils/domains';
import { isBackgroundBroadcast, type PopupRequest, type SyncNowResponse } from '../../utils/messages';
import {
  getActiveSession,
  loadState,
  logout,
  patchState,
  type ActiveSession,
  type LocalState,
} from '../../utils/storage';
import { openUrlsInNewWindow } from '../../utils/tabs';

// ─── DOM helpers ───────────────────────────────────────────────────────────────────────────────

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} not found`);
  return e as T;
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string; type?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title !== undefined) node.title = props.title;
  if (props.type !== undefined) node.setAttribute('type', props.type);
  for (const c of children) if (c) node.append(c);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  send: ['m22 2-7 20-4-9-9-4Z', 'M22 2 11 13'],
  window: ['M3 5h18v14H3z', 'M3 9h18'],
} as const;

function icon(name: keyof typeof ICON_PATHS, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const SCREENS = [
  'screen-loading',
  'screen-auth',
  'screen-recovery',
  'screen-relogin',
  'screen-main',
] as const;
type ScreenId = (typeof SCREENS)[number];
let currentScreen: ScreenId = 'screen-loading';

function showScreen(id: ScreenId): void {
  for (const s of SCREENS) el(s).classList.toggle('hidden', s !== id);
  currentScreen = id;
}

function showError(id: string, msg: string): void {
  const e = el(id);
  e.textContent = msg;
  e.classList.remove('hidden');
}

function hideError(id: string): void {
  el(id).classList.add('hidden');
}

function setLoading(btn: HTMLButtonElement, loading: boolean): void {
  btn.disabled = loading;
  btn.querySelector('.btn-text')?.classList.toggle('hidden', loading);
  btn.querySelector('.btn-loading')?.classList.toggle('hidden', !loading);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, isError = false): void {
  const t = el('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function letterAvatar(url: string): HTMLElement {
  const letter =
    hostOf(url)
      .replace(/^www\./, '')
      .charAt(0) || '?';
  return h('div', { className: 'letter-avatar', text: letter });
}

/** Favicon for a LOCAL tab, from the browser's own tab data. */
function localFavicon(tab: Browser.tabs.Tab): HTMLElement {
  const src = tab.favIconUrl;
  if (src && (src.startsWith('data:image/') || isSafeTabUrl(src))) {
    const img = h('img', { className: 'tab-favicon' });
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = src;
    img.addEventListener('error', () => img.replaceWith(letterAvatar(tab.url ?? '')), { once: true });
    return img;
  }
  return letterAvatar(tab.url ?? '');
}

function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Email the user consented to upgrade (legacy v1 accounts); see utils/auth.ts. */
let legacyConsentEmail: string | null = null;

/** Runs login, handling the one-time legacy-upgrade consent (shown in `errorId`, confirmed by a second submit). */
async function loginWithConsent(
  email: string,
  password: string,
  deviceName: string | undefined,
  errorId: string,
  btn: HTMLButtonElement,
): Promise<boolean> {
  try {
    await login(email, password, deviceName, {
      allowLegacyUpgrade: legacyConsentEmail === email.toLowerCase(),
    });
    legacyConsentEmail = null;
    return true;
  } catch (err) {
    if (err instanceof LegacyUpgradeConsentRequired) {
      legacyConsentEmail = email.toLowerCase();
      showError(errorId, err.message);
      const text = btn.querySelector('.btn-text');
      if (text) text.textContent = 'Upgrade & Unlock';
      return false;
    }
    throw err;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── State ─────────────────────────────────────────────────────────────────────────────────────

let session: ActiveSession | null = null;

// ─── Startup / routing ─────────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  showScreen('screen-loading');
  const state = await loadState();
  if (state.token && state.user_id) {
    const active = await getActiveSession();
    if (active) return enterMain(active);
    return showRelogin(
      state.user_email ?? '',
      'The vault key is missing on this browser. Enter your master password to unlock it.',
    );
  }
  if (state.relogin_email) {
    return showRelogin(state.relogin_email, state.last_error ?? SESSION_ENDED_MESSAGE);
  }
  showAuth('login');
}

function showAuth(mode: 'login' | 'register', error?: string, email?: string): void {
  session = null;
  const name = defaultDeviceName();
  for (const id of ['login-device-name', 'reg-device-name']) {
    const input = el<HTMLInputElement>(id);
    if (!input.value) input.value = name;
  }
  if (email) el<HTMLInputElement>('login-email').value = email;
  setAuthMode(mode);
  hideError('login-error');
  hideError('reg-error');
  if (error) showError(mode === 'login' ? 'login-error' : 'reg-error', error);
  showScreen('screen-auth');
}

function setAuthMode(mode: 'login' | 'register'): void {
  el('btn-show-login').classList.toggle('active', mode === 'login');
  el('btn-show-register').classList.toggle('active', mode === 'register');
  el('form-login').classList.toggle('hidden', mode !== 'login');
  el('form-register').classList.toggle('hidden', mode !== 'register');
}

let reloginEmail = '';

function showRelogin(email: string, message: string): void {
  session = null;
  reloginEmail = email;
  el('relogin-desc').textContent = message;
  el('relogin-email-display').textContent = email;
  el<HTMLInputElement>('relogin-password').value = '';
  hideError('relogin-error');
  showScreen('screen-relogin');
  el('relogin-password').focus();
}

async function afterLogin(): Promise<void> {
  const active = await getActiveSession();
  if (!active) throw new Error('Could not start the session. Please try again.');
  enterMain(active);
}

// ─── Login / register / re-login ───────────────────────────────────────────────────────────────

async function handleLogin(e: Event): Promise<void> {
  e.preventDefault();
  hideError('login-error');
  const email = el<HTMLInputElement>('login-email').value.trim();
  const passwordInput = el<HTMLInputElement>('login-password');
  const deviceName = el<HTMLInputElement>('login-device-name').value.trim();
  if (!EMAIL_RE.test(email)) return showError('login-error', 'Enter a valid email address.');
  if (!passwordInput.value) return showError('login-error', 'Enter your password.');

  const btn = el<HTMLButtonElement>('btn-login');
  setLoading(btn, true);
  try {
    if (!(await loginWithConsent(email, passwordInput.value, deviceName, 'login-error', btn))) return;
    passwordInput.value = '';
    await afterLogin();
  } catch (err) {
    showError('login-error', errorMessage(err, 'Login failed.'));
  } finally {
    setLoading(btn, false);
  }
}

async function handleRelogin(e: Event): Promise<void> {
  e.preventDefault();
  hideError('relogin-error');
  const passwordInput = el<HTMLInputElement>('relogin-password');
  if (!passwordInput.value) return showError('relogin-error', 'Enter your password.');
  const btn = el<HTMLButtonElement>('btn-relogin');
  setLoading(btn, true);
  try {
    const { device_name } = await loadState();
    if (!(await loginWithConsent(reloginEmail, passwordInput.value, device_name, 'relogin-error', btn)))
      return;
    passwordInput.value = '';
    await afterLogin();
  } catch (err) {
    showError('relogin-error', errorMessage(err, 'Login failed.'));
  } finally {
    setLoading(btn, false);
  }
}

async function handleReloginSwitch(): Promise<void> {
  await logout();
  await patchState({ last_error: undefined });
  showAuth('login');
}

function updateStrength(): void {
  const pw = el<HTMLInputElement>('reg-password').value;
  const fill = el('reg-strength-fill');
  const label = el('reg-strength-label');
  if (!pw) {
    fill.className = '';
    label.textContent = `At least ${LIMITS.minPasswordChars} characters`;
    return;
  }
  const s = passwordStrength(pw);
  fill.className = `level-${s.level}`;
  label.textContent = s.label;
}

async function handleRegister(e: Event): Promise<void> {
  e.preventDefault();
  hideError('reg-error');
  const email = el<HTMLInputElement>('reg-email').value.trim();
  const passwordInput = el<HTMLInputElement>('reg-password');
  const confirmInput = el<HTMLInputElement>('reg-password-confirm');
  const password = passwordInput.value;
  const deviceName = el<HTMLInputElement>('reg-device-name').value.trim();

  if (!EMAIL_RE.test(email)) return showError('reg-error', 'Enter a valid email address.');
  if (password.length < LIMITS.minPasswordChars) {
    return showError('reg-error', `Use at least ${LIMITS.minPasswordChars} characters.`);
  }
  if (password.length > LIMITS.maxPasswordChars) return showError('reg-error', 'That password is too long.');
  if (password !== confirmInput.value) return showError('reg-error', 'Passwords do not match.');

  const btn = el<HTMLButtonElement>('btn-register');
  setLoading(btn, true);
  try {
    const result = await register(email, password, deviceName);
    passwordInput.value = '';
    confirmInput.value = '';
    updateStrength();
    showRecovery(result.recoveryCode, email, result.sessionError);
  } catch (err) {
    showError('reg-error', errorMessage(err, 'Registration failed.'));
  } finally {
    setLoading(btn, false);
  }
}

// ─── Recovery key screen (listeners are attached once, below) ──────────────────────────────────

let pendingRecovery: { code: string; email: string; sessionError?: string } | null = null;

function showRecovery(code: string, email: string, sessionError?: string): void {
  pendingRecovery = { code, email, sessionError };
  el('recovery-code-text').textContent = code;
  el<HTMLInputElement>('recovery-saved-check').checked = false;
  el<HTMLButtonElement>('btn-recovery-continue').disabled = true;
  el('btn-copy-recovery').textContent = 'COPY';
  if (sessionError) {
    showError(
      'recovery-session-error',
      `Your account was created, but this browser could not be set up (${sessionError}). Save the key, then log in.`,
    );
  } else {
    hideError('recovery-session-error');
  }
  showScreen('screen-recovery');
}

async function copyRecovery(): Promise<void> {
  if (!pendingRecovery) return;
  const btn = el('btn-copy-recovery');
  try {
    await navigator.clipboard.writeText(pendingRecovery.code);
    btn.textContent = 'COPIED';
  } catch {
    btn.textContent = 'FAILED';
  }
  setTimeout(() => (btn.textContent = 'COPY'), 2000);
}

function downloadRecovery(): void {
  if (!pendingRecovery) return;
  const { code, email } = pendingRecovery;
  const content = [
    'VaultTabs Recovery Key',
    '======================',
    '',
    `Account: ${email}`,
    `Created: ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Recovery Key: ${code}`,
    '',
    'This key is the only way to recover your data if you forget your password.',
    'Store it in a password manager or print it, then delete this file.',
    'The VaultTabs server never sees this key.',
    '',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  const a = h('a');
  a.href = url;
  a.download = 'vaulttabs-recovery-key.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function finishRecovery(): Promise<void> {
  const pending = pendingRecovery;
  pendingRecovery = null;
  el('recovery-code-text').textContent = '';
  const active = await getActiveSession();
  if (active) enterMain(active);
  else
    showAuth('login', pending?.sessionError ? 'Account created. Please log in.' : undefined, pending?.email);
}

// ─── Main screen ───────────────────────────────────────────────────────────────────────────────

type ViewId = 'view-tabs' | 'view-devices' | 'view-settings';
let currentView: ViewId = 'view-tabs';

function enterMain(active: ActiveSession): void {
  session = active;
  el('user-email-display').textContent = active.email;
  el('settings-email').textContent = active.email;
  el('info-device').textContent = active.deviceName || '—';
  el('btn-open-dashboard').classList.toggle('hidden', !DASHBOARD_URL);
  devicesLoaded = false;
  showScreen('screen-main');
  showView('view-tabs');
}

function showView(view: ViewId): void {
  currentView = view;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.nav-btn')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  for (const id of ['view-tabs', 'view-devices', 'view-settings'] as const) {
    el(id).classList.toggle('hidden', id !== view);
  }
  if (view === 'view-tabs') void refreshTabsView();
  if (view === 'view-devices' && !devicesLoaded) void loadOtherDevices();
  if (view === 'view-settings') void renderSettings();
}

// ─── View: this browser ────────────────────────────────────────────────────────────────────────

function renderStatus(state: LocalState): void {
  const dot = el('status-dot');
  const text = el('status-text');
  const detail = el('status-detail');
  const count = el('sync-count');
  const banner = el('error-banner');

  count.classList.toggle('hidden', !state.sync_count);
  count.textContent = state.sync_count ? `↑ ${state.sync_count}` : '';
  banner.classList.toggle('hidden', !state.last_error);
  banner.textContent = state.last_error ?? '';

  if (state.sync_paused) {
    dot.className = 'status-dot';
    text.textContent = 'Sync paused';
    detail.textContent = 'Resume in Settings';
  } else if (state.last_error) {
    dot.className = 'status-dot error';
    text.textContent = 'Sync error';
    detail.textContent = 'Will retry automatically';
  } else if (state.last_sync_at) {
    dot.className = 'status-dot synced';
    text.textContent = 'Synced';
    detail.textContent = `${timeAgo(state.last_sync_at)} · ${state.last_tab_count ?? 0} tabs`;
  } else {
    dot.className = 'status-dot syncing';
    text.textContent = 'Waiting for first sync';
    detail.textContent = 'Changes upload a few seconds after you switch pages';
  }
}

async function refreshTabsView(): Promise<void> {
  renderStatus(await loadState());
  const [tabs, windows] = await Promise.all([browser.tabs.query({}), browser.windows.getAll()]);
  const httpTabs = tabs
    .filter(t => !t.incognito && isSafeTabUrl(t.url))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.windowId - b.windowId || a.index - b.index);
  el('info-tab-count').textContent = String(httpTabs.length);
  el('info-window-count').textContent = String(windows.filter(w => !w.incognito).length);
  renderLocalTabs(httpTabs);
}

function renderLocalTabs(tabs: Browser.tabs.Tab[]): void {
  const list = el('tab-list');
  list.replaceChildren();
  if (tabs.length === 0) {
    list.append(h('div', { className: 'tab-list-empty', text: 'No web pages open' }));
    return;
  }
  const MAX = 200;
  for (const tab of tabs.slice(0, MAX)) {
    const url = tab.url as string;
    const send = h(
      'button',
      { className: 'btn-send-tab', title: 'Send to another device', type: 'button' },
      icon('send'),
    );
    send.addEventListener('click', ev => {
      ev.stopPropagation();
      openDevicePicker([url], tab.title || hostOf(url));
    });
    const item = h(
      'div',
      { className: 'tab-item', title: url },
      localFavicon(tab),
      h(
        'div',
        { className: 'tab-info' },
        h('div', { className: 'tab-title', text: tab.title || 'Untitled' }),
        h('div', { className: 'tab-url', text: hostOf(url) }),
      ),
      send,
      tab.active && h('div', { className: 'tab-active-dot', title: 'Active tab' }),
    );
    item.addEventListener('click', () => {
      if (tab.id !== undefined) void browser.tabs.update(tab.id, { active: true });
      void browser.windows.update(tab.windowId, { focused: true });
    });
    list.append(item);
  }
  if (tabs.length > MAX)
    list.append(h('div', { className: 'tab-list-more', text: `+ ${tabs.length - MAX} more` }));
}

async function handleSyncNow(): Promise<void> {
  const btn = el<HTMLButtonElement>('btn-sync-now');
  btn.disabled = true;
  try {
    const request: PopupRequest = { type: 'SYNC_NOW' };
    const res = (await browser.runtime.sendMessage(request)) as SyncNowResponse | undefined;
    const state = await loadState();
    if (state.sync_paused) toast('Syncing is paused.');
    else if (res?.ok) toast('Synced.');
    else toast(res?.error ?? 'Sync failed.', true);
  } catch {
    toast('Sync failed.', true);
  } finally {
    btn.disabled = false;
    void refreshTabsView();
  }
}

async function handleSendWindow(): Promise<void> {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const urls = tabs
    .filter(t => !t.incognito)
    .map(t => t.url)
    .filter(isSafeTabUrl);
  if (urls.length === 0) return toast('No web pages in this window.', true);
  openDevicePicker(urls, `${urls.length} tab${urls.length === 1 ? '' : 's'} from this window`);
}

// ─── Send to device ────────────────────────────────────────────────────────────────────────────

let pickerToken = 0;

async function openDevicePicker(urls: string[], label: string): Promise<void> {
  const token = ++pickerToken;
  const list = el('device-picker-list');
  el('device-picker-desc').textContent = label;
  list.replaceChildren(h('div', { className: 'spinner spinner-center' }));
  el('device-picker-overlay').classList.remove('hidden');

  let devices: Device[];
  try {
    devices = (await api.devices()).devices.filter(d => d.id !== session?.deviceId);
  } catch (err) {
    if (token !== pickerToken) return;
    list.replaceChildren(
      h('div', { className: 'error-msg', text: errorMessage(err, 'Could not load devices.') }),
    );
    return;
  }
  if (token !== pickerToken) return;
  if (devices.length === 0) {
    list.replaceChildren(
      h('div', {
        className: 'picker-empty',
        text: 'No other devices yet. Install VaultTabs in another browser and log in.',
      }),
    );
    return;
  }
  list.replaceChildren(
    ...devices.map(device => {
      const btn = h(
        'button',
        { className: 'picker-item', type: 'button' },
        h('span', { className: 'picker-icon', text: '◉' }),
        h('div', { className: 'picker-name', text: device.device_name }),
      );
      btn.addEventListener('click', () => void sendToDevice(device, urls));
      return btn;
    }),
  );
}

function closeDevicePicker(): void {
  pickerToken++;
  el('device-picker-overlay').classList.add('hidden');
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

function stopPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

async function sendToDevice(device: Device, urls: string[]): Promise<void> {
  closeDevicePicker();
  if (!session) return;
  renderSendStatus({ phase: 'sending' });
  try {
    const payload = await encryptRestorePayload(
      { urls: urls.slice(0, LIMITS.maxRestoreUrls) },
      session.masterKey,
      {
        userId: session.userId,
        targetDeviceId: device.id,
      },
    );
    const created = await api.createRestore({ target_device_id: device.id, ...payload });
    pollRestore(created.request_id, device.device_name);
  } catch (err) {
    renderSendStatus({ phase: 'error', message: errorMessage(err, 'Could not send.') });
  }
}

function pollRestore(requestId: string, deviceName: string): void {
  stopPolling();
  renderSendStatus({ phase: 'waiting', deviceName });
  const started = Date.now();
  pollTimer = setInterval(async () => {
    if (Date.now() - started > 90_000) {
      stopPolling();
      renderSendStatus({
        phase: 'error',
        message: `${deviceName} did not respond. Is that browser open and logged in?`,
      });
      return;
    }
    try {
      const { request } = await api.restoreStatus(requestId);
      if (request.status === 'completed') {
        stopPolling();
        renderSendStatus({ phase: 'success', deviceName });
        setTimeout(() => el('restore-overlay').classList.add('hidden'), 3000);
      } else if (request.status === 'failed') {
        stopPolling();
        const code: RestoreErrorCode = request.error_code ?? 'unknown';
        renderSendStatus({
          phase: 'error',
          message: RESTORE_ERROR_MESSAGES[code] ?? RESTORE_ERROR_MESSAGES.unknown,
        });
      } else if (request.status === 'expired') {
        stopPolling();
        renderSendStatus({
          phase: 'error',
          message: 'The request expired before the other browser picked it up.',
        });
      }
    } catch {
      // Transient; keep polling until the timeout.
    }
  }, 2000);
}

type SendStatus =
  | { phase: 'sending' }
  | { phase: 'waiting'; deviceName: string }
  | { phase: 'success'; deviceName: string }
  | { phase: 'error'; message: string };

function renderSendStatus(status: SendStatus): void {
  const overlay = el('restore-overlay');
  const content = el('restore-status-content');
  overlay.classList.remove('hidden');
  const close = (label: string) => {
    const btn = h('button', { className: 'restore-cancel-btn', text: label, type: 'button' });
    btn.addEventListener('click', () => {
      stopPolling();
      overlay.classList.add('hidden');
    });
    return btn;
  };

  switch (status.phase) {
    case 'sending':
      content.replaceChildren(
        h('div', { className: 'restore-spinner' }),
        h('div', { className: 'restore-title', text: 'Encrypting & sending...' }),
      );
      break;
    case 'waiting':
      content.replaceChildren(
        h('div', { className: 'restore-spinner' }),
        h('div', { className: 'restore-title', text: 'Waiting for device' }),
        h(
          'div',
          { className: 'restore-desc' },
          'Opening on ',
          h('strong', { text: status.deviceName }),
          '...',
        ),
        h(
          'div',
          { className: 'restore-pulse' },
          h('div', { className: 'restore-dot' }),
          h('div', { className: 'restore-dot' }),
          h('div', { className: 'restore-dot' }),
        ),
        close('Close'),
      );
      break;
    case 'success':
      content.replaceChildren(
        h('div', { className: 'restore-success-icon', text: '✓' }),
        h('div', { className: 'restore-title', text: 'Sent' }),
        h('div', { className: 'restore-desc' }, 'Opened on ', h('strong', { text: status.deviceName }), '.'),
      );
      break;
    case 'error':
      content.replaceChildren(
        h('div', { className: 'restore-error-icon', text: '✕' }),
        h('div', { className: 'restore-title', text: 'Not delivered' }),
        h('div', { className: 'restore-desc', text: status.message }),
        close('Dismiss'),
      );
      break;
  }
}

// ─── View: other devices ───────────────────────────────────────────────────────────────────────

interface RemoteDevice {
  deviceId: string;
  name: string;
  lastSeen: string | Date;
  capturedAt: string | Date;
  tabs: TabSnapshot[] | null;
  error?: string;
}

let devicesLoaded = false;
let remoteDevices: RemoteDevice[] = [];
const expanded = new Set<string>();

async function decryptRemote(s: SnapshotWithDevice, active: ActiveSession): Promise<RemoteDevice> {
  const base = {
    deviceId: s.device_id,
    name: s.device_name,
    lastSeen: s.last_seen,
    capturedAt: s.captured_at,
  };
  try {
    const tabs = await decryptSnapshot(s.encrypted_blob, s.iv, active.masterKey, s.enc_version, {
      userId: active.userId,
      deviceId: s.device_id,
      capturedAt: s.captured_at,
    });
    return { ...base, tabs: tabs.filter(t => isSafeTabUrl(t.url)) };
  } catch {
    return { ...base, tabs: null, error: 'Could not decrypt this snapshot' };
  }
}

async function loadOtherDevices(): Promise<void> {
  const active = session;
  if (!active) return;
  const status = el('devices-status');
  status.textContent = 'Loading & decrypting...';
  status.classList.remove('hidden');
  el('device-list').replaceChildren();
  try {
    const { snapshots } = await api.latestSnapshots();
    const others = snapshots.filter(s => s.device_id !== active.deviceId);
    remoteDevices = (await Promise.all(others.map(s => decryptRemote(s, active)))).sort(
      (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
    );
    devicesLoaded = true;
    renderOtherDevices();
  } catch (err) {
    status.textContent = errorMessage(err, 'Could not load devices.');
  }
}

function renderOtherDevices(): void {
  const query = el<HTMLInputElement>('device-search').value.trim().toLowerCase();
  const list = el('device-list');
  const status = el('devices-status');
  list.replaceChildren();

  if (remoteDevices.length === 0) {
    status.textContent = 'No other devices have synced yet.';
    status.classList.remove('hidden');
    return;
  }

  let shown = 0;
  for (const device of remoteDevices) {
    const tabs = device.tabs ?? [];
    const matches = query
      ? tabs.filter(t => t.title.toLowerCase().includes(query) || t.url.toLowerCase().includes(query))
      : tabs;
    if (query && matches.length === 0) continue;
    shown++;
    list.append(renderDeviceCard(device, matches, Boolean(query)));
  }
  status.textContent = shown === 0 ? 'No matching tabs.' : '';
  status.classList.toggle('hidden', shown > 0);
}

function renderDeviceCard(device: RemoteDevice, tabs: TabSnapshot[], searching: boolean): HTMLElement {
  const isOpen = searching || expanded.has(device.deviceId);
  const total = device.tabs?.length ?? 0;
  const sub = device.error
    ? h('div', { className: 'device-sub error', text: device.error })
    : h('div', {
        className: 'device-sub',
        text: `${searching ? `${tabs.length}/${total}` : total} tabs · seen ${timeAgo(device.lastSeen)}`,
      });

  const head = h(
    'button',
    { className: 'device-head', type: 'button', title: `Snapshot from ${timeAgo(device.capturedAt)}` },
    h('span', { className: 'device-caret', text: '▶' }),
    h('div', { className: 'device-meta' }, h('div', { className: 'device-name', text: device.name }), sub),
  );
  const openAll = h('button', {
    className: 'btn-chip',
    text: 'Open all',
    type: 'button',
    title: 'Open these tabs in a new window',
  });
  openAll.disabled = total === 0;
  openAll.addEventListener('click', async () => {
    const n = await openUrlsInNewWindow((device.tabs ?? []).map(t => t.url));
    if (n === 0) toast('Nothing to open.', true);
  });

  // Remove a stale/duplicate device (and its snapshots). Two clicks to confirm.
  const remove = h('button', {
    className: 'btn-chip btn-chip-danger',
    text: '✕',
    type: 'button',
    title: 'Remove this device and its snapshots',
  });
  let armed: ReturnType<typeof setTimeout> | undefined;
  remove.addEventListener('click', async () => {
    if (!armed) {
      remove.textContent = 'Remove?';
      armed = setTimeout(() => {
        armed = undefined;
        remove.textContent = '✕';
      }, 4000);
      return;
    }
    clearTimeout(armed);
    remove.disabled = true;
    try {
      await api.deleteDevice(device.deviceId);
      remoteDevices = remoteDevices.filter(d => d.deviceId !== device.deviceId);
      renderOtherDevices();
      toast(`Removed ${device.name}.`);
    } catch (err) {
      remove.disabled = false;
      remove.textContent = '✕';
      armed = undefined;
      toast(errorMessage(err, 'Could not remove the device.'), true);
    }
  });

  const card = h(
    'div',
    { className: `device-card${isOpen ? ' open' : ''}` },
    h('div', { className: 'device-head-row' }, head, openAll, remove),
  );
  head.addEventListener('click', () => {
    if (expanded.has(device.deviceId)) expanded.delete(device.deviceId);
    else expanded.add(device.deviceId);
    renderOtherDevices();
  });

  if (isOpen && !device.error) {
    const list = h('div', { className: 'tab-list' });
    if (tabs.length === 0) list.append(h('div', { className: 'tab-list-empty', text: 'No tabs' }));
    for (const tab of tabs) {
      const item = h(
        'div',
        { className: 'tab-item', title: tab.url },
        letterAvatar(tab.url),
        h(
          'div',
          { className: 'tab-info' },
          h('div', { className: 'tab-title', text: tab.title || 'Untitled' }),
          h('div', { className: 'tab-url', text: hostOf(tab.url) }),
        ),
        tab.pinned && h('span', { className: 'pin-badge', text: 'PIN' }),
      );
      item.addEventListener('click', () => {
        if (isSafeTabUrl(tab.url)) void browser.tabs.create({ url: tab.url });
      });
      list.append(item);
    }
    card.append(h('div', { className: 'device-body' }, list));
  }
  return card;
}

// ─── View: settings ────────────────────────────────────────────────────────────────────────────

const MAX_EXCLUDED_DOMAINS = 500;

async function renderSettings(): Promise<void> {
  const state = await loadState();
  el<HTMLInputElement>('setting-pause').checked = Boolean(state.sync_paused);
  renderDomainList(state.excluded_domains ?? []);
}

function renderDomainList(domains: string[]): void {
  const list = el('domain-list');
  list.replaceChildren();
  if (domains.length === 0) {
    list.append(h('li', { className: 'domain-empty', text: 'No domains excluded.' }));
    return;
  }
  for (const domain of domains) {
    const remove = h('button', {
      className: 'domain-remove',
      text: '✕',
      title: `Remove ${domain}`,
      type: 'button',
    });
    remove.addEventListener('click', async () => {
      const { excluded_domains = [] } = await loadState();
      const next = excluded_domains.filter(d => d !== domain);
      await patchState({ excluded_domains: next });
      renderDomainList(next);
    });
    list.append(h('li', {}, h('span', { text: domain }), remove));
  }
}

async function handleAddDomain(e: Event): Promise<void> {
  e.preventDefault();
  hideError('domain-error');
  const input = el<HTMLInputElement>('domain-input');
  const domain = normalizeDomainInput(input.value);
  if (!domain) return showError('domain-error', 'Enter a domain like bank.com.');
  const { excluded_domains = [] } = await loadState();
  if (excluded_domains.includes(domain)) return showError('domain-error', `${domain} is already excluded.`);
  if (excluded_domains.length >= MAX_EXCLUDED_DOMAINS) return showError('domain-error', 'Too many domains.');
  const next = [...excluded_domains, domain].sort();
  await patchState({ excluded_domains: next });
  input.value = '';
  renderDomainList(next);
}

async function handleLogout(): Promise<void> {
  stopPolling();
  await logout();
  showAuth('login');
}

// ─── Rename device ─────────────────────────────────────────────────────────────────────────────

function openRename(): void {
  el<HTMLInputElement>('rename-input').value = session?.deviceName ?? '';
  hideError('rename-error');
  el('rename-overlay').classList.remove('hidden');
  el('rename-input').focus();
}

async function handleRename(e: Event): Promise<void> {
  e.preventDefault();
  if (!session) return;
  const name = el<HTMLInputElement>('rename-input').value.trim();
  if (!name) return showError('rename-error', 'Enter a name.');
  if (name.length > LIMITS.maxDeviceNameChars) return showError('rename-error', 'That name is too long.');
  const btn = el<HTMLButtonElement>('btn-save-rename');
  setLoading(btn, true);
  hideError('rename-error');
  try {
    const { device } = await api.renameDevice(session.deviceId, name);
    await patchState({ device_name: device.device_name });
    session = { ...session, deviceName: device.device_name };
    el('info-device').textContent = device.device_name;
    el('rename-overlay').classList.add('hidden');
  } catch (err) {
    showError('rename-error', errorMessage(err, 'Could not rename the device.'));
  } finally {
    setLoading(btn, false);
  }
}

// ─── Wiring (runs once) ────────────────────────────────────────────────────────────────────────

el('btn-show-login').addEventListener('click', () => setAuthMode('login'));
el('btn-show-register').addEventListener('click', () => setAuthMode('register'));
el('form-login').addEventListener('submit', e => void handleLogin(e));
el('form-register').addEventListener('submit', e => void handleRegister(e));
el('reg-password').addEventListener('input', updateStrength);
el('form-relogin').addEventListener('submit', e => void handleRelogin(e));
el('btn-relogin-switch').addEventListener('click', () => void handleReloginSwitch());

el('btn-copy-recovery').addEventListener('click', () => void copyRecovery());
el('btn-download-recovery').addEventListener('click', downloadRecovery);
el<HTMLInputElement>('recovery-saved-check').addEventListener('change', e => {
  el<HTMLButtonElement>('btn-recovery-continue').disabled = !(e.target as HTMLInputElement).checked;
});
el('btn-recovery-continue').addEventListener('click', () => void finishRecovery());

for (const btn of document.querySelectorAll<HTMLButtonElement>('.nav-btn')) {
  btn.addEventListener('click', () => showView(btn.dataset.view as ViewId));
}
el('btn-sync-now').addEventListener('click', () => void handleSyncNow());
el('btn-send-window').addEventListener('click', () => void handleSendWindow());
el('stat-device-box').addEventListener('click', openRename);
el('form-rename').addEventListener('submit', e => void handleRename(e));
el('btn-cancel-rename').addEventListener('click', () => el('rename-overlay').classList.add('hidden'));
el('btn-cancel-device-picker').addEventListener('click', closeDevicePicker);

el('device-search').addEventListener('input', renderOtherDevices);
el('btn-refresh-devices').addEventListener('click', () => void loadOtherDevices());

el<HTMLInputElement>('setting-pause').addEventListener('change', e => {
  void patchState({ sync_paused: (e.target as HTMLInputElement).checked });
});
el('form-domain').addEventListener('submit', e => void handleAddDomain(e));
el('btn-open-dashboard').addEventListener('click', () => {
  if (DASHBOARD_URL) void browser.tabs.create({ url: DASHBOARD_URL });
});
el('btn-logout').addEventListener('click', () => void handleLogout());

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const id of ['rename-overlay', 'device-picker-overlay']) el(id).classList.add('hidden');
  pickerToken++;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Session ended elsewhere (401 from the server, or logout in another popup).
  if (changes.token && !changes.token.newValue && currentScreen === 'screen-main') {
    stopPolling();
    void init();
    return;
  }
  if (currentScreen === 'screen-main' && currentView === 'view-tabs') {
    const keys: (keyof LocalState)[] = [
      'last_sync_at',
      'last_error',
      'sync_count',
      'sync_paused',
      'last_tab_count',
    ];
    if (keys.some(k => k in changes)) void loadState().then(renderStatus);
  }
});

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isBackgroundBroadcast(message)) return;
  if (message.type === 'RESTORE_COMPLETE')
    toast(`Opened ${message.tabCount} tab${message.tabCount === 1 ? '' : 's'} from another device`);
  if (message.type === 'SYNC_COMPLETE' && currentScreen === 'screen-main' && currentView === 'view-tabs') {
    void refreshTabsView();
  }
});

setInterval(() => {
  if (currentScreen === 'screen-main' && currentView === 'view-tabs') void loadState().then(renderStatus);
}, 15_000);

updateStrength();
void init();
