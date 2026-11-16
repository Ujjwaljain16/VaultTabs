'use client';

import { useRef, useState, type FormEvent } from 'react';
import type { Device } from '@vaulttabs/shared';
import { Dialog } from '@/components/ui/Dialog';
import ui from '@/components/ui/ui.module.css';
import { buildBookmarksHtml, buildJson, downloadBlob, exportFilename, type ExportSource } from '@/lib/export';
import { plural, relativeTime } from '@/lib/format';
import type { RestoreState } from './useRestore';
import styles from './dashboard.module.css';

// ─── Device picker ─────────────────────────────────────────────────────────────────────────────

export function DevicePickerDialog({
  title,
  description,
  devices,
  onPick,
  onClose,
}: {
  title: string;
  description: string;
  devices: Device[];
  onPick: (d: Device) => void;
  onClose: () => void;
}) {
  const sorted = [...devices].sort(
    (a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime(),
  );
  return (
    <Dialog title={title} description={description} onClose={onClose}>
      {sorted.length === 0 ? (
        <p className={ui.hint}>No devices yet. Install the extension and sign in on a browser first.</p>
      ) : (
        <ul className={styles.pickerList}>
          {sorted.map(d => (
            <li key={d.id}>
              <button type="button" className={styles.pickerItem} onClick={() => onPick(d)}>
                <span className={styles.pickerIcon} aria-hidden="true">
                  ◉
                </span>
                <span className={styles.pickerName}>{d.device_name}</span>
                <span className={styles.pickerMeta}>seen {relativeTime(d.last_seen)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={ui.hint}>
        Only that browser can decrypt the request. Single tabs are sent end-to-end encrypted; a full restore
        tells the device which stored (encrypted) snapshot to reopen.
      </p>
    </Dialog>
  );
}

// ─── Restore status ────────────────────────────────────────────────────────────────────────────

export function RestoreStatusDialog({ state, onClose }: { state: RestoreState; onClose: () => void }) {
  if (state.phase === 'idle') return null;
  const busy = state.phase === 'sending' || state.phase === 'waiting';
  const title =
    state.phase === 'sending'
      ? 'Sending…'
      : state.phase === 'waiting'
        ? `Waiting for ${state.deviceName}`
        : state.phase === 'success'
          ? 'Done'
          : state.phase === 'queued'
            ? 'Queued'
            : 'Restore failed';
  return (
    <Dialog title={title} onClose={onClose}>
      <div role="status" aria-live="polite" className={styles.statusBody}>
        {busy && <div className={ui.spinner} aria-hidden="true" style={{ margin: '0 auto' }} />}
        {state.phase === 'sending' && <p className={ui.centerText}>Encrypting and sending the request…</p>}
        {state.phase === 'waiting' && (
          <p className={ui.centerText}>
            <strong>{state.deviceName}</strong> will open the {state.what} as soon as it checks in. Keep that
            browser running.
          </p>
        )}
        {state.phase === 'success' && (
          <>
            <div className={ui.successIcon} aria-hidden="true">
              ✓
            </div>
            <p className={ui.centerText}>
              Opened on <strong>{state.deviceName}</strong>.
            </p>
          </>
        )}
        {state.phase === 'queued' && (
          <p className={ui.centerText}>
            <strong>{state.deviceName}</strong> looks closed. The {state.what} will open there the next time
            that browser starts (kept for 24 hours).
          </p>
        )}
        {state.phase === 'error' && (
          <>
            <div className={ui.errorIcon} aria-hidden="true">
              ✕
            </div>
            <p className={ui.centerText}>{state.message}</p>
          </>
        )}
      </div>
      <button type="button" className={ui.btnSecondary} onClick={onClose}>
        {busy ? 'Stop waiting' : 'Close'}
      </button>
    </Dialog>
  );
}

// ─── Label (save session / rename) ─────────────────────────────────────────────────────────────

export function LabelDialog({
  title,
  description,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  initial: string;
  submitLabel: string;
  onSubmit: (label: string) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = label.trim();
    if (!value) return setError('Give it a name.');
    setBusy(true);
    setError('');
    try {
      await onSubmit(value.slice(0, 200));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      dismissible={!busy}
      initialFocusRef={inputRef}
    >
      <form onSubmit={submit} className={styles.dialogForm}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="session-label">
            Name (encrypted)
          </label>
          <input
            ref={inputRef}
            id="session-label"
            className={ui.input}
            value={label}
            maxLength={200}
            onChange={e => setLabel(e.target.value)}
            disabled={busy}
          />
        </div>
        {error && (
          <div className={ui.error} role="alert">
            {error}
          </div>
        )}
        <div className={ui.row}>
          <button type="button" className={ui.btnGhost} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={ui.btnPrimary} disabled={busy}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Confirm ───────────────────────────────────────────────────────────────────────────────────

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed.');
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} description={message} onClose={onClose} dismissible={!busy}>
      {error && (
        <div className={ui.error} role="alert">
          {error}
        </div>
      )}
      <div className={ui.row}>
        <button type="button" className={ui.btnGhost} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={danger ? ui.btnDanger : ui.btnPrimary} onClick={go} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

// ─── Export ────────────────────────────────────────────────────────────────────────────────────

export function ExportDialog({ sources, onClose }: { sources: ExportSource[]; onClose: () => void }) {
  const [format, setFormat] = useState<'html' | 'json'>('html');
  const [ack, setAck] = useState(false);
  const tabCount = sources.reduce((n, s) => n + s.tabs.length, 0);

  function download() {
    if (format === 'json') downloadBlob(buildJson(sources), exportFilename('json'), 'application/json');
    else downloadBlob(buildBookmarksHtml(sources), exportFilename('html'), 'text/html;charset=utf-8');
    onClose();
  }

  return (
    <Dialog
      title="Export tabs"
      description={`${plural(sources.length, 'snapshot')}, ${plural(tabCount, 'tab')}. The file is generated in this browser.`}
      onClose={onClose}
    >
      <fieldset className={styles.fieldset}>
        <legend className={ui.label}>Format</legend>
        <label className={ui.checkboxRow}>
          <input type="radio" name="format" checked={format === 'html'} onChange={() => setFormat('html')} />
          <span>
            <strong>Bookmarks (.html)</strong> — importable in Chrome, Firefox, Safari, Edge…
          </span>
        </label>
        <label className={ui.checkboxRow}>
          <input type="radio" name="format" checked={format === 'json'} onChange={() => setFormat('json')} />
          <span>
            <strong>JSON</strong> — full data (titles, URLs, windows, pinned state)
          </span>
        </label>
      </fieldset>
      <div className={ui.warning} role="note">
        This file is <strong>NOT encrypted</strong>. Anyone who can read it sees every URL and title in it.
      </div>
      <label className={ui.checkboxRow}>
        <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
        <span>I understand the exported file is not encrypted.</span>
      </label>
      <div className={ui.row}>
        <button type="button" className={ui.btnGhost} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={ui.btnPrimary} onClick={download} disabled={!ack || tabCount === 0}>
          Download
        </button>
      </div>
    </Dialog>
  );
}
