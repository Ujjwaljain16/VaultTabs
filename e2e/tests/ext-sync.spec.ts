import { expect, test } from '@playwright/test';
import { ExtBrowser, uniqueEmail, type Popup } from '../support/browsers';
import { closeDb, dumpAllText, snapshotCount } from '../support/db';
import { SITE_PORT } from '../support/env';
import { restartBackend } from '../support/servers';

test.describe.configure({ mode: 'serial' });

let a: ExtBrowser;
let b: ExtBrowser;
let pa: Popup;
let pb: Popup;
const email = uniqueEmail('sync');
const A = 'Personal Chrome';
const UNICODE_TITLE = 'Ünïcödé 日本語 — 🚀✨ “quotes” <b>&amp;</b>';

/** Longer than the 3 s sync debounce plus an upload. */
const SETTLE_MS = 7_000;

test.beforeAll(async () => {
  await restartBackend();
  a = await ExtBrowser.launch(A);
  b = await ExtBrowser.launch('Brave personal');
  pa = await a.popup();
  await pa.register(email, A);
  pb = await b.popup();
  await pb.login(email, 'Brave personal');
});

test.afterAll(async () => {
  await a?.destroy();
  await b?.destroy();
  await closeDb();
});

test('tabs opened in A show up decrypted in B', async () => {
  await a.openTab('one', 'Alpha one');
  await a.openTab('two', 'Bravo two');
  await a.openTab('three', 'Charlie three');
  await pb.expectRemoteTitles(A, ['Alpha one', 'Bravo two', 'Charlie three']);
  const card = pb.deviceCard(A);
  await expect(card.locator('.device-sub')).toContainText('3 tabs');
  await expect(card.locator('.tab-url').first()).toHaveText('127.0.0.1');
});

test('closing and moving tabs in A updates B', async () => {
  const two = a.context.pages().find(p => p.url().includes('/p/two'))!;
  await two.close();
  await pb.expectRemoteTitles(A, ['Alpha one', 'Charlie three']);

  await a.inExtensionPage(async () => {
    const three = (await chrome.tabs.query({})).find(t => t.url?.includes('/p/three'));
    await chrome.tabs.move(three!.id!, { index: 0 });
  });
  await pb.expectRemoteTitles(A, ['Charlie three', 'Alpha one']);
});

test('search across devices filters titles and URLs', async () => {
  await b.openTab('bee', 'Brave-only page');
  await pb.view('devices');
  await pb.page.fill('#device-search', 'charlie');
  await expect(pb.deviceCard(A).locator('.tab-title')).toHaveText(['Charlie three']);
  await expect(pb.deviceCard(A).locator('.device-sub')).toContainText('1/2 tabs');
  await pb.page.fill('#device-search', '/p/one');
  await expect(pb.deviceCard(A).locator('.tab-title')).toHaveText(['Alpha one']);
  // B's own tabs are not "another device".
  await pb.page.fill('#device-search', 'brave-only');
  await expect(pb.locator('#devices-status')).toHaveText('No matching tabs.');
  await pb.page.fill('#device-search', '');
});

test('nothing is uploaded when nothing changed', async () => {
  await expect.poll(() => snapshotCount(email, A), { timeout: 15_000 }).toBeGreaterThan(0);
  await new Promise(r => setTimeout(r, SETTLE_MS));
  const before = await snapshotCount(email, A);

  // Popup open/close, switching tabs and reloading a page do not change what is synced.
  const extra = await a.popup();
  await extra.page.close();
  const one = a.context.pages().find(p => p.url().includes('/p/one'))!;
  await one.bringToFront();
  await one.reload();
  await new Promise(r => setTimeout(r, SETTLE_MS));
  expect(await snapshotCount(email, A)).toBe(before);

  // "Sync now" forces an upload.
  await pa.page.bringToFront();
  await pa.view('tabs');
  await pa.page.click('#btn-sync-now');
  await expect(pa.locator('#toast')).toHaveText('Synced.');
  expect(await snapshotCount(email, A)).toBe(before + 1);
});

test('non-http(s) tabs are never synced', async () => {
  const blank = await a.context.newPage();
  await blank.goto('about:blank');
  const data = await a.context.newPage();
  await data.goto('data:text/html,<title>Data page</title>');
  const version = await a.context.newPage();
  await version.goto('chrome://version');
  await a.openTab('four', 'Delta four');
  await pb.expectRemoteTitles(A, ['Charlie three', 'Alpha one', 'Delta four']);
  await pa.page.bringToFront();
  await pa.view('tabs');
  await expect(pa.locator('#info-tab-count')).toHaveText('3');
  await Promise.all([blank.close(), data.close(), version.close()]);
});

test('unicode and emoji titles survive encryption', async () => {
  await a.openTab('emoji', UNICODE_TITLE);
  await pb.expectRemoteTitles(A, ['Charlie three', 'Alpha one', 'Delta four', UNICODE_TITLE]);
});

test('never-sync domains are left out of snapshots', async () => {
  await pa.page.bringToFront();
  await pa.view('settings');
  await pa.page.fill('#domain-input', 'not a domain!!');
  await pa.page.click('#form-domain button[type=submit]');
  await expect(pa.locator('#domain-error')).toHaveText('Enter a domain like bank.com.');
  await pa.page.fill('#domain-input', 'http://LOCALHOST:1234/some/path');
  await pa.page.click('#form-domain button[type=submit]');
  await expect(pa.locator('#domain-list')).toContainText('localhost');
  await pa.page.fill('#domain-input', 'localhost');
  await pa.page.click('#form-domain button[type=submit]');
  await expect(pa.locator('#domain-error')).toHaveText('localhost is already excluded.');

  // Same site, different host name: "localhost" is excluded, 127.0.0.1 is not.
  const secret = await a.context.newPage();
  await secret.goto(`http://localhost:${SITE_PORT}/p/bank?title=Secret%20bank`);
  await a.openTab('five', 'Echo five');
  await pb.expectRemoteTitles(A, ['Charlie three', 'Alpha one', 'Delta four', UNICODE_TITLE, 'Echo five']);
  await pb.view('devices');
  await expect(pb.deviceCard(A)).not.toContainText('Secret bank');

  // Removing the rule syncs the page.
  await pa.page.bringToFront();
  await pa.view('settings');
  await pa.locator('#domain-list .domain-remove').click();
  await expect(pa.locator('#domain-list')).toHaveText('No domains excluded.');
  await pb.view('devices');
  await pb.refreshDevicesUntil(async () => {
    await expect(pb.deviceCard(A)).toContainText('Secret bank', { timeout: 1000 });
  });
  await secret.close();
});

test('pausing sync stops uploads until resumed', async () => {
  await pa.page.bringToFront();
  await pa.view('settings');
  await pa.page.check('#setting-pause');
  await new Promise(r => setTimeout(r, SETTLE_MS));
  const before = await snapshotCount(email, A);
  await a.openTab('paused', 'Opened while paused');
  await new Promise(r => setTimeout(r, SETTLE_MS));
  expect(await snapshotCount(email, A)).toBe(before);
  await pa.page.bringToFront();
  await pa.view('tabs');
  await expect(pa.locator('#status-text')).toHaveText('Sync paused');
  await pa.page.click('#btn-sync-now');
  await expect(pa.locator('#toast')).toHaveText('Syncing is paused.');
  expect(await snapshotCount(email, A)).toBe(before);

  await pa.view('settings');
  await pa.page.uncheck('#setting-pause');
  await pb.view('devices');
  await pb.refreshDevicesUntil(async () => {
    await expect(pb.deviceCard(A)).toContainText('Opened while paused', { timeout: 1000 });
  });
});

test('the database never contains plaintext titles or URLs', async () => {
  const dump = await dumpAllText();
  for (const needle of [
    'Alpha one',
    'Charlie three',
    'Secret bank',
    '日本語',
    '127.0.0.1:3012',
    '/p/one',
    'localhost:3012',
  ]) {
    expect(dump, needle).not.toContain(needle);
  }
});

declare const chrome: {
  tabs: {
    query(q: object): Promise<{ id?: number; url?: string }[]>;
    move(id: number, props: { index: number }): Promise<unknown>;
  };
};
