/**
 * Client-side export of decrypted tabs. The produced files are NOT encrypted; the UI must say so
 * and ask for confirmation before calling downloadBlob().
 */

import type { TabSnapshot } from '@vaulttabs/shared';
import { isSafeTabUrl } from '@vaulttabs/shared/crypto';
import { toDate } from './format';

export interface ExportSource {
  title: string;
  deviceName: string;
  capturedAt: string | Date;
  tabs: TabSnapshot[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unixSeconds(v: string | Date): number {
  const t = toDate(v).getTime();
  return Number.isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000);
}

export function buildJson(sources: ExportSource[]): string {
  return JSON.stringify(
    {
      format: 'vaulttabs-export',
      version: 1,
      exported_at: new Date().toISOString(),
      encrypted: false,
      snapshots: sources.map(s => ({
        title: s.title,
        device_name: s.deviceName,
        captured_at: toDate(s.capturedAt).toISOString(),
        tabs: s.tabs.map(t => ({
          url: t.url,
          title: t.title,
          window_id: t.windowId,
          index: t.index,
          pinned: t.pinned,
          active: t.active,
        })),
      })),
    },
    null,
    2,
  );
}

/** Netscape bookmark file — importable by Chrome, Firefox, Safari, Edge, Brave… */
export function buildBookmarksHtml(sources: ExportSource[]): string {
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">VaultTabs export ${escapeHtml(new Date().toISOString().slice(0, 10))}</H3>`,
    '    <DL><p>',
  ];
  for (const s of sources) {
    const added = unixSeconds(s.capturedAt);
    lines.push(`        <DT><H3 ADD_DATE="${added}">${escapeHtml(s.title)}</H3>`);
    lines.push('        <DL><p>');
    for (const t of s.tabs) {
      if (!isSafeTabUrl(t.url)) continue;
      lines.push(
        `            <DT><A HREF="${escapeHtml(t.url)}" ADD_DATE="${added}">${escapeHtml(t.title || t.url)}</A>`,
      );
    }
    lines.push('        </DL><p>');
  }
  lines.push('    </DL><p>', '</DL><p>', '');
  return lines.join('\n');
}

export function downloadBlob(content: string, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportFilename(ext: 'json' | 'html'): string {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return `vaulttabs-export-${stamp}.${ext}`;
}
