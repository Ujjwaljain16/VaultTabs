'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LIMITS } from '@vaulttabs/shared';
import { isWellFormedRecoveryCode } from '@vaulttabs/shared/crypto';
import { AuthShell, PasswordStrengthMeter } from '@/components/auth/AuthShell';
import styles from '@/components/auth/auth.module.css';
import { RecoveryCodePanel } from '@/components/ui/RecoveryCodePanel';
import { errorMessage } from '@/lib/api';
import { passwordStrength, recover } from '@/lib/auth';

export default function RecoverPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [newCode, setNewCode] = useState<string | null>(null);

  const strength = passwordStrength(password);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim() || !code.trim()) return setError('Email and recovery code are required.');
    if (!isWellFormedRecoveryCode(code)) {
      return setError('That does not look like a recovery code (VAULT-XXXX-XXXX-XXXX-XXXX-XXXX).');
    }
    if (password.length < LIMITS.minPasswordChars) {
      return setError(`New password must be at least ${LIMITS.minPasswordChars} characters.`);
    }
    if (password !== confirm) return setError('New passwords do not match.');
    if (strength.score < 2) return setError('That password is too easy to guess. Try a longer passphrase.');

    setBusy(true);
    setLog([]);
    try {
      const fresh = await recover(email.trim(), code, password, msg => setLog(prev => [...prev, msg]));
      setPassword('');
      setConfirm('');
      setCode('');
      setNewCode(fresh);
    } catch (err) {
      setError(errorMessage(err, 'Recovery failed.'));
    } finally {
      setBusy(false);
    }
  }

  if (newCode) {
    return (
      <AuthShell subtitle="account recovered" wide>
        <div className={styles.notice} role="status">
          Your password was reset and every existing session was signed out. Your old recovery code no longer
          works — here is your new one.
        </div>
        <RecoveryCodePanel
          code={newCode}
          email={email.trim()}
          continueLabel="→ Sign in"
          onContinue={() => router.replace('/login?reason=recovered')}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="account recovery" log={log} busy={busy}>
      <p className={styles.desc}>
        Your recovery code unwraps your master key in this browser; the server only checks a hash of it. You
        choose a new password and receive a new recovery code.
      </p>
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
            autoComplete="username"
            disabled={busy}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="code">
            RECOVERY CODE
          </label>
          <input
            id="code"
            className={styles.input}
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="VAULT-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={busy}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            NEW PASSWORD
          </label>
          <input
            id="password"
            type="password"
            className={styles.input}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={`At least ${LIMITS.minPasswordChars} characters`}
            autoComplete="new-password"
            maxLength={LIMITS.maxPasswordChars}
            disabled={busy}
            required
          />
          <PasswordStrengthMeter score={strength.score} label={strength.label} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="confirm">
            CONFIRM NEW PASSWORD
          </label>
          <input
            id="confirm"
            type="password"
            className={styles.input}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            required
          />
        </div>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <button type="submit" className={styles.btn} disabled={busy}>
          {busy ? '○ RECOVERING…' : '→ RESET PASSWORD'}
        </button>
        <Link href="/login" className={styles.forgotLink}>
          ← Back to sign in
        </Link>
      </form>
    </AuthShell>
  );
}
