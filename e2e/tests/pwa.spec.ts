import fs from 'node:fs';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ExtBrowser, PASSWORD, siteUrl, uniqueEmail, type Popup } from '../support/browsers';
import { closeDb, db, dumpAllText } from '../support/db';
import { PWA_URL } from '../support/env';
import { pwaAlert, pwaDeviceCard, pwaLogin, pwaNav, pwaOpenDevice, pwaRegister } from '../support/pwa';
import { restartBackend } from '../support/servers';

/** The web dashboard against real data synced by two real extension browsers. */

test.describe.configure({ mode: 'serial' });

const email = uniqueEmail('pwa');
const A = 'Personal Chrome';
const B = 'Brave personal';
const ALPHA = siteUrl('alpha', 'Alpha 🚀');
const BRAVO = siteUrl('bravo', 'Bravo');
const CHARLIE = siteUrl('charlie', 'Charlie');
const NEW_PASSWORD = 'recovered passphrase number 9';

let a: ExtBrowser;
let b: ExtBrowser;
let pa: Popup;
let web: Browser;
let ctx: BrowserContext;
let page: Page;
const cspViolations: string[] = [];
let firstRecoveryCode = '';

test.beforeAll(async () => {
  await restartBackend();
  a = await ExtBrowser.launch(A);
  b = await ExtBrowser.launch(B);
  pa = await a.popup();
  firstRecoveryCode = await pa.register(email, A);
  await pa.openTabsInThisWindow([ALPHA, BRAVO, CHARLIE]);
  const pb = await b.popup();
  await pb.login(email, B);
  await b.openTab('brave-1', 'Brave tab');
  await pb.expectRemoteTitles(A, ['Alpha 🚀', 'Bravo', 'Charlie']);

  web = await chromium.launch();
  ctx = await web.newContext({ acceptDownloads: true });
  // Record CSP violations on every PWA page.
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page = await ctx.newPage();
  page.on('console', m => {
    if (/Content Security Policy|CSP violation/i.test(m.text())) cspViolations.push(m.text());
  });
});

test.afterAll(async () => {
  await a?.destroy();
  await b?.destroy();
  await web?.close();
  await closeDb();
});

test('login without “remember”: dashboard shows both devices decrypted', async () => {
  await pwaLogin(page, email, false);
  await expect(pwaDeviceCard(page, A)).toBeVisible({ timeout: 30_000 });
  await expect(pwaDeviceCard(page, B)).toBeVisible();
  await expect(page.getByText('devices', { exact: true }).locator('..')).toContainText('2');
  const card = await pwaOpenDevice(page, A);
  await expect(card.getByRole('link')).toHaveText([/Alpha 🚀/, /Bravo/, /Charlie/]);
  await expect(pwaDeviceCard(page, A)).toContainText('3 tabs');
});

test('reload without “remember” locks; unlock works offline', async () => {
  await page.reload();
  await expect(page).toHaveURL(/\/unlock/);
  await ctx.setOffline(true);
  try {
    await page.fill('#password', 'not the password at all');
    await page.getByRole('button', { name: /UNLOCK/ }).click();
    await expect(pwaAlert(page)).toHaveText('Wrong password.', { timeout: 30_000 });
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: /UNLOCK/ }).click();
    // The key is unwrapped locally; the dashboard itself needs the server, so offline the
    // service worker's offline page is shown next.
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible({ timeout: 30_000 });
  } finally {
    await ctx.setOffline(false);
  }
  await page.goto(`${PWA_URL}/dashboard`);
  await expect(page).toHaveURL(/\/unlock/);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: /UNLOCK/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  await expect(pwaDeviceCard(page, A)).toBeVisible();
});

test('“remember this browser” keeps the vault unlocked across reloads', async () => {
  await pwaNav(page, 'Settings');
  await page.getByLabel(/Remember this browser/).check();
  await page.reload();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Lock vault' }).click();
  await expect(page).toHaveURL(/\/unlock/);
  await page.reload();
  await expect(page).toHaveURL(/\/unlock/);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: /UNLOCK/ }).click();
  await expect(page).toHaveURL(/\/settings/, { timeout: 30_000 });
});

test('search across devices', async () => {
  await page.goto(`${PWA_URL}/dashboard`);
  await page.fill('#global-search', 'bravo');
  await expect(page.getByRole('status').filter({ hasText: 'tab' })).toHaveText('1 tab on 1 device');
  await page.fill('#global-search', '127.0.0.1');
  await expect(page.getByRole('status').filter({ hasText: 'tab' })).toHaveText('4 tabs on 2 devices');
  await page.fill('#global-search', 'zzz-nothing');
  await expect(page.getByText('No tabs match “zzz-nothing”.')).toBeVisible();
  await page.fill('#global-search', '');
});

test('history drawer shows earlier snapshots and what changed', async () => {
  // Close Charlie in A → a new snapshot without it.
  await a.context
    .pages()
    .find(p => p.url() === CHARLIE)!
    .close();
  await expect(async () => {
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(pwaDeviceCard(page, A)).toContainText('2 tabs', { timeout: 2000 });
  }).toPass({ timeout: 30_000 });

  await page.getByRole('button', { name: `Open snapshot history of ${A}` }).click();
  const drawer = page.getByRole('dialog', { name: `History · ${A}` });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('latest', { exact: true })).toBeVisible();
  const older = drawer.getByRole('button').filter({ hasText: '3 tabs' }).first();
  await expect(older).toContainText('since then: +0 −1');
  await older.click();
  await expect(page.getByRole('dialog')).toContainText('closed since');
  await expect(
    page.getByRole('dialog').getByRole('listitem').filter({ hasText: 'closed since' }),
  ).toContainText('Charlie');
  await page.getByRole('button', { name: 'Close dialog' }).click();
});

test('save a session with an encrypted label and find it under “Saved”', async () => {
  const card = await pwaOpenDevice(page, A);
  await card.getByRole('button', { name: '★ Save' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save session' });
  await dialog.getByRole('textbox').fill('Work session ✈︎ secret label');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('tab', { name: 'Saved' }).click();
  await expect(page.getByRole('region', { name: 'Work session ✈︎ secret label' })).toBeVisible();
  const [row] = await db()<
    { n: number }[]
  >`SELECT COUNT(*)::int AS n FROM snapshots WHERE pinned AND label_enc IS NOT NULL`;
  expect(row!.n).toBe(1);
  expect(await dumpAllText()).not.toContain('secret label');
  await page.getByRole('tab', { name: 'Devices' }).click();
});

test('export as JSON and as bookmarks HTML', async () => {
  for (const format of ['JSON', 'Bookmarks'] as const) {
    await page.getByRole('button', { name: 'Export tabs' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export tabs' });
    await dialog.getByRole('radio', { name: new RegExp(format) }).check();
    const download = dialog.getByRole('button', { name: /Download/ });
    await expect(download).toBeDisabled();
    await dialog.getByLabel('I understand the exported file is not encrypted.').check();
    const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
    const content = fs.readFileSync((await file.path())!, 'utf8');
    if (format === 'JSON') {
      expect(file.suggestedFilename()).toMatch(/\.json$/);
      const parsed = JSON.parse(content) as unknown;
      expect(JSON.stringify(parsed)).toContain(ALPHA);
      expect(JSON.stringify(parsed)).toContain('Alpha 🚀');
    } else {
      expect(file.suggestedFilename()).toMatch(/\.html$/);
      expect(content).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
      expect(content).toContain(`HREF="${ALPHA.replace(/&/g, '&amp;')}"`);
    }
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close dialog' }).click();
  }
});

test('restore a snapshot to another device opens it in that browser', async () => {
  const card = await pwaOpenDevice(page, A);
  await card.getByRole('button', { name: '⟳ Restore to device…' }).click();
  await page
    .getByRole('dialog', { name: 'Restore to…' })
    .getByRole('button', { name: new RegExp(B) })
    .click();
  await b.waitForTab(ALPHA);
  await b.waitForTab(BRAVO);
  await expect(page.getByRole('dialog', { name: 'Done' })).toContainText(`Opened on ${B}`, {
    timeout: 30_000,
  });
  await page
    .getByRole('dialog', { name: 'Done' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
});

test('send a single tab to a device', async () => {
  const card = await pwaOpenDevice(page, B);
  await card.getByRole('button', { name: 'Send “Brave tab” to a device' }).click();
  await page
    .getByRole('dialog', { name: 'Send tab to…' })
    .getByRole('button', { name: new RegExp(A) })
    .click();
  await a.waitForTab(siteUrl('brave-1', 'Brave tab'));
  await expect(page.getByRole('dialog', { name: 'Done' })).toContainText(`Opened on ${A}`, {
    timeout: 30_000,
  });
  await page
    .getByRole('dialog', { name: 'Done' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
});

test('devices page lists both devices', async () => {
  await page.goto(`${PWA_URL}/devices`);
  await expect(page.getByText(A, { exact: true })).toBeVisible();
  await expect(page.getByText(B, { exact: true })).toBeVisible();
});

test('settings: retention', async () => {
  await page.goto(`${PWA_URL}/settings`);
  await page.fill('#retention', '0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Blocked by the browser's own validation of the number field (min=1): nothing is saved.
  expect(await page.locator('#retention').evaluate(el => (el as HTMLInputElement).validity.valid)).toBe(
    false,
  );
  await page.fill('#retention', '3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Keeping the last 3 snapshots per device.')).toBeVisible();
  const [row] = await db()<{ snapshot_retention: number }[]>`
    SELECT snapshot_retention FROM users WHERE email = ${email}`;
  expect(row!.snapshot_retention).toBe(3);
});

let secondRecoveryCode = '';

test('settings: a new recovery code replaces the old one', async () => {
  await page.getByRole('button', { name: 'Generate new recovery code' }).click();
  const dialog = page.getByRole('dialog', { name: 'New recovery code' });
  await dialog.locator('#prompt-password').fill('wrong password here');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(pwaAlert(dialog)).toBeVisible({ timeout: 30_000 });
  await dialog.locator('#prompt-password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Generate' }).click();
  const code = page.locator('output[aria-label="Recovery code"]');
  await expect(code).toBeVisible({ timeout: 30_000 });
  secondRecoveryCode = (await code.textContent())!.trim();
  expect(secondRecoveryCode).not.toBe(firstRecoveryCode);
  await page.getByLabel('I saved my recovery code somewhere safe.').check();
  await page.getByRole('button', { name: 'Done' }).click();
});

test('recover: the replaced code fails, the current one resets the password and is rotated', async () => {
  const fresh = await ctx.browser()!.newPage();
  try {
    await fresh.goto(`${PWA_URL}/recover`);
    const attempt = async (code: string) => {
      await fresh.fill('#email', email);
      await fresh.fill('#code', code);
      await fresh.fill('#password', NEW_PASSWORD);
      await fresh.fill('#confirm', NEW_PASSWORD);
      await fresh.getByRole('button', { name: /RECOVER|RESET/i }).click();
    };
    await attempt(firstRecoveryCode);
    await expect(pwaAlert(fresh)).toContainText('Invalid email or recovery code.', { timeout: 30_000 });

    await attempt(secondRecoveryCode);
    const newCode = fresh.locator('output[aria-label="Recovery code"]');
    await expect(newCode).toBeVisible({ timeout: 30_000 });
    const thirdCode = (await newCode.textContent())!.trim();
    expect(thirdCode).not.toBe(secondRecoveryCode);
    await fresh.getByLabel('I saved my recovery code somewhere safe.').check();
    await fresh.getByRole('button', { name: /Sign in/ }).click();
    await expect(fresh).toHaveURL(/\/login\?reason=recovered/);
    await expect(fresh.getByRole('status')).toContainText('Password reset.');

    await fresh.goto(`${PWA_URL}/recover`);
    await attempt(secondRecoveryCode);
    await expect(pwaAlert(fresh)).toContainText('Invalid email or recovery code.', { timeout: 30_000 });

    await pwaLogin(fresh, email, false, NEW_PASSWORD);
    await expect(pwaDeviceCard(fresh, A)).toBeVisible({ timeout: 30_000 });
  } finally {
    await fresh.close();
  }
});

test('the old PWA session ended after recovery', async () => {
  await page.goto(`${PWA_URL}/dashboard`);
  await expect(page).toHaveURL(/\/login\?reason=expired|\/unlock|\/login/, { timeout: 30_000 });
});

test('register a second account in the PWA (validation + remember)', async () => {
  const other = await ctx.browser()!.newContext();
  const p = await other.newPage();
  try {
    await p.goto(`${PWA_URL}/register`);
    await p.fill('#email', uniqueEmail('pwa-reg'));
    await p.fill('#password', 'short');
    await p.fill('#confirm', 'short');
    await p.getByRole('button', { name: /CREATE ACCOUNT/ }).click();
    await expect(pwaAlert(p)).toHaveText('Use at least 10 characters.');
    await p.fill('#password', 'aaaaaaaaaaaa');
    await p.fill('#confirm', 'aaaaaaaaaaaa');
    await p.getByRole('button', { name: /CREATE ACCOUNT/ }).click();
    await expect(pwaAlert(p)).toContainText('too easy to guess');
    await pwaRegister(p, uniqueEmail('pwa-reg'), true);
    await expect(p.getByText('No snapshots yet')).toBeVisible();
    await p.reload();
    await expect(p).toHaveURL(/\/dashboard/);
  } finally {
    await other.close();
  }
});

test('delete account', async () => {
  await pwaLogin(page, email, true, NEW_PASSWORD);
  await page.goto(`${PWA_URL}/settings`);
  await page.getByRole('button', { name: 'Delete account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete account' });
  const confirm = dialog.getByRole('button', { name: 'Delete forever' });
  await dialog.locator('#prompt-password').fill(NEW_PASSWORD);
  await expect(confirm).toBeDisabled();
  await dialog.locator('#type-confirm').fill('DELETE');
  await confirm.click();
  await expect(page).toHaveURL(/\/login\?reason=deleted/, { timeout: 30_000 });
  await expect(page.getByRole('status')).toContainText('deleted');
  const rows = await db()`SELECT 1 FROM users WHERE email = ${email}`;
  expect(rows).toHaveLength(0);
  const left = await db()`SELECT 1 FROM snapshots s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL`;
  expect(left).toHaveLength(0);
});

test('no CSP violations were reported on any PWA page', async () => {
  for (const path of ['/', '/login', '/register', '/recover']) {
    await page.goto(`${PWA_URL}${path}`);
    await page.waitForLoadState('networkidle');
  }
  expect(cspViolations).toEqual([]);
});

test('the PWA service worker registers in a normal Chromium', async () => {
  await page.goto(`${PWA_URL}/`);
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.scope;
  });
  expect(scope).toBe(`${PWA_URL}/`);
});
