'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { LIMITS, type AccountInfoResponse } from '@vaulttabs/shared';
import { PasswordStrengthMeter } from '@/components/auth/AuthShell';
import { Dialog } from '@/components/ui/Dialog';
import { RecoveryCodePanel } from '@/components/ui/RecoveryCodePanel';
import ui from '@/components/ui/ui.module.css';
import { AppHeader } from '@/components/vault/AppHeader';
import { useVault } from '@/components/vault/VaultProvider';
import { api, errorMessage } from '@/lib/api';
import {
  WrongPasswordError,
  changePassword,
  deleteAccount,
  passwordStrength,
  regenerateRecoveryCode,
  signOutEverywhere,
} from '@/lib/auth';
import { dateTime, formatBytes, relativeTime } from '@/lib/format';
import {
  AUTO_LOCK_OPTIONS,
  getLockSettings,
  setLockSettings,
  setRememberBrowser,
  updateSession,
  type AutoLockMinutes,
} from '@/lib/session';
import styles from './settings.module.css';

function msg(err: unknown, fallback: string): string {
  return err instanceof WrongPasswordError ? 'Current password is wrong.' : errorMessage(err, fallback);
}

function Status({ error, ok }: { error?: string; ok?: string }) {
  if (error)
    return (
      <div className={ui.error} role="alert">
        {error}
      </div>
    );
  if (ok)
    return (
      <div className={ui.notice} role="status">
        {ok}
      </div>
    );
  return null;
}

function Card({ title, danger, children }: { title: string; danger?: boolean; children: ReactNode }) {
  const id = `card-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section className={`${ui.card} ${danger ? ui.cardDanger : ''}`} aria-labelledby={id}>
      <h2 id={id} className={ui.cardTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

// ─── Account & stats ───────────────────────────────────────────────────────────────────────────

function AccountCard() {
  const { session, refreshSession } = useVault();
  const [info, setInfo] = useState<AccountInfoResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .account()
      .then(res => {
        setInfo(res);
        updateSession({ user: res.account });
        refreshSession();
      })
      .catch(err => setError(errorMessage(err, 'Could not load account info.')));
  }, [refreshSession]);

  const user = info?.account ?? session.user;
  return (
    <Card title="Account">
      <dl className={styles.dl}>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Created</dt>
        <dd>{dateTime(user.created_at)}</dd>
        <dt>Key format</dt>
        <dd>
          v{session.crypto.kdf_version} · PBKDF2 × {session.crypto.kdf_iterations.toLocaleString('en-US')}
        </dd>
        <dt>Recovery code</dt>
        <dd>{user.has_recovery_key ? 'set' : 'not set'}</dd>
        {info && (
          <>
            <dt>Devices</dt>
            <dd>{info.stats.device_count}</dd>
            <dt>Snapshots</dt>
            <dd>
              {info.stats.snapshot_count} ({info.stats.saved_count} saved)
            </dd>
            <dt>Storage</dt>
            <dd>{formatBytes(info.stats.storage_bytes)} (encrypted)</dd>
            <dt>Last sync</dt>
            <dd>{info.stats.last_sync_at ? relativeTime(info.stats.last_sync_at) : 'never'}</dd>
          </>
        )}
      </dl>
      <Status error={error} />
    </Card>
  );
}

// ─── Retention ─────────────────────────────────────────────────────────────────────────────────

function RetentionCard() {
  const { session, refreshSession } = useVault();
  const [value, setValue] = useState(String(session.user.snapshot_retention ?? LIMITS.defaultRetention));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error?: string; ok?: string }>({});

  async function save(e: FormEvent) {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < LIMITS.minRetention || n > LIMITS.maxRetention) {
      setStatus({
        error: `Choose a whole number between ${LIMITS.minRetention} and ${LIMITS.maxRetention}.`,
      });
      return;
    }
    setBusy(true);
    setStatus({});
    try {
      const res = await api.setRetention(n);
      updateSession({ user: { ...session.user, snapshot_retention: res.retention } });
      refreshSession();
      setStatus({ ok: `Keeping the last ${res.retention} snapshots per device.` });
    } catch (err) {
      setStatus({ error: errorMessage(err, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="History retention">
      <p className={ui.hint}>
        How many past snapshots to keep per device for time travel. Older ones are deleted on the server;
        saved sessions are never pruned.
      </p>
      <form className={styles.inline} onSubmit={save}>
        <label htmlFor="retention" className={ui.label}>
          Snapshots per device
        </label>
        <input
          id="retention"
          type="number"
          className={ui.input}
          min={LIMITS.minRetention}
          max={LIMITS.maxRetention}
          step={1}
          value={value}
          onChange={e => setValue(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className={ui.btnSecondary} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
      <Status {...status} />
    </Card>
  );
}

// ─── Lock ──────────────────────────────────────────────────────────────────────────────────────

function LockCard() {
  const { lock } = useVault();
  const [remember, setRemember] = useState(false);
  const [autoLock, setAutoLock] = useState<AutoLockMinutes>(15);

  useEffect(() => {
    const s = getLockSettings();
    setRemember(s.rememberBrowser);
    setAutoLock(s.autoLockMinutes);
  }, []);

  return (
    <Card title="Lock & this browser">
      <label className={ui.checkboxRow}>
        <input
          type="checkbox"
          checked={remember}
          onChange={async e => {
            const v = e.target.checked;
            setRemember(v);
            await setRememberBrowser(v);
          }}
        />
        <span>
          Remember this browser — keep the (non-extractable) key in this browser&apos;s storage so reloads
          stay unlocked. Off: the key lives in memory only and every reload asks for your password.
        </span>
      </label>
      <div className={styles.inline}>
        <label htmlFor="autolock" className={ui.label}>
          Auto-lock when idle
        </label>
        <select
          id="autolock"
          className={ui.select}
          value={autoLock}
          onChange={e => {
            const v = Number(e.target.value) as AutoLockMinutes;
            setAutoLock(v);
            setLockSettings({ autoLockMinutes: v });
          }}
        >
          {AUTO_LOCK_OPTIONS.map(m => (
            <option key={m} value={m}>
              {m === 0 ? 'Never' : `After ${m} minutes`}
            </option>
          ))}
        </select>
        <button type="button" className={ui.btnSecondary} onClick={() => void lock()}>
          Lock now
        </button>
      </div>
      <p className={ui.hint}>
        Locking forgets the key on this browser. Unlocking needs only your password, no network.
      </p>
    </Card>
  );
}

// ─── Change password ───────────────────────────────────────────────────────────────────────────

function PasswordCard() {
  const { refreshSession } = useVault();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error?: string; ok?: string }>({});
  const strength = passwordStrength(next);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setStatus({});
    if (next.length < LIMITS.minPasswordChars)
      return setStatus({ error: `Use at least ${LIMITS.minPasswordChars} characters.` });
    if (next !== confirm) return setStatus({ error: 'New passwords do not match.' });
    if (strength.score < 2) return setStatus({ error: 'That password is too easy to guess.' });
    if (next === current) return setStatus({ error: 'The new password is the same as the current one.' });
    setBusy(true);
    try {
      await changePassword(current, next);
      refreshSession();
      setCurrent('');
      setNext('');
      setConfirm('');
      setStatus({
        ok: 'Password changed. All other sessions were signed out; extensions must sign in again.',
      });
    } catch (err) {
      setStatus({ error: msg(err, 'Could not change the password.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Change password">
      <form className={styles.form} onSubmit={submit}>
        <div className={ui.field}>
          <label htmlFor="cp-current" className={ui.label}>
            Current password
          </label>
          <input
            id="cp-current"
            type="password"
            className={ui.input}
            value={current}
            onChange={e => setCurrent(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
            required
          />
        </div>
        <div className={ui.field}>
          <label htmlFor="cp-new" className={ui.label}>
            New password
          </label>
          <input
            id="cp-new"
            type="password"
            className={ui.input}
            value={next}
            onChange={e => setNext(e.target.value)}
            autoComplete="new-password"
            maxLength={LIMITS.maxPasswordChars}
            disabled={busy}
            required
          />
          <PasswordStrengthMeter score={strength.score} label={strength.label} />
        </div>
        <div className={ui.field}>
          <label htmlFor="cp-confirm" className={ui.label}>
            Confirm new password
          </label>
          <input
            id="cp-confirm"
            type="password"
            className={ui.input}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            required
          />
        </div>
        <Status {...status} />
        <button type="submit" className={ui.btnPrimary} disabled={busy || !current}>
          {busy ? 'Re-wrapping key…' : 'Change password'}
        </button>
      </form>
    </Card>
  );
}

// ─── Password-confirmed action dialog (recovery code / delete) ─────────────────────────────────

function PasswordPrompt({
  title,
  description,
  confirmLabel,
  danger,
  typeToConfirm,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirmed = !typeToConfirm || typed.trim() === typeToConfirm;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed || !password) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(password);
    } catch (err) {
      setError(msg(err, 'Failed.'));
      setBusy(false);
    }
  }

  return (
    <Dialog title={title} description={description} onClose={onClose} dismissible={!busy}>
      <form className={styles.form} onSubmit={submit}>
        {typeToConfirm && (
          <div className={ui.field}>
            <label htmlFor="type-confirm" className={ui.label}>
              Type “{typeToConfirm}” to confirm
            </label>
            <input
              id="type-confirm"
              className={ui.input}
              value={typed}
              onChange={e => setTyped(e.target.value)}
              autoComplete="off"
              disabled={busy}
            />
          </div>
        )}
        <div className={ui.field}>
          <label htmlFor="prompt-password" className={ui.label}>
            Current password
          </label>
          <input
            id="prompt-password"
            type="password"
            className={ui.input}
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
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
          <button
            type="submit"
            className={danger ? ui.btnDanger : ui.btnPrimary}
            disabled={busy || !password || !confirmed}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter();
  const { session, refreshSession, signOut } = useVault();
  const [dialog, setDialog] = useState<'recovery' | 'delete' | 'logoutAll' | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<{ error?: string; ok?: string }>({});

  async function logoutAll() {
    setSessionStatus({});
    try {
      await signOutEverywhere();
      refreshSession();
      setSessionStatus({
        ok: 'Every other session (other browsers, extensions) was signed out. This one stays signed in.',
      });
    } catch (err) {
      setSessionStatus({ error: errorMessage(err, 'Could not sign out other sessions.') });
    } finally {
      setDialog(null);
    }
  }

  return (
    <div className={ui.page}>
      <AppHeader />
      <main className={ui.pageMain}>
        <h1 className={ui.cardTitle}>Settings</h1>
        <AccountCard />
        <RetentionCard />
        <LockCard />
        <PasswordCard />

        <Card title="Recovery code">
          {newCode ? (
            <RecoveryCodePanel
              code={newCode}
              email={session.user.email}
              continueLabel="Done"
              onContinue={() => setNewCode(null)}
            />
          ) : (
            <>
              <p className={ui.hint}>
                Generate a new recovery code if you lost the old one or think someone saw it. The previous
                code stops working immediately.
              </p>
              <button type="button" className={ui.btnSecondary} onClick={() => setDialog('recovery')}>
                Generate new recovery code
              </button>
            </>
          )}
        </Card>

        <Card title="Sessions">
          <p className={ui.hint}>
            Sign out every other browser and extension (for example after losing a device). They will need
            your password again.
          </p>
          <div className={ui.row}>
            <button type="button" className={ui.btnSecondary} onClick={() => setDialog('logoutAll')}>
              Sign out everywhere else
            </button>
            <button type="button" className={ui.btnGhost} onClick={() => void signOut()}>
              Sign out of this browser
            </button>
          </div>
          <Status {...sessionStatus} />
        </Card>

        <Card title="Danger zone" danger>
          <p className={ui.hint}>
            Permanently delete your account, all devices, snapshots and saved sessions from the server. This
            cannot be undone.
          </p>
          <button type="button" className={ui.btnDanger} onClick={() => setDialog('delete')}>
            Delete account
          </button>
        </Card>
      </main>

      {dialog === 'recovery' && (
        <PasswordPrompt
          title="New recovery code"
          description="Your password unwraps the master key locally so it can be wrapped under a new code."
          confirmLabel="Generate"
          onSubmit={async pw => {
            const code = await regenerateRecoveryCode(pw);
            refreshSession();
            setNewCode(code);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'delete' && (
        <PasswordPrompt
          title="Delete account"
          description="Everything stored for this account is deleted from the server. Exports you downloaded are not affected."
          confirmLabel="Delete forever"
          danger
          typeToConfirm="DELETE"
          onSubmit={async pw => {
            await deleteAccount(pw);
            router.replace('/login?reason=deleted');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'logoutAll' && (
        <Dialog
          title="Sign out everywhere else?"
          description="All other sessions end immediately."
          onClose={() => setDialog(null)}
        >
          <div className={ui.row}>
            <button type="button" className={ui.btnGhost} onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button type="button" className={ui.btnPrimary} onClick={() => void logoutAll()}>
              Sign out others
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
