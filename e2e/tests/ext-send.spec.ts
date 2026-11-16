import { expect, test } from '@playwright/test';
import { ExtBrowser, siteUrl, uniqueEmail, type Popup } from '../support/browsers';
import { closeDb, db, devices } from '../support/db';
import { restartBackend } from '../support/servers';

test.describe.configure({ mode: 'serial' });

let a: ExtBrowser;
let b: ExtBrowser;
let pa: Popup;
let pb: Popup;
const email = uniqueEmail('send');
const A = 'Personal Chrome';
const B = 'Brave personal';
const ALPHA = siteUrl('alpha', 'Alpha');
const BRAVO = siteUrl('bravo', 'Bravo');

test.beforeAll(async () => {
  await restartBackend();
  a = await ExtBrowser.launch(A);
  b = await ExtBrowser.launch(B);
  pa = await a.popup();
  await pa.register(email, A);
  pb = await b.popup();
  await pb.login(email, B);
  await pa.openTabsInThisWindow([ALPHA, BRAVO]);
  await pb.expectRemoteTitles(A, ['Alpha', 'Bravo']);
});

test.afterAll(async () => {
  await a?.destroy();
  await b?.destroy();
  await closeDb();
});

test('clicking another device’s tab opens it in THAT browser', async () => {
  const card = await pb.expandDevice(A);
  await card.locator('.tab-item', { hasText: 'Alpha' }).click();
  await expect.poll(() => a.countTabs(ALPHA)).toBe(2);
  await expect(pb.sendStatus()).toContainText('Opened on');
  await expect(pb.sendStatus()).toContainText(A);
  expect(b.countTabs(ALPHA)).toBe(0);
});

test('“Here” on a remote tab opens it in this browser', async () => {
  await expect(pb.locator('#restore-overlay')).toBeHidden({ timeout: 10_000 });
  const card = await pb.expandDevice(A);
  await card.locator('.tab-item', { hasText: 'Bravo' }).getByRole('button', { name: 'Here' }).click();
  await b.waitForTab(BRAVO);
  await new Promise(r => setTimeout(r, 2000));
  expect(a.countTabs(BRAVO)).toBe(1);
});

test('“Open there” opens all of that device’s tabs in that browser', async () => {
  await pb.page.bringToFront();
  await pb.expectRemoteTitles(A, ['Alpha', 'Bravo', 'Alpha']);
  const before = { alpha: a.countTabs(ALPHA), bravo: a.countTabs(BRAVO) };
  await pb.deviceCard(A).getByRole('button', { name: 'Open there' }).click();
  await expect.poll(() => a.countTabs(ALPHA)).toBe(before.alpha + 2);
  await expect.poll(() => a.countTabs(BRAVO)).toBe(before.bravo + 1);
  await expect(pb.sendStatus()).toContainText('Opened on');
});

test('device-level “Here” opens all of its tabs in this browser', async () => {
  await expect(pb.locator('#restore-overlay')).toBeHidden({ timeout: 10_000 });
  const before = b.countTabs(ALPHA);
  await pb
    .deviceCard(A)
    .locator('.device-head-row')
    .getByRole('button', { name: 'Here', exact: true })
    .click();
  await expect.poll(() => b.countTabs(ALPHA)).toBeGreaterThan(before);
});

test('send a single tab from the Tabs view', async () => {
  await pb.page.bringToFront();
  const url = siteUrl('from-brave', 'From Brave');
  await pb.openTabsInThisWindow([url]);
  await pb.reload();
  await pb.sendTab('From Brave', A);
  await a.waitForTab(url);
  await expect(pb.sendStatus()).toContainText('Opened on');
});

test('send the whole window', async () => {
  await pb.dismissSendStatus();
  const urls = [siteUrl('w1', 'Window one'), siteUrl('w2', 'Window two')];
  await pb.openTabsInThisWindow(urls);
  await pb.reload();
  await pb.view('tabs');
  const expectedCount = await pb.page.evaluate(
    async () =>
      (await chrome.tabs.query({ currentWindow: true })).filter(t => /^https?:/.test(t.url ?? '')).length,
  );
  await pb.page.click('#btn-send-window');
  await expect(pb.locator('#device-picker-desc')).toHaveText(`${expectedCount} tabs from this window`);
  await pb.pickDevice(A);
  for (const url of urls) await a.waitForTab(url);
  await expect(pb.sendStatus()).toContainText('Opened on');
});

test('the device picker never offers this browser itself', async () => {
  await pb.dismissSendStatus();
  await pb.view('tabs');
  await pb.page.locator('#tab-list .tab-item').first().locator('.btn-send-tab').click();
  await expect(pb.locator('#device-picker-list .picker-item')).toHaveText([`◉${A}`]);
  await pb.page.click('#btn-cancel-device-picker');
});

const EXPIRED = siteUrl('expired-send', 'Expired send');
const LATE_1 = siteUrl('late-one', 'Late one');
const LATE_2 = siteUrl('late-two', 'Late two');

test('target closed: the send is reported as queued, not as an error', async () => {
  await a.close();
  await pb.page.bringToFront();
  await pb.openTabsInThisWindow([EXPIRED, LATE_1, LATE_2]);
  await pb.reload();
  await pb.sendTab('Expired send', A);
  await expect(pb.sendStatus()).toContainText('Waiting for device');
  await expect(pb.sendStatus()).toContainText('Queued', { timeout: 25_000 });
  await expect(pb.sendStatus()).toContainText(`${A} looks closed`);
  // Queued for ~24 h on the server.
  const [row] = await db()<{ hours: number }[]>`
    SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 3600 AS hours
    FROM restore_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`;
  expect(Number(row!.hours)).toBeCloseTo(24, 1);
  // Let this one run out, so it must NOT open when the browser comes back.
  await db()`UPDATE restore_requests SET expires_at = NOW() - INTERVAL '1 second' WHERE status = 'pending'`;
});

test('queued sends open when the closed browser starts: all of them, once each, not expired ones', async () => {
  await pb.dismissSendStatus();
  await pb.sendTab('Late one', A);
  await expect(pb.sendStatus()).toContainText('Queued', { timeout: 25_000 });
  await pb.dismissSendStatus();
  await pb.sendTab('Late two', A);
  await expect(pb.sendStatus()).toContainText('Queued', { timeout: 25_000 });

  a = await ExtBrowser.launch(A, { userDataDir: a.userDataDir });
  await a.waitForTab(LATE_1, 60_000);
  await a.waitForTab(LATE_2, 60_000);
  // Give stream + fallback poll time to (wrongly) open anything twice.
  await new Promise(r => setTimeout(r, 5000));
  expect(a.countTabs(LATE_1)).toBe(1);
  expect(a.countTabs(LATE_2)).toBe(1);
  expect(a.countTabs(EXPIRED)).toBe(0);
  const [pending] = await db()<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM restore_requests WHERE status = 'pending' AND expires_at > NOW()`;
  expect(pending!.n).toBe(0);
});

test('✕ removes another device after a second click', async () => {
  await pb.dismissSendStatus();
  await a.close();
  await pb.view('devices');
  await pb.refreshDevicesUntil(async () => {
    await expect(pb.deviceCard(A)).toBeVisible({ timeout: 1000 });
  });
  const remove = pb.deviceCard(A).getByRole('button', { name: '✕' });
  await remove.click();
  await expect(pb.deviceCard(A).getByRole('button', { name: 'Remove?' })).toBeVisible();
  expect((await devices(email)).length).toBe(2);
  await pb.deviceCard(A).getByRole('button', { name: 'Remove?' }).click();
  await expect(pb.deviceCard(A)).toHaveCount(0);
  await expect(pb.locator('#toast')).toHaveText(`Removed ${A}.`);
  expect((await devices(email)).map(d => d.device_name)).toEqual([B]);
});

test('a removed browser that is still in use comes back as ONE device', async () => {
  a = await ExtBrowser.launch(A, { userDataDir: a.userDataDir });
  await a.openTab('after-removal', 'After removal');
  await expect
    .poll(async () => (await devices(email)).map(d => d.device_name).sort(), { timeout: 30_000 })
    .toEqual([B, A].sort());
  await pb.view('devices');
  await pb.refreshDevicesUntil(async () => {
    const card = await pb.expandDevice(A);
    await expect(card).toContainText('After removal', { timeout: 1000 });
  });
});

declare const chrome: {
  tabs: { query(q: object): Promise<{ url?: string }[]> };
};
