/**
 * "Real browsers" for the suite: each ExtBrowser is its own Chromium profile (persistent context,
 * separate user-data dir) with the built extension loaded, like the owner's "Personal Chrome" and
 * "Brave personal". Tests drive the real popup (popup.html opened in a tab), real tabs on the local
 * test site, and the real background service worker.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chromium,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test';
import { EXTENSION_DIR, EXTENSION_ID, HEADED, POPUP_URL, SITE_URL } from './env';

let emailCounter = 0;
export function uniqueEmail(prefix = 'user'): string {
  emailCounter++;
  return `${prefix}-${Date.now().toString(36)}-${emailCounter}@example.com`;
}

export const PASSWORD = 'correct horse battery staple';

/** A page on the local test site. */
export function siteUrl(slug: string, title?: string): string {
  const url = `${SITE_URL}/p/${encodeURIComponent(slug)}`;
  return title === undefined ? url : `${url}?title=${encodeURIComponent(title)}`;
}

export class ExtBrowser {
  private constructor(
    readonly name: string,
    readonly context: BrowserContext,
    readonly userDataDir: string,
  ) {}

  static async launch(name: string, options: { userDataDir?: string } = {}): Promise<ExtBrowser> {
    const userDataDir =
      options.userDataDir ??
      fs.mkdtempSync(path.join(os.tmpdir(), `vaulttabs-e2e-${name.replace(/\W+/g, '-')}-`));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // The full Chromium build ("new headless") supports extensions; the headless shell does not.
      channel: 'chromium',
      headless: !HEADED,
      viewport: { width: 1100, height: 800 },
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    const browser = new ExtBrowser(name, context, userDataDir);
    await browser.worker();
    return browser;
  }

  /** The extension's background service worker (waits for it to (re)start). */
  async worker(timeout = 15_000): Promise<Worker> {
    const isOurs = (w: Worker) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`);
    const existing = this.context.serviceWorkers().find(isOurs);
    if (existing) return existing;
    return this.context.waitForEvent('serviceworker', { predicate: isOurs, timeout });
  }

  /** Opens a site page in a new tab of this browser and waits for its title. */
  async openTab(slug: string, title?: string): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(siteUrl(slug, title));
    return page;
  }

  /** Current http(s) tab URLs in this browser. */
  httpUrls(): string[] {
    return this.context
      .pages()
      .map(p => p.url())
      .filter(u => u.startsWith('http'));
  }

  /** Waits until a tab with exactly `url` is open in this browser and returns it. */
  async waitForTab(url: string, timeout = 30_000): Promise<Page> {
    let found: Page | undefined;
    await expect
      .poll(
        () => {
          found = this.context.pages().find(p => p.url() === url);
          return Boolean(found);
        },
        { timeout, message: `${this.name}: tab ${url} did not open` },
      )
      .toBe(true);
    return found!;
  }

  countTabs(url: string): number {
    return this.context.pages().filter(p => p.url() === url).length;
  }

  /** Opens the popup UI in a tab of this browser. */
  async popup(): Promise<Popup> {
    const page = await this.context.newPage();
    await page.goto(POPUP_URL);
    await expect(page.locator('#screen-loading')).toBeHidden();
    return new Popup(page, this);
  }

  /** chrome.storage.local of the extension (evaluated in an extension page). */
  async storage(): Promise<Record<string, unknown>> {
    return this.inExtensionPage(() => chrome.storage.local.get(null));
  }

  /** Runs `fn` inside a temporary extension page (has the chrome.* APIs, no SW needed). */
  async inExtensionPage<T>(fn: () => Promise<T> | T): Promise<T> {
    const page = await this.context.newPage();
    try {
      await page.goto(POPUP_URL);
      return await page.evaluate(fn);
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }

  /** Close and delete the profile (an uninstall + wipe). */
  async destroy(): Promise<void> {
    await this.close();
    fs.rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export class Popup {
  constructor(
    readonly page: Page,
    readonly browser: ExtBrowser,
  ) {}

  locator(selector: string): Locator {
    return this.page.locator(selector);
  }

  async reload(): Promise<void> {
    await this.page.reload();
    await expect(this.page.locator('#screen-loading')).toBeHidden();
  }

  /**
   * Reopens the popup and, if it still shows the vault, makes it call the server (Devices view).
   * The background may already have ended the session by itself, which is fine too.
   */
  async pokeServer(): Promise<void> {
    await this.reload();
    if (await this.page.locator('#screen-main').isVisible()) {
      await this.page.click('.nav-btn[data-view="view-devices"]', { timeout: 3000 }).catch(() => {});
    }
  }

  async fillRegister(opts: { email: string; password: string; confirm?: string; deviceName?: string }) {
    const p = this.page;
    await p.click('#btn-show-register');
    await p.fill('#reg-email', opts.email);
    await p.fill('#reg-password', opts.password);
    await p.fill('#reg-password-confirm', opts.confirm ?? opts.password);
    if (opts.deviceName !== undefined) await p.fill('#reg-device-name', opts.deviceName);
    await p.click('#btn-register');
  }

  /** Registers, saves the recovery code (returned) and enters the main screen. */
  async register(email: string, deviceName: string, password = PASSWORD): Promise<string> {
    await this.fillRegister({ email, password, deviceName });
    await expect(this.page.locator('#screen-recovery')).toBeVisible({ timeout: 30_000 });
    const code = (await this.page.locator('#recovery-code-text').textContent())!.trim();
    await this.page.check('#recovery-saved-check');
    await this.page.click('#btn-recovery-continue');
    await expect(this.page.locator('#screen-main')).toBeVisible();
    return code;
  }

  async fillLogin(email: string, password: string, deviceName?: string): Promise<void> {
    const p = this.page;
    await p.click('#btn-show-login');
    await p.fill('#login-email', email);
    await p.fill('#login-password', password);
    if (deviceName !== undefined) await p.fill('#login-device-name', deviceName);
    await p.click('#btn-login');
  }

  async login(email: string, deviceName?: string, password = PASSWORD): Promise<void> {
    await this.fillLogin(email, password, deviceName);
    await expect(this.page.locator('#screen-main')).toBeVisible({ timeout: 30_000 });
  }

  async view(name: 'tabs' | 'devices' | 'settings'): Promise<void> {
    await this.page.click(`.nav-btn[data-view="view-${name}"]`);
    await expect(this.page.locator(`#view-${name}`)).toBeVisible();
  }

  /** Devices view card for a device name (exact match). */
  deviceCard(name: string): Locator {
    return this.page.locator('.device-card').filter({
      has: this.page.locator('.device-name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
    });
  }

  /** Re-fetches the Devices view until `predicate` holds for the rendered text. */
  async refreshDevicesUntil(check: () => Promise<void>, timeout = 30_000): Promise<void> {
    await expect(async () => {
      await this.page.click('#btn-refresh-devices');
      await expect(this.page.locator('#devices-status')).not.toHaveText(/Loading/, { timeout: 5000 });
      await check();
    }).toPass({ timeout, intervals: [500, 1000, 2000] });
  }

  /** Opens site pages as background tabs in the popup's own window (like a user's window). */
  async openTabsInThisWindow(urls: string[]): Promise<void> {
    await this.page.evaluate(
      list => Promise.all(list.map(url => chrome.tabs.create({ url, active: false }))),
      urls,
    );
    for (const url of urls) await this.browser.waitForTab(url);
    await this.page.bringToFront();
  }

  /** Tabs view: the ➤ button of the local tab titled `title`, then pick `device`. */
  async sendTab(title: string, device: string): Promise<void> {
    await this.dismissSendStatus();
    await this.view('tabs');
    const row = this.page.locator('#tab-list .tab-item', { hasText: title });
    await expect(row).toHaveCount(1);
    await row.locator('.btn-send-tab').click();
    await this.pickDevice(device);
  }

  async pickDevice(device: string): Promise<void> {
    const item = this.page.locator('#device-picker-list .picker-item', { hasText: device });
    await expect(item).toHaveCount(1);
    await item.click();
    await expect(this.page.locator('#restore-overlay')).toBeVisible();
  }

  /** The send-status overlay's text (title + description). */
  sendStatus(): Locator {
    return this.page.locator('#restore-status-content');
  }

  async dismissSendStatus(): Promise<void> {
    const overlay = this.page.locator('#restore-overlay');
    if (await overlay.isHidden()) return;
    const btn = overlay.locator('.restore-cancel-btn');
    if (await btn.isVisible()) await btn.click();
    await expect(overlay).toBeHidden({ timeout: 5000 });
  }

  /** Devices view: waits (refreshing) until `device` lists exactly `titles`, in order. */
  async expectRemoteTitles(device: string, titles: string[], timeout = 30_000): Promise<void> {
    await this.view('devices');
    await this.page.fill('#device-search', '');
    await this.refreshDevicesUntil(async () => {
      const card = await this.expandDevice(device);
      await expect(card.locator('.tab-title')).toHaveText(titles, { timeout: 1000 });
    }, timeout);
  }

  async expandDevice(name: string): Promise<Locator> {
    const card = this.deviceCard(name);
    await expect(card).toBeVisible({ timeout: 2000 });
    if (!(await card.evaluate(e => e.classList.contains('open')))) await card.locator('.device-head').click();
    await expect(card).toHaveClass(/open/, { timeout: 2000 });
    return card;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

declare const chrome: {
  storage: { local: { get(keys: null): Promise<Record<string, unknown>> } };
  tabs: { create(props: { url: string; active?: boolean }): Promise<unknown> };
};
