import type { SnapshotWithDevice, TabSnapshot } from '@vaulttabs/shared';
import { decryptLabel, decryptSnapshot, isSafeTabUrl } from '@vaulttabs/shared/crypto';

export interface DecryptedSnapshot {
  row: SnapshotWithDevice;
  /** null while decrypting failed — see `error`. */
  tabs: TabSnapshot[] | null;
  error?: string;
  /** Decrypted saved-session label, if any. */
  label?: string | null;
}

/**
 * Decrypt a snapshot row. The AAD context uses OUR user id (from the session), the device the row is
 * shown under and the timestamp shown, so a server that moved or relabelled a snapshot is detected.
 */
export async function decryptRow(
  row: SnapshotWithDevice,
  key: CryptoKey,
  userId: string,
): Promise<DecryptedSnapshot> {
  let tabs: TabSnapshot[] | null = null;
  let error: string | undefined;
  try {
    tabs = await decryptSnapshot(row.encrypted_blob, row.iv, key, row.enc_version, {
      userId,
      deviceId: row.device_id,
      capturedAt: row.captured_at,
    });
  } catch {
    error = 'Could not decrypt this snapshot (wrong key, or it was altered).';
  }
  let label: string | null = null;
  if (row.label_enc && row.label_iv) {
    try {
      label = await decryptLabel(row.label_enc, row.label_iv, key, userId, row.id);
    } catch {
      label = null;
    }
  }
  return { row, tabs, error, label };
}

export function decryptRows(rows: SnapshotWithDevice[], key: CryptoKey, userId: string) {
  return Promise.all(rows.map(r => decryptRow(r, key, userId)));
}

/** Opens a URL in a new tab, but only http(s). Returns false if blocked. */
export function openSafe(url: string): boolean {
  if (!isSafeTabUrl(url)) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

export interface TabDiff {
  added: TabSnapshot[];
  removed: TabSnapshot[];
}

/** Multiset diff by URL: what `to` has that `from` lacks (added), and vice versa (removed). */
export function diffTabs(from: TabSnapshot[], to: TabSnapshot[]): TabDiff {
  const count = (tabs: TabSnapshot[]) => {
    const m = new Map<string, number>();
    for (const t of tabs) m.set(t.url, (m.get(t.url) ?? 0) + 1);
    return m;
  };
  const pick = (tabs: TabSnapshot[], other: Map<string, number>) => {
    const budget = new Map(other);
    const out: TabSnapshot[] = [];
    for (const t of tabs) {
      const left = budget.get(t.url) ?? 0;
      if (left > 0) budget.set(t.url, left - 1);
      else out.push(t);
    }
    return out;
  };
  return { added: pick(to, count(from)), removed: pick(from, count(to)) };
}

export function groupByWindow(tabs: TabSnapshot[]): TabSnapshot[][] {
  const map = new Map<number, TabSnapshot[]>();
  for (const t of tabs) {
    const list = map.get(t.windowId) ?? [];
    list.push(t);
    map.set(t.windowId, list);
  }
  return [...map.values()].map(list => [...list].sort((a, b) => a.index - b.index));
}

export function safeUrls(tabs: TabSnapshot[]): string[] {
  return tabs.map(t => t.url).filter(isSafeTabUrl);
}
