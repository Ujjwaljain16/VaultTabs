import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { ExtBrowser, PASSWORD, siteUrl, uniqueEmail, type Popup } from '../support/browsers';
import { closeDb, devices } from '../support/db';
import { pwaLogin, pwaNav, pwaOpenDevice } from '../support/pwa';
import { restartBackend } from '../support/servers';

/** Session lifecycle across the extension and the web dashboard. */

test.describe.configure({ mode: 'serial' });

let a: ExtBrowser;
let pa: Popup;
let web: Browser;
let pwa: Page;
const email = uniqueEmail('session');
const A = 'Personal Chrome';
const NEW_PASSWORD = 'a much better passphrase 2';
const SESSION_ENDED = 'Your session ended. Please log in again.';

test.beforeAll(async () => {
  await restartBackend();
  a = await ExtBrowser.launch(A);
  pa = await a.popup();
  await pa.register(email, A);
  await a.openTab('s1', 'Session one');
  web = await chromium.launch();
  pwa = await web.newPage();
  await pwaLogin(pwa, email, false);
});

test.afterAll(async () => {
  await a?.destroy();
  await web?.close();
  await closeDb();
});

test('“Sign out everywhere else” in the PWA: the idle extension stops receiving tabs at once', async () => {
  await pwaOpenDevice(pwa, A);
  await pwaNav(pwa, 'Settings');
  await pwa.getByRole('button', { name: 'Sign out everywhere else' }).click();
  await pwa.getByRole('button', { name: 'Sign out others' }).click();
  await expect(pwa.getByRole('status')).toContainText('Every other session');

  // A has made no request since: its restore stream (opened with the now revoked token) is the
  // only thing still connected. The PWA (still signed in) sends a tab to it.
  await pwaNav(pwa, 'Tabs');
  const card = await pwaOpenDevice(pwa, A);
  await card.getByRole('button', { name: /Send “Session one” to a device/ }).click();
  await pwa
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(A) })
    .click();
  await new Promise(r => setTimeout(r, 8000));
  expect(a.countTabs(siteUrl('s1', 'Session one'))).toBe(1);
  await pwa.getByRole('dialog').getByRole('button', { name: 'Stop waiting' }).click();
});

test('the extension then shows “session ended” and keeps the email for re-login', async () => {
  // Noticed on the stream reconnect, or at the latest on the next request (a tab change).
  await a.openTab('s2', 'Session two');
  await expect(pa.locator('#screen-relogin')).toBeVisible({ timeout: 30_000 });
  await expect(pa.locator('#relogin-desc')).toHaveText(SESSION_ENDED);
  await expect(pa.locator('#relogin-email-display')).toHaveText(email);
  const state = await a.storage();
  expect(state.token).toBeUndefined();
  expect(state.relogin_email).toBe(email);
});

test('re-login after the session ended keeps the device', async () => {
  const before = await devices(email);
  await pa.page.fill('#relogin-password', PASSWORD);
  await pa.page.click('#btn-relogin');
  await expect(pa.locator('#screen-main')).toBeVisible({ timeout: 30_000 });
  expect(await devices(email)).toEqual(before);
});

test('changing the password in the PWA forces the extension to log in again', async () => {
  await pwaNav(pwa, 'Settings');
  await pwa.fill('#cp-current', PASSWORD);
  await pwa.fill('#cp-new', NEW_PASSWORD);
  await pwa.fill('#cp-confirm', NEW_PASSWORD);
  await pwa.getByRole('button', { name: 'Change password' }).click();
  await expect(pwa.getByText('Password changed.')).toBeVisible({ timeout: 30_000 });

  await pa.pokeServer(); // any server call notices the revoked token
  await expect(pa.locator('#screen-relogin')).toBeVisible({ timeout: 30_000 });
  await expect(pa.locator('#relogin-desc')).toHaveText(SESSION_ENDED);

  await pa.page.fill('#relogin-password', PASSWORD);
  await pa.page.click('#btn-relogin');
  await expect(pa.locator('#relogin-error')).toBeVisible({ timeout: 30_000 });

  await pa.page.fill('#relogin-password', NEW_PASSWORD);
  await pa.page.click('#btn-relogin');
  await expect(pa.locator('#screen-main')).toBeVisible({ timeout: 30_000 });
  await expect(pa.locator('#info-device')).toHaveText(A);
  expect((await devices(email)).length).toBe(1);
});

test('“Use a different account” on the re-login screen logs out fully', async () => {
  await pa.view('settings');
  await pa.page.click('#btn-logout');
  await expect(pa.locator('#screen-auth')).toBeVisible();
  const state = await a.storage();
  expect(state.token).toBeUndefined();
  expect(state.user_id).toBeUndefined();
  // Device ids survive logout (re-identification), settings too.
  expect(Object.values(state.device_ids as Record<string, string>)).toHaveLength(1);
});
