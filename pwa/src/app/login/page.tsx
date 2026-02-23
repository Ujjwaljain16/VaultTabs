'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiLogin } from '@/lib/api';
import { deriveWrappingKey, decryptMasterKey } from '@/lib/crypto';
import { saveSession, saveMasterKey, loadSession, loadMasterKey } from '@/lib/storage';
import styles from './login.module.css';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'deriving' | 'decrypting'>('idle');
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // If already logged in, go straight to dashboard
  useEffect(() => {
    (async () => {
      const session = loadSession();
      const key = await loadMasterKey();
      if (session && key) router.replace('/dashboard');
    })();
  }, [router]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function addLog(msg: string) {
    setLog(prev => [...prev, msg]);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLog([]);

    if (!email || !password) {
      setError('Email and password required.');
      return;
    }

    try {
      // ── Step 1: Authenticate ─────────────────────────────────────────────
      setPhase('connecting');
      addLog('> connecting to vault server...');

      const result = await apiLogin(email, password);

      if (!result.ok || !result.data) {
        setPhase('idle');
        setError(result.error || 'Login failed. Check your credentials.');
        return;
      }

      addLog('> authentication successful');
      addLog('> fetching encrypted key material...');

      const { token, user, crypto: cryptoData } = result.data;

      if (!cryptoData) {
        setPhase('idle');
        setError('Server error: missing cryptographic data.');
        return;
      }

      // ── Step 2: Derive wrapping key (slow — PBKDF2 100k rounds) ──────────
      setPhase('deriving');
      addLog('> running PBKDF2 × 100,000 iterations...');
      addLog('> (this takes ~1 second by design)');

      const wrappingKey = await deriveWrappingKey(password, cryptoData.salt);
      addLog('> wrapping key derived');

      // ── Step 3: Decrypt master key ────────────────────────────────────────
      setPhase('decrypting');
      addLog('> decrypting master key with AES-256-GCM...');

      let masterKey: CryptoKey;
      try {
        masterKey = await decryptMasterKey(
          cryptoData.encrypted_master_key,
          cryptoData.master_key_iv,
          wrappingKey
        );
      } catch {
        setPhase('idle');
        setError('Decryption failed. Wrong password?');
        addLog('> ERROR: master key decryption failed');
        return;
      }

      addLog('> master key decrypted');
      addLog('> server never saw your password or key');
      addLog('> loading dashboard...');

      // ── Step 4: Persist & redirect ────────────────────────────────────────
      saveSession({
        jwt_token: token,
        user_id: user.id,
        user_email: user.email,
        encrypted_master_key: cryptoData.encrypted_master_key,
        master_key_iv: cryptoData.master_key_iv,
        salt: cryptoData.salt,
      });
      await saveMasterKey(masterKey);

      // Small delay so user can read the final log line
      await new Promise(r => setTimeout(r, 400));
      router.push('/dashboard');

    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'Unexpected error.');
      addLog(`> ERROR: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  const isLoading = phase !== 'idle';

  return (
    <div className={styles.root}>
      {/* Scan line effect */}
      <div className={styles.scanline} />

      <div className={styles.container}>
        {/* Logo */}
        <div className={styles.logo}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#0f0f0f" />
            <path d="M16 6L8 10V16C8 20.4 11.6 24.5 16 26C20.4 24.5 24 20.4 24 16V10L16 6Z"
              fill="#39ff85" opacity="0.9" />
            <path d="M13 16L15 18L19 14" stroke="#080808" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <div className={styles.logoName}>VaultTabs</div>
            <div className={styles.logoSub}>zero-knowledge tab sync</div>
          </div>
        </div>

        {/* Terminal log — shown during login process */}
        {log.length > 0 && (
          <div className={styles.terminal} ref={logRef}>
            {log.map((line, i) => (
              <div key={i} className={styles.termLine}>
                <span className={styles.termPrefix}>$</span>
                <span>{line}</span>
              </div>
            ))}
            {isLoading && <span className={styles.cursor}>▋</span>}
          </div>
        )}

        {/* Login form */}
        <form className={styles.form} onSubmit={handleLogin}>
          <div className={styles.field}>
            <label className={styles.label}>EMAIL</label>
            <input
              type="email"
              className={styles.input}
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={isLoading}
              required
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>PASSWORD</label>
            <input
              type="password"
              className={styles.input}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              disabled={isLoading}
              required
            />
          </div>

          {error && (
            <div className={styles.error}>
              <span className={styles.errorIcon}>Error:</span> {error}
            </div>
          )}

          <button
            type="submit"
            className={styles.btn}
            disabled={isLoading}
          >
            {phase === 'idle' && '→ UNLOCK VAULT'}
            {phase === 'connecting' && '○ CONNECTING...'}
            {phase === 'deriving' && '○ DERIVING KEY...'}
            {phase === 'decrypting' && '○ DECRYPTING...'}
          </button>

          <a href="/recover" className={styles.forgotLink}>
            Forgot password? Use recovery key →
          </a>
        </form>

        {/* Zero-knowledge note */}
        <div className={styles.zkNote}>
          <span className={styles.zkIcon}>◈</span>
          <span>
            Your password never leaves this device.
            All decryption happens locally in your browser.
          </span>
        </div>
      </div>
    </div>
  );
}