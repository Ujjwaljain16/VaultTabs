'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LIMITS } from '@vaulttabs/shared';
import { AuthShell, PasswordStrengthMeter } from '@/components/auth/AuthShell';
import styles from '@/components/auth/auth.module.css';
import { RecoveryCodePanel } from '@/components/ui/RecoveryCodePanel';
import { errorMessage, ApiRequestError } from '@/lib/api';
import { passwordStrength, register } from '@/lib/auth';
import { SECURITY_MODEL_URL } from '@/lib/config';
import { getMasterKey, getSession } from '@/lib/session';

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (getSession() && (await getMasterKey())) router.replace('/dashboard');
    })();
    // Mount only: after registering we stay here to show the recovery code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const strength = passwordStrength(password);
  const tooShort = password.length > 0 && password.length < LIMITS.minPasswordChars;
  const mismatch = confirm.length > 0 && password !== confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim()) return setError('Email is required.');
    if (password.length < LIMITS.minPasswordChars) {
      return setError(`Use at least ${LIMITS.minPasswordChars} characters.`);
    }
    if (password.length > LIMITS.maxPasswordChars) return setError('That password is too long.');
    if (password !== confirm) return setError('Passwords do not match.');
    if (strength.score < 2) return setError('That password is too easy to guess. Try a longer passphrase.');

    setBusy(true);
    setLog([]);
    try {
      const code = await register(email.trim(), password, remember, msg => setLog(prev => [...prev, msg]));
      setLog(prev => [...prev, 'account created']);
      setPassword('');
      setConfirm('');
      setRecoveryCode(code);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 409
          ? 'An account with this email already exists.'
          : errorMessage(err, 'Registration failed.'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCode) {
    return (
      <AuthShell subtitle="account created" wide>
        <RecoveryCodePanel
          code={recoveryCode}
          email={email.trim()}
          continueLabel="→ Open my vault"
          onContinue={() => {
            setRecoveryCode(null);
            router.replace('/dashboard');
          }}
        />
        <div className={styles.zkNote}>
          <span className={styles.zkIcon} aria-hidden="true">
            ◈
          </span>
          <span>
            Next: install the VaultTabs extension in each browser and sign in there with the same account.
          </span>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="create an account" log={log} busy={busy}>
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
            placeholder={`At least ${LIMITS.minPasswordChars} characters`}
            autoComplete="new-password"
            minLength={LIMITS.minPasswordChars}
            maxLength={LIMITS.maxPasswordChars}
            aria-describedby="pw-hint"
            aria-invalid={tooShort || undefined}
            disabled={busy}
            required
          />
          <PasswordStrengthMeter score={strength.score} label={strength.label} />
          <span id="pw-hint" className={styles.fieldHint}>
            A long passphrase (several random words) is best. It encrypts your vault, so it cannot be reset
            without your recovery code.
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="confirm">
            CONFIRM PASSWORD
          </label>
          <input
            id="confirm"
            type="password"
            className={styles.input}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder="Repeat password"
            autoComplete="new-password"
            aria-invalid={mismatch || undefined}
            disabled={busy}
            required
          />
          {mismatch && <span className={styles.fieldHint}>Passwords do not match yet.</span>}
        </div>

        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            disabled={busy}
          />
          <span>Remember this browser (keep the vault unlocked across reloads).</span>
        </label>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        <button type="submit" className={styles.btn} disabled={busy}>
          {busy ? '○ GENERATING KEYS…' : '→ CREATE ACCOUNT'}
        </button>

        <Link href="/login" className={styles.forgotLink}>
          Already have an account? Sign in →
        </Link>
      </form>

      <div className={styles.zkNote}>
        <span className={styles.zkIcon} aria-hidden="true">
          ◈
        </span>
        <span>
          A random master key is generated in this browser and wrapped with a key derived from your password.
          The server only receives a separate derived sign-in key and the wrapped keys, never the password.{' '}
          <a href={SECURITY_MODEL_URL} target="_blank" rel="noopener noreferrer">
            Security model
          </a>
        </span>
      </div>
    </AuthShell>
  );
}
