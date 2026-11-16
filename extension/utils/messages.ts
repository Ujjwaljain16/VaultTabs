/** Messages exchanged between the popup and the background script. */

export type PopupRequest = { type: 'SYNC_NOW' };

export interface SyncNowResponse {
  ok: boolean;
  error?: string;
}

export type BackgroundBroadcast =
  | { type: 'SYNC_COMPLETE'; tabCount: number; capturedAt: string }
  | { type: 'SYNC_FAILED'; error: string }
  | { type: 'RESTORE_COMPLETE'; tabCount: number };

export function isPopupRequest(value: unknown): value is PopupRequest {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'SYNC_NOW';
}

export function isBackgroundBroadcast(value: unknown): value is BackgroundBroadcast {
  const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined;
  return type === 'SYNC_COMPLETE' || type === 'SYNC_FAILED' || type === 'RESTORE_COMPLETE';
}
