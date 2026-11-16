'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/auth/AuthShell';
import styles from '@/components/auth/auth.module.css';
import { errorMessage } from '@/lib/api';
import { WrongPasswordError, unlock } from '@/lib/auth';
import { clearLocalSession, getLockSettings, getMasterKey, getSession } from '@/lib/session';

/** Only allow same-origin, absolute-path redirects (no //evil.com, no schemes). */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard';
  return raw;
}

export default function UnlockPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nextRef = useRef('/dashboard');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nextRef.current = safeNext(new URLSearchParams(window.location.search).get('next'));
    const session = getSession();
    if (!session) {
      router.replace('/login');
      return;
    }
    setEmail(session.user.email);
    setRemember(getLockSettings().rememberBrowser);
    (async () => {
      if (await getMasterKey()) router.replace(nextRef.current);
      else inputRef.current?.focus();
    })();
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    setError('');
    setBusy(true);
    try {
      await unlock(password, remember);
      setPassword('');
      router.replace(nextRef.current);
    } catch (err) {
      setError(
        err instanceof WrongPasswordError ? 'Wrong password.' : errorMessage(err, 'Could not unlock.'),
      );
      setBusy(false);
    }
  }

  async function onSignOut() {
    await clearLocalSession();
    router.replace('/login');
  }

  if (email === null) {
    return <AuthShell subtitle="vault locked">{null}</AuthShell>;
  }

  return (
    <AuthShell
      subtitle="vault locked"
      log={busy ? ['deriving key locally (no network needed)…'] : []}
      busy={busy}
    >
      <div>
        <h1 className={styles.title}>Unlock your vault</h1>
        <p className={styles.desc}>
          Signed in as <strong>{email}</strong>. Your key was cleared from this browser; enter your password
          to decrypt your tabs. This happens entirely on this device.
        </p>
      </div>
      <form className={styles.form} onSubmit={onSubmit}>
        {/* Hidden username field helps password managers pick the right entry. */}
        <input type="email" value={email} autoComplete="username" readOnly hidden />
        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            PASSWORD
          </label>
          <input
            ref={inputRef}
            id="password"
            type="password"
            className={styles.input}
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
            required
          />
        </div>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            disabled={busy}
          />
          <span>Remember this browser</span>
        </label>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <button type="submit" className={styles.btn} disabled={busy || !password}>
          {busy ? '○ UNLOCKING…' : '→ UNLOCK'}
        </button>
        <button
          type="button"
          className={styles.forgotLink}
          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          onClick={onSignOut}
        >
          Not you? Sign out of this browser
        </button>
      </form>
    </AuthShell>
  );
}
