import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ExtBrowser, siteUrl, uniqueEmail, type Popup } from '../support/browsers';
import { closeDb, snapshotCount } from '../support/db';
import { JWT_SECRET } from '../support/env';
import { restartBackend } from '../support/servers';

test.describe.configure({ mode: 'serial' });

let a: ExtBrowser;
let b: ExtBrowser;
let pa: Popup;
let pb: Popup;
const email = uniqueEmail('robust');
const A = 'Personal Chrome';
const B = 'Brave personal';
const MANY = Number(process.env.E2E_MANY_TABS ?? 150);

test.beforeAll(async () => {
  await restartBackend();
  a = await ExtBrowser.launch(A);
  b = await ExtBrowser.launch(B);
  pa = await a.popup();
  await pa.register(email, A);
  pb = await b.popup();
  await pb.login(email, B);
});

test.afterAll(async () => {
  await a?.destroy();
  await b?.destroy();
  await closeDb();
});

test('backend restart while the restore stream is connected: reconnects and still receives', async () => {
  await pb.openTabsInThisWindow([siteUrl('r1', 'Before restart')]);
  await restartBackend();
  // Give the extensions their first reconnect attempt (2.5–5 s backoff).
  await new Promise(r => setTimeout(r, 6000));
  await pb.reload();
  await pb.sendTab('Before restart', A);
  await a.waitForTab(siteUrl('r1', 'Before restart'), 30_000);
  await expect(pb.sendStatus()).toContainText('Opened on');
});

/**
 * The background reacts to the new token by itself (login sync → 401). If the popup is still on
 * the main screen, any server call from it (the Devices view) also notices.
 */
async function nudge(): Promise<void> {
  await pb.reload();
  if (await pb.locator('#screen-main').isVisible()) {
    await pb.page.click('.nav-btn[data-view="view-devices"]', { timeout: 3000 }).catch(() => {});
  }
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', JWT_SECRET).update(head).digest('base64url')}`;
}

test('an expired token ends the session with a clear message', async () => {
  const state = await b.storage();
  const now = Math.floor(Date.now() / 1000);
  const expired = jwt({ sub: state.user_id, tv: 0, iat: now - 7200, exp: now - 3600 });
  await pb.page.evaluate(t => chrome.storage.local.set({ token: t }), expired);
  await nudge();
  await expect(pb.locator('#screen-relogin')).toBeVisible({ timeout: 20_000 });
  await expect(pb.locator('#relogin-desc')).toHaveText('Your session ended. Please log in again.');
  await pb.page.fill('#relogin-password', 'correct horse battery staple');
  await pb.page.click('#btn-relogin');
  await expect(pb.locator('#screen-main')).toBeVisible({ timeout: 30_000 });
});

test('a garbage token ends the session too', async () => {
  await pb.page.evaluate(() => chrome.storage.local.set({ token: 'not-a-jwt' }));
  await nudge();
  await expect(pb.locator('#screen-relogin')).toBeVisible({ timeout: 20_000 });
  await pb.page.fill('#relogin-password', 'correct horse battery staple');
  await pb.page.click('#btn-relogin');
  await expect(pb.locator('#screen-main')).toBeVisible({ timeout: 30_000 });
});

test(`${MANY} tabs sync and restore`, async () => {
  test.setTimeout(600_000);
  const urls = Array.from({ length: MANY }, (_, i) => siteUrl(`many-${i}`, `Many ${i}`));
  // Open in batches and discard loaded tabs (keeps memory low; discarded tabs keep url + title).
  for (let i = 0; i < urls.length; i += 25) {
    const batch = urls.slice(i, i + 25);
    await pa.page.evaluate(async list => {
      const tabs = await Promise.all(list.map(url => chrome.tabs.create({ url, active: false })));
      for (;;) {
        const now = await Promise.all(tabs.map(t => chrome.tabs.get(t.id!)));
        if (now.every(t => t.status === 'complete' && t.title && t.title !== t.url)) break;
        await new Promise(r => setTimeout(r, 200));
      }
      for (const t of tabs) await chrome.tabs.discard(t.id!).catch(() => {});
    }, batch);
  }
  // A also has the tab sent to it in the first test.
  await pb.view('devices');
  await pb.refreshDevicesUntil(async () => {
    await expect(pb.deviceCard(A).locator('.device-sub')).toContainText(`${MANY + 1} tabs`, {
      timeout: 1000,
    });
  }, 60_000);
  expect(await snapshotCount(email, A)).toBeGreaterThan(0);

  // Restore all of them in B ("Here" on the device card).
  await pb
    .deviceCard(A)
    .locator('.device-head-row')
    .getByRole('button', { name: 'Here', exact: true })
    .click();
  await expect.poll(() => urls.filter(u => b.countTabs(u) > 0).length, { timeout: 120_000 }).toBe(MANY);
});

declare const chrome: {
  storage: { local: { set(v: object): Promise<void> } };
  tabs: {
    create(p: { url: string; active?: boolean }): Promise<{ id?: number }>;
    get(id: number): Promise<{ status?: string; title?: string; url?: string }>;
    discard(id: number): Promise<unknown>;
  };
};
