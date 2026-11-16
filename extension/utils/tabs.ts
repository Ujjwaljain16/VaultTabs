import { LIMITS, type TabSnapshot } from '@vaulttabs/shared';
import { isSafeTabUrl } from '@vaulttabs/shared/crypto';
import { browser, type Browser } from 'wxt/browser';
import { isExcludedUrl } from './domains';

/** Tabs that may be synced: not incognito, http(s) only, not on a never-sync domain. */
export function syncableTabs(tabs: Browser.tabs.Tab[], excludedDomains: readonly string[]): TabSnapshot[] {
  return tabs
    .filter(t => !t.incognito && isSafeTabUrl(t.url) && !isExcludedUrl(t.url as string, excludedDomains))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
    .map(t => ({
      id: t.id ?? 0,
      url: t.url as string,
      title: t.title || 'Untitled',
      // Only http(s) icon URLs (data: icons can be huge); the popup never loads other devices' icons.
      favIconUrl: isSafeTabUrl(t.favIconUrl) && t.favIconUrl.length <= 2048 ? t.favIconUrl : undefined,
      windowId: t.windowId,
      index: t.index,
      active: t.active,
      pinned: t.pinned,
    }));
}

/** What the change-detection hash covers (active tab and favicons are deliberately ignored). */
export function normalizeForHash(tabs: TabSnapshot[]): string {
  return JSON.stringify(tabs.map(t => [t.url, t.title, t.pinned, t.windowId, t.index]));
}

/** Opens URLs in one new window. Returns how many were opened. */
export async function openUrlsInNewWindow(urls: string[]): Promise<number> {
  const safe = urls.filter(isSafeTabUrl).slice(0, LIMITS.maxRestoreUrls);
  if (safe.length === 0) return 0;
  await browser.windows.create({ url: safe, focused: true });
  return safe.length;
}

/**
 * Recreates a snapshot: one new window per original window, pinned tabs first, at most
 * LIMITS.maxRestoreUrls tabs in total, http(s) only. Returns how many tabs were opened.
 */
export async function openSnapshotWindows(tabs: TabSnapshot[]): Promise<number> {
  const groups = new Map<number, TabSnapshot[]>();
  for (const tab of tabs) {
    if (!isSafeTabUrl(tab.url)) continue;
    const list = groups.get(tab.windowId) ?? [];
    list.push(tab);
    groups.set(tab.windowId, list);
  }

  let budget: number = LIMITS.maxRestoreUrls;
  let opened = 0;
  for (const group of groups.values()) {
    if (budget <= 0) break;
    const ordered = [...group]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.index - b.index)
      .slice(0, budget);
    budget -= ordered.length;

    const [first, ...rest] = ordered;
    if (!first) continue;
    const win = await browser.windows.create({ url: first.url, focused: true });
    if (win?.id === undefined) continue;
    const firstTabId = win.tabs?.[0]?.id;
    if (first.pinned && firstTabId !== undefined) await browser.tabs.update(firstTabId, { pinned: true });
    opened++;
    for (const tab of rest) {
      await browser.tabs.create({ windowId: win.id, url: tab.url, pinned: tab.pinned, active: false });
      opened++;
    }
  }
  return opened;
}
