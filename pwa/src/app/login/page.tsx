'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/auth/AuthShell';
import styles from '@/components/auth/auth.module.css';
import { errorMessage } from '@/lib/api';
import { LegacyUpgradeRequiredError, login } from '@/lib/auth';
import { SECURITY_MODEL_URL } from '@/lib/config';
import { getLockSettings, getMasterKey, getSession } from '@/lib/session';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [legacyNotice, setLegacyNotice] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get('reason');
    if (reason === 'expired')
      setNotice('Your session ended (expired or signed out elsewhere). Please sign in again.');
    else if (reason === 'recovered') setNotice('Password reset. Sign in with your new password.');
    else if (reason === 'deleted') setNotice('Your account and all its data were deleted.');
    setRemember(getLockSettings().rememberBrowser);

    (async () => {
      const session = getSession();
      if (!session) return;
      setEmail(session.user.email);
      if (await getMasterKey()) router.replace('/dashboard');
      else if (!reason) router.replace('/unlock');
    })();
  }, [router]);

  async function onSubmit(e: { preventDefault(): void }, allowLegacy = false) {
    e.preventDefault();
    setError('');
    if (!allowLegacy) setLegacyNotice('');
    setLog([]);
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    setBusy(true);
    try {
      await login(email.trim(), password, remember, msg => setLog(prev => [...prev, msg]), { allowLegacy });
      setLegacyNotice('');
      setLog(prev => [...prev, 'vault unlocked']);
      setPassword('');
      router.replace('/dashboard');
    } catch (err) {
      if (err instanceof LegacyUpgradeRequiredError) {
        setLegacyNotice(err.message);
        setBusy(false);
        return;
      }
      setError(errorMessage(err, 'Sign-in failed.'));
      setLog(prev => [...prev, 'ERROR']);
      setBusy(false);
    }
  }

  return (
    <AuthShell subtitle="end-to-end encrypted tab sync" log={log} busy={busy}>
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="email">
            EMAIL
          </label>
          <input
            id="email"
            type="email"
            className={styles.input}
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
            disabled={busy}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            PASSWORD
          </label>
          <input
            id="password"
            type="password"
            className={styles.input}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Your password"
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
          <span>
            Remember this browser — keep the vault unlocked across reloads (only on a device you trust).
          </span>
        </label>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        {legacyNotice ? (
          <>
            <div className={styles.notice} role="alert">
              {legacyNotice}
            </div>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={e => void onSubmit(e, true)}
            >
              {busy ? '○ UPGRADING…' : '→ CONTINUE & UPGRADE ACCOUNT'}
            </button>
          </>
        ) : (
          <button type="submit" className={styles.btn} disabled={busy}>
            {busy ? '○ UNLOCKING…' : '→ SIGN IN & UNLOCK'}
          </button>
        )}

        <div className={styles.links}>
          <Link href="/recover" className={styles.forgotLink}>
            Forgot password? Use recovery code
          </Link>
          <Link href="/register" className={styles.forgotLink}>
            Create account →
          </Link>
        </div>
      </form>

      <div className={styles.zkNote}>
        <span className={styles.zkIcon} aria-hidden="true">
          ◈
        </span>
        <span>
          Your password never leaves this device: it derives a separate sign-in key and the key that unlocks
          your tabs. Decryption happens locally. (Accounts created before v2 send the password once, over
          HTTPS, to upgrade.){' '}
          <a href={SECURITY_MODEL_URL} target="_blank" rel="noopener noreferrer">
            Security model
          </a>
        </span>
      </div>
    </AuthShell>
  );
}
