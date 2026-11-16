'use client';

import type { TabSnapshot } from '@vaulttabs/shared';
import { isSafeTabUrl } from '@vaulttabs/shared/crypto';
import { hostname } from '@/lib/format';
import { groupByWindow } from '@/lib/snapshots';
import { useDashboardActions } from './actions';
import styles from './dashboard.module.css';

// ─── Favicon (privacy-preserving) ──────────────────────────────────────────────────────────────

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * Never loads a remote favicon URL from a snapshot (that would leak to third parties which sites are
 * in your vault, and when you look at it). Only inline data:image/ URLs are rendered; otherwise a
 * letter avatar derived from the hostname.
 */
export function Favicon({ tab }: { tab: TabSnapshot }) {
  const host = hostname(tab.url);
  const icon = tab.favIconUrl;
  if (
    icon &&
    /^data:image\/(png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon);/i.test(icon) &&
    icon.length < 100_000
  ) {
    return (
      // Inline data: favicon only; next/image would add nothing here.
      // eslint-disable-next-line @next/next/no-img-element
      <img className={styles.favicon} src={icon} alt="" width={18} height={18} referrerPolicy="no-referrer" />
    );
  }
  const letter = (host.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
  return (
    <span
      className={styles.favicon}
      style={{ background: `hsl(${hue(host)} 45% 22%)`, color: `hsl(${hue(host)} 80% 78%)` }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

// ─── Highlight ─────────────────────────────────────────────────────────────────────────────────

export function Highlight({ text, query }: { text: string; query?: string }) {
  const q = query?.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let i = lower.indexOf(q);
  let k = 0;
  while (i !== -1 && k < 50) {
    if (i > from) parts.push(text.slice(from, i));
    parts.push(
      <mark key={k++} className={styles.mark}>
        {text.slice(i, i + q.length)}
      </mark>,
    );
    from = i + q.length;
    i = lower.indexOf(q, from);
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

// ─── Tab row ───────────────────────────────────────────────────────────────────────────────────

interface TabRowProps {
  tab: TabSnapshot;
  query?: string;
  /** Diff marker relative to the device's latest snapshot. */
  marker?: 'closed' | 'new';
  showUrl?: boolean;
}

export function TabRow({ tab, query, marker, showUrl }: TabRowProps) {
  const { sendTab } = useDashboardActions();
  const safe = isSafeTabUrl(tab.url);
  const title = tab.title || tab.url;
  const content = (
    <>
      <Favicon tab={tab} />
      <span className={styles.tabInfo}>
        <span className={styles.tabTitle}>
          <Highlight text={title} query={query} />
        </span>
        <span className={styles.tabUrl}>
          <Highlight text={showUrl ? tab.url : hostname(tab.url)} query={query} />
        </span>
      </span>
    </>
  );

  return (
    <li className={`${styles.tabRow} ${tab.active ? styles.tabRowActive : ''}`}>
      {safe ? (
        <a
          className={styles.tabLink}
          href={tab.url}
          target="_blank"
          rel="noopener noreferrer"
          title={tab.url}
        >
          {content}
        </a>
      ) : (
        <span className={styles.tabLink} title="Blocked: only http(s) links can be opened">
          {content}
        </span>
      )}
      <span className={styles.tabMeta}>
        {marker === 'closed' && <span className={styles.badgeClosed}>closed since</span>}
        {marker === 'new' && <span className={styles.badgeNew}>new</span>}
        {tab.pinned && (
          <span className={styles.pinnedIcon} title="Pinned tab" aria-label="Pinned tab">
            ◆
          </span>
        )}
        {tab.active && <span className={styles.activeDot} title="Active tab" aria-label="Active tab" />}
        {safe && (
          <button
            type="button"
            className={styles.miniBtn}
            onClick={() => sendTab(tab.url, title)}
            title="Send this tab to another device"
            aria-label={`Send “${title}” to a device`}
          >
            ⇢
          </button>
        )}
      </span>
    </li>
  );
}

// ─── Tab list (grouped by window) ──────────────────────────────────────────────────────────────

export function TabList({
  tabs,
  query,
  markers,
}: {
  tabs: TabSnapshot[];
  query?: string;
  markers?: Map<TabSnapshot, 'closed' | 'new'>;
}) {
  if (tabs.length === 0) return <div className={styles.noTabs}>No tabs in this snapshot.</div>;
  const windows = groupByWindow(tabs);
  return (
    <div className={styles.tabRows}>
      {windows.map((list, w) => (
        <div key={w} className={styles.windowGroup}>
          {windows.length > 1 && (
            <div className={styles.windowHeader}>
              <span>Window {w + 1}</span>
              <span className={styles.windowBadge}>{list.length}</span>
            </div>
          )}
          <ul className={styles.tabUl}>
            {list.map((tab, i) => (
              <TabRow key={`${tab.id}-${i}`} tab={tab} query={query} marker={markers?.get(tab)} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
