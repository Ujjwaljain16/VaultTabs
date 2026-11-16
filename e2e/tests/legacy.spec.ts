import { chromium, expect, test, type Request } from '@playwright/test';
import { ExtBrowser, uniqueEmail } from '../support/browsers';
import { closeDb, snapshotCount } from '../support/db';
import { PWA_URL } from '../support/env';
import { kdfVersion, seedLegacyUser, tamperBackToV1 } from '../support/legacy';
import { pwaAlert, pwaNav } from '../support/pwa';
import { restartBackend } from '../support/servers';

/** Upgrade of legacy (kdf v1) accounts through the real UIs, and KDF downgrade refusal. */

test.describe.configure({ mode: 'serial' });

const LEGACY_PASSWORD = 'legacy password 123';
const DOWNGRADE =
  'The server asked for an outdated login method for this account; refusing to send your password.';

test.beforeAll(async () => {
  await restartBackend();
});

test.afterAll(async () => {
  await closeDb();
});

/** Collects the bodies of /auth/login requests (to prove what was or was not sent). */
function loginBodies(requests: Request[]): string[] {
  return requests.filter(r => r.url().endsWith('/auth/login')).map(r => r.postData() ?? '');
}

test('extension: v1 account needs consent, upgrades to v2, then refuses a downgrade', async () => {
  const email = uniqueEmail('legacy-ext');
  await seedLegacyUser(email, LEGACY_PASSWORD);
  const a = await ExtBrowser.launch('Personal Chrome');
  try {
    const popup = await a.popup();
    const requests: Request[] = [];
    popup.page.on('request', r => requests.push(r));

    await popup.fillLogin(email, LEGACY_PASSWORD, 'Personal Chrome');
    await expect(popup.locator('#login-error')).toContainText('older account', { timeout: 30_000 });
    await expect(popup.locator('#btn-login .btn-text')).toHaveText('Upgrade & Unlock');
    // Nothing was sent yet: no consent, no password on the wire.
    expect(loginBodies(requests)).toEqual([]);

    await popup.page.click('#btn-login');
    await expect(popup.locator('#screen-main')).toBeVisible({ timeout: 60_000 });
    expect(loginBodies(requests)).toHaveLength(1);
    expect(loginBodies(requests)[0]).toContain(LEGACY_PASSWORD);
    expect(await kdfVersion(email)).toBe(2);

    // The vault works: a page opened now is uploaded and decryptable.
    await a.openTab('legacy', 'Legacy tab');
    // (Polled in the database: opening extension pages to read storage would itself be tab
    // activity and keep pushing the 3 s sync debounce back.)
    await expect.poll(() => snapshotCount(email), { timeout: 20_000 }).toBeGreaterThan(0);

    // Log out, then the server claims v1 again: the extension must not send the password.
    await popup.view('settings');
    await popup.page.click('#btn-logout');
    await tamperBackToV1(email);
    requests.length = 0;
    await popup.fillLogin(email, LEGACY_PASSWORD, 'Personal Chrome');
    await expect(popup.locator('#login-error')).toHaveText(DOWNGRADE, { timeout: 30_000 });
    expect(loginBodies(requests)).toEqual([]);
    expect(requests.map(r => r.url()).filter(u => u.includes('/auth/'))).toEqual([
      expect.stringContaining('/auth/prelogin'),
    ]);
  } finally {
    await a.destroy();
  }
});

test('PWA: v1 account needs consent, upgrades to v2, then refuses a downgrade', async () => {
  const email = uniqueEmail('legacy-pwa');
  await seedLegacyUser(email, LEGACY_PASSWORD);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const requests: Request[] = [];
    page.on('request', r => requests.push(r));
    await page.goto(`${PWA_URL}/login`);
    await page.fill('#email', email);
    await page.fill('#password', LEGACY_PASSWORD);
    await page.getByRole('button', { name: /SIGN IN & UNLOCK/ }).click();
    const upgrade = page.getByRole('button', { name: /CONTINUE & UPGRADE ACCOUNT/ });
    await expect(upgrade).toBeVisible({ timeout: 30_000 });
    expect(loginBodies(requests)).toEqual([]);

    await upgrade.click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });
    expect(await kdfVersion(email)).toBe(2);
    await pwaNav(page, 'Settings');
    await expect(page.getByText(/v2 · PBKDF2/)).toBeVisible();

    await page.getByRole('button', { name: 'Sign out of this browser' }).click();
    await expect(page).toHaveURL(/\/login/);
    await tamperBackToV1(email);
    requests.length = 0;
    await page.fill('#email', email);
    await page.fill('#password', LEGACY_PASSWORD);
    await page.getByRole('button', { name: /SIGN IN & UNLOCK/ }).click();
    await expect(pwaAlert(page)).toContainText(/outdated|downgrade|refus/i, { timeout: 30_000 });
    expect(loginBodies(requests)).toEqual([]);
  } finally {
    await browser.close();
  }
});
