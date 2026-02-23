'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './recover.module.css';

// ── API helpers ───────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> || {}) } });
    const text = await res.text();
    if (!text) return { ok: res.ok };
    const json = JSON.parse(text);
    if (!res.ok) return { ok: false, error: (json as Record<string, string>)?.message || (json as Record<string, string>)?.error || `HTTP ${res.status}` };
    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

// ── Crypto helpers (inline — no dependency on extension) ──────────────────────

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(input: string, salt: string, iterations: number, usage: KeyUsage[]): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(input), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: base64ToBuffer(salt), iterations, hash: 'SHA-256' },
    raw, { name: 'AES-GCM', length: 256 }, false, usage
  );
}

async function unwrapMasterKey(encryptedKey: string, iv: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw', base64ToBuffer(encryptedKey), wrappingKey,
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    { name: 'AES-GCM', length: 256 },
    true, ['encrypt', 'decrypt']
  );
}

async function wrapMasterKey(masterKey: CryptoKey, wrappingKey: CryptoKey): Promise<{ encryptedMasterKey: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('raw', masterKey, wrappingKey, { name: 'AES-GCM', iv });
  return { encryptedMasterKey: bufferToBase64(wrapped), iv: bufferToBase64(iv.buffer) };
}

function generateSalt(): string {
  return bufferToBase64(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[-\s]/g, '').toUpperCase();
}

async function hashRecoveryCode(recoveryCode: string): Promise<string> {
  const codeBytes = new TextEncoder().encode(normalizeRecoveryCode(recoveryCode));
  const hashBuffer = await crypto.subtle.digest('SHA-256', codeBytes);
  return bufferToBase64(hashBuffer);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = 'form' | 'deriving' | 'success' | 'error';

interface RecoveryData {
  recovery_encrypted_master_key: string;
  recovery_key_iv: string;
  recovery_key_salt: string;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RecoverPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [recoveryCode, setCode] = useState('');
  const [newPassword, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [phaseLabel, setPhaseLabel] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  function setStep(label: string) {
    setPhaseLabel(label);
    setPhase('deriving');
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');

    if (!email || !recoveryCode || !newPassword || !confirmPwd) {
      setErrorMsg('All fields are required.'); return;
    }
    if (newPassword !== confirmPwd) {
      setErrorMsg('New passwords do not match.'); return;
    }
    if (newPassword.length < 8) {
      setErrorMsg('New password must be at least 8 characters.'); return;
    }

    try {
      // ── Step 1: Fetch recovery data from server ─────────────────────────────
      setStep('Fetching encrypted key material...');

      const { apiGetRecoveryMaterial } = await import('@/lib/api');
      const dataResult = await apiGetRecoveryMaterial(email);

      if (!dataResult.ok || !dataResult.data) {
        throw new Error(dataResult.error || 'Failed to fetch recovery data. Is this email correct?');
      }

      const {
        recovery_encrypted_master_key,
        recovery_key_iv,
        recovery_key_salt
      } = dataResult.data;

      // ── Step 2: Derive wrapping key from recovery code ──────────────────────
      setStep('Deriving key from recovery code (50,000 PBKDF2 rounds)...');

      const normalized = normalizeRecoveryCode(recoveryCode);
      // deriveKey already handles the normalization internally if called with normalized
      const recoveryWrapKey = await deriveKey(normalized, recovery_key_salt, 50_000, ['unwrapKey']);

      // ── Step 3: Decrypt master key ──────────────────────────────────────────
      setStep('Decrypting master key with recovery code...');

      let masterKey: CryptoKey;
      try {
        masterKey = await unwrapMasterKey(recovery_encrypted_master_key, recovery_key_iv, recoveryWrapKey);
      } catch {
        throw new Error('Invalid recovery code. Check every character and try again.');
      }

      // ── Step 4: Re-encrypt master key with new password ─────────────────────
      setStep('Re-encrypting master key with new password...');

      const newSalt = generateSalt();
      const newWrapKey = await deriveKey(newPassword, newSalt, 100_000, ['wrapKey']);
      const { encryptedMasterKey: newEncKey, iv: newIv } = await wrapMasterKey(masterKey, newWrapKey);

      // ── Step 5: Send to server ──────────────────────────────────────────────
      setStep('Saving new password to server...');

      const recoveryCodeHash = await hashRecoveryCode(normalized);

      const recoverResult = await apiFetch('/auth/recover', {
        method: 'POST',
        body: JSON.stringify({
          email,
          recovery_code: recoveryCodeHash,
          new_password: newPassword,
          new_encrypted_master_key: newEncKey,
          new_master_key_iv: newIv,
          new_salt: newSalt,
        }),
      });

      if (!recoverResult.ok) {
        throw new Error(recoverResult.error || 'Recovery failed. The server rejected the request.');
      }

      setPhase('success');

    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unexpected error');
      setPhase('error');
    }
  }

  // ── Success screen ──────────────────────────────────────────────────────────
  if (phase === 'success') {
    return (
      <div className={styles.root}>
        <div className={styles.card}>
          <div className={styles.successIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </div>
          <div className={styles.title}>Account Recovered</div>
          <div className={styles.desc}>
            Your password has been updated and your encryption keys are intact.
            Your recovery code has been used and is now invalid — a new one was not generated.
            Log in to set up a new recovery key.
          </div>
          <button className={styles.btn} onClick={() => router.push('/login')}>
            → Go to Login
          </button>
        </div>
      </div>
    );
  }

  // ── Progress screen ─────────────────────────────────────────────────────────
  if (phase === 'deriving') {
    return (
      <div className={styles.root}>
        <div className={styles.card}>
          <div className={styles.spinner} />
          <div className={styles.title}>Recovering account</div>
          <div className={styles.phaseLabel}>{phaseLabel}</div>
          <div className={styles.zkNote}>
            All decryption happens in your browser. The server never sees your key.
          </div>
        </div>
      </div>
    );
  }

  // ── Form screen ─────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>
      <div className={styles.card}>
        {/* Logo */}
        <div className={styles.logo}>
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#0f0f0f" />
            <path d="M16 6L8 10V16C8 20.4 11.6 24.5 16 26C20.4 24.5 24 20.4 24 16V10L16 6Z" fill="#39ff85" opacity="0.9" />
            <path d="M13 16L15 18L19 14" stroke="#080808" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={styles.logoName}>Account Recovery</span>
        </div>

        <div className={styles.desc}>
          Enter your recovery code to set a new password.
          Your encrypted data will remain intact.
        </div>

        {(phase === 'error') && (
          <div className={styles.error}>
            <span className={styles.errorIcon}>Error:</span> {errorMsg}
          </div>
        )}

        <form className={styles.form} onSubmit={handleRecover}>
          <div className={styles.field}>
            <label className={styles.label}>EMAIL</label>
            <input type="email" className={styles.input} value={email}
              onChange={e => setEmail(e.target.value)} placeholder="your@email.com" required />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>RECOVERY CODE</label>
            <input
              type="text" className={`${styles.input} ${styles.codeInput}`}
              value={recoveryCode}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="VAULT-XXXX-XXXX-XXXX-XXXX"
              spellCheck={false} autoCorrect="off" autoCapitalize="characters"
              required
            />
            <div className={styles.fieldHint}>Dashes are optional — VAULTXXXXXXXXXXXXXXXXXXXX also works</div>
          </div>

          <div className={styles.divider}>New password</div>

          <div className={styles.field}>
            <label className={styles.label}>NEW PASSWORD</label>
            <input type="password" className={styles.input} value={newPassword}
              onChange={e => setNewPwd(e.target.value)} placeholder="Min 8 characters" required minLength={8} />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>CONFIRM NEW PASSWORD</label>
            <input type="password" className={styles.input} value={confirmPwd}
              onChange={e => setConfirmPwd(e.target.value)} placeholder="Same password again" required />
          </div>

          <button type="submit" className={styles.btn}>
            → RECOVER ACCOUNT
          </button>
        </form>

        <button className={styles.backLink} onClick={() => router.push('/login')}>
          ← Back to login
        </button>
      </div>
    </div>
  );
}