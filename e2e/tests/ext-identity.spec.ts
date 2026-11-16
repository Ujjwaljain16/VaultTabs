import { expect, test } from '@playwright/test';
import { ExtBrowser, uniqueEmail, type Popup } from '../support/browsers';
import { closeDb, db, devices } from '../support/db';
import { restartBackend } from '../support/servers';

/**
 * Re-identification: a reinstalled / wiped extension must re-attach to the browser's existing
 * device instead of creating a duplicate, while different browsers stay different devices.
 */

test.describe.configure({ mode: 'serial' });

const email = uniqueEmail('identity');
const A = 'Personal Chrome';
const open: ExtBrowser[] = [];

async function launch(name: string): Promise<{ browser: ExtBrowser; popup: Popup }> {
  const browser = await ExtBrowser.launch(name);
  open.push(browser);
  return { browser, popup: await browser.popup() };
}

test.beforeAll(async () => {
  await restartBackend();
});

test.afterAll(async () => {
  for (const b of open) await b.destroy();
  await closeDb();
});

let originalId = '';

test('reinstall with a fresh profile + same custom name reuses the device', async () => {
  const first = await launch(A);
  await first.popup.register(email, A);
  originalId = (await devices(email))[0]!.id;
  await first.browser.destroy(); // uninstall + wipe

  const again = await launch(A);
  await again.popup.login(email, A);
  expect(await devices(email)).toEqual([{ id: originalId, device_name: A }]);
});

test('clearing all extension storage + same name reuses the device', async () => {
  const browser = open.at(-1)!;
  await browser.inExtensionPage(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    // Wipe the stored vault key (deleteDatabase would block on the worker's open connection).
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('vaulttabs');
      open.onsuccess = () => {
        const tx = open.result.transaction('crypto-keys', 'readwrite');
        tx.objectStore('crypto-keys').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
  });
  const popup = await browser.popup();
  await expect(popup.locator('#screen-auth')).toBeVisible();
  await popup.login(email, A);
  expect(await devices(email)).toEqual([{ id: originalId, device_name: A }]);
});

test('clearing only local storage keeps the id from storage.sync', async () => {
  const browser = open.at(-1)!;
  await browser.inExtensionPage(() => chrome.storage.local.clear());
  const popup = await browser.popup();
  await expect(popup.locator('#screen-auth')).toBeVisible();
  // Whatever is typed, the synced device id wins (and the name is updated).
  await popup.login(email, A);
  expect(await devices(email)).toEqual([{ id: originalId, device_name: A }]);
});

test('two browsers with different names are two devices', async () => {
  const brave = await launch('Brave personal');
  await brave.popup.login(email, 'Brave personal');
  expect((await devices(email)).map(d => d.device_name).sort()).toEqual(['Brave personal', A]);
});

let defaultName = '';

test('default name: two browsers that are both active get separate devices', async () => {
  const c = await launch('Default C');
  defaultName = await c.popup.locator('#login-device-name').inputValue();
  expect(defaultName).toMatch(/^Chrome on /);
  await c.popup.page.fill('#login-email', email);
  await c.popup.page.fill('#login-password', 'correct horse battery staple');
  await c.popup.page.click('#btn-login');
  await expect(c.popup.locator('#screen-main')).toBeVisible({ timeout: 30_000 });

  const d = await launch('Default D');
  await d.popup.login(email); // untouched default name
  const named = (await devices(email)).filter(x => x.device_name === defaultName);
  expect(named).toHaveLength(2);
});

test('default name: a reinstall after the old install went idle reuses it', async () => {
  const d = open.at(-1)!;
  const [, dDevice] = (await devices(email)).filter(x => x.device_name === defaultName);
  await d.destroy();
  // D has been gone for a while (the adoption window for auto-generated names is 10 minutes).
  await db()`UPDATE devices SET last_seen = NOW() - INTERVAL '20 minutes' WHERE id = ${dDevice!.id}`;

  const e = await launch('Default E');
  await e.popup.login(email);
  const named = (await devices(email)).filter(x => x.device_name === defaultName);
  expect(named).toHaveLength(2);
  expect(named.map(x => x.id)).toContain(dDevice!.id);
});

declare const chrome: {
  storage: { local: { clear(): Promise<void> }; sync: { clear(): Promise<void> } };
};
