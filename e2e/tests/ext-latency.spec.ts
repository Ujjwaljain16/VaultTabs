import { expect, test } from '@playwright/test';
import { ExtBrowser, siteUrl, uniqueEmail, type Popup } from '../support/browsers';
import { RawChromium } from '../support/raw-chromium';
import { restartBackend } from '../support/servers';

/**
 * Real-time delivery with real MV3 service-worker lifetime rules. The receiving browser runs
 * WITHOUT Playwright attached (attached DevTools would keep its worker alive forever).
 */

test.describe.configure({ mode: 'serial' });

const email = uniqueEmail('latency');
const A = 'Personal Chrome';
let a: ExtBrowser;
let raw: RawChromium;
let b: ExtBrowser;
let pb: Popup;

test.beforeAll(async () => {
  await restartBackend();
  a = await ExtBrowser.launch(A);
  const pa = await a.popup();
  await pa.register(email, A);
  await a.close();
  raw = await RawChromium.launch(a.userDataDir, 9333);
  b = await ExtBrowser.launch('Brave personal');
  pb = await b.popup();
  await pb.login(email, 'Brave personal');
});

test.afterAll(async () => {
  await raw?.close();
  await a?.destroy();
  await b?.destroy();
});

async function sendAndMeasure(slug: string, limitMs: number): Promise<number> {
  const url = siteUrl(slug, `Latency ${slug}`);
  await pb.dismissSendStatus();
  await pb.openTabsInThisWindow([url]);
  await pb.reload();
  await pb.sendTab(`Latency ${slug}`, A);
  const started = Date.now();
  while (!(await raw.pageUrls()).includes(url)) {
    if (Date.now() - started > limitMs) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const ms = Date.now() - started;
  test.info().annotations.push({ type: 'latency', description: `${slug}: ${ms} ms` });
  console.warn(`[latency] ${slug}: ${ms} ms`);
  return ms;
}

test('worker idle for > 30 s: a sent tab opens within seconds', async () => {
  await new Promise(r => setTimeout(r, 45_000));
  // The open restore stream (pings every 20 s) keeps the worker alive.
  expect(await raw.workerRunning()).toBe(true);
  expect(await sendAndMeasure('idle', 60_000)).toBeLessThan(5_000);
});

test('worker stopped by the browser (MV3 suspension): a sent tab still opens within ~30 s', async () => {
  test.setTimeout(400_000);
  // Throws unless chrome://serviceworker-internals then reports the worker as STOPPED.
  await raw.stopWorker();
  await new Promise(r => setTimeout(r, 2000));
  expect(await sendAndMeasure('suspended', 240_000)).toBeLessThan(35_000);
});
