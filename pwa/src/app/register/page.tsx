'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiRegister } from '@/lib/api';
import {
    generateSalt,
    deriveWrappingKey,
    generateMasterKey,
    encryptMasterKey,
    generateRecoveryCode,
    encryptMasterKeyForRecovery,
    hashRecoveryCode
} from '@/lib/crypto';
import { saveSession, saveMasterKey, loadSession, loadMasterKey } from '@/lib/storage';
import styles from './register.module.css'; // Re-using login styles

export default function RegisterPage() {
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [phase, setPhase] = useState<'idle' | 'generating' | 'encrypting' | 'registering'>('idle');
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

    async function handleRegister(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        setLog([]);

        if (!email || !password || !confirmPassword) {
            setError('Email and password required.');
            return;
        }

        if (password !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }

        try {
            setPhase('generating');
            addLog('> generating raw cryptographic material...');

            // ── Step 1: Generate master keys & wrap w/ password ───────────────────
            const salt = generateSalt();
            addLog('> running PBKDF2 × 100,000 iterations for password...');
            const wrappingKey = await deriveWrappingKey(password, salt);
            const masterKey = await generateMasterKey();

            setPhase('encrypting');
            addLog('> encrypting master key with AES-256-GCM via password wrap...');
            const { encryptedMasterKey, iv: masterKeyIv } = await encryptMasterKey(masterKey, wrappingKey);

            // ── Step 2: Generate recovery keys & wrap w/ code ───────────────────────
            addLog('> generating emergency offline recovery code...');
            const recoveryCode = generateRecoveryCode();
            const recovery = await encryptMasterKeyForRecovery(masterKey, recoveryCode);
            const recoveryKeyHash = await hashRecoveryCode(recoveryCode);

            // ── Step 3: Register account on backend ─────────────────────────────────
            setPhase('registering');
            addLog('> connecting to vault server for secure payload registration...');

            const result = await apiRegister({
                email,
                password,
                encrypted_master_key: encryptedMasterKey,
                master_key_iv: masterKeyIv,
                salt,
                recovery_encrypted_master_key: recovery.encryptedMasterKey,
                recovery_key_iv: recovery.iv,
                recovery_key_salt: recovery.salt,
                recovery_key_hash: recoveryKeyHash,
            });

            if (!result.ok || !result.data) {
                setPhase('idle');
                setError(result.error || 'Registration failed.');
                return;
            }

            const { token, user } = result.data;
            addLog('> payload accepted. storing encrypted blobs securely...');
            addLog('> keeping your local master key for this session...');

            // ── Step 4: Persist session & master key locally ────────────────────────
            saveSession({
                jwt_token: token,
                user_id: user.id,
                user_email: user.email,
                encrypted_master_key: encryptedMasterKey,
                master_key_iv: masterKeyIv,
                salt: salt,
            });
            await saveMasterKey(masterKey);

            addLog('> DONE ✓');
            addLog('> WARNING: Note your recovery code. It will never be shown again:');
            addLog(`> RECOVERY CODE: ${recoveryCode}`);

            // We pause to ensure the user can read the logs, especially the recovery code.
            // In a real flow, you'd show a dedicated UI step forcing them to copy the recovery code.
            // For this PWA, we'll let them see it for 5 seconds before redirect.
            addLog('> redirecting to dashboard in 4s...');

            await new Promise(r => setTimeout(r, 4000));
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
            <div className={styles.scanline} />

            <div className={styles.container}>
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
                        <div className={styles.logoSub}>Register an Account</div>
                    </div>
                </div>

                {log.length > 0 && (
                    <div className={styles.terminal} ref={logRef}>
                        {log.map((line, i) => (
                            <div key={i} className={styles.termLine}>
                                <span className={styles.termPrefix}>$</span>
                                <span style={line.includes('RECOVERY CODE') ? { color: '#ffb347', fontWeight: 'bold' } : {}}>{line}</span>
                            </div>
                        ))}
                        {isLoading && <span className={styles.cursor}>▋</span>}
                    </div>
                )}

                <form className={styles.form} onSubmit={handleRegister}>
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
                            placeholder="Strong password"
                            autoComplete="new-password"
                            disabled={isLoading}
                            required
                        />
                    </div>

                    <div className={styles.field}>
                        <label className={styles.label}>CONFIRM PASSWORD</label>
                        <input
                            type="password"
                            className={styles.input}
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                            placeholder="Repeat password"
                            autoComplete="new-password"
                            disabled={isLoading}
                            required
                        />
                    </div>

                    {error && (
                        <div className={styles.error}>
                            <span className={styles.errorIcon}>✕</span> {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        className={styles.btn}
                        disabled={isLoading}
                    >
                        {phase === 'idle' && '→ CREATE ACCOUNT'}
                        {phase === 'generating' && '○ GENERATING KEYS...'}
                        {phase === 'encrypting' && '○ ENCRYPTING VAULT...'}
                        {phase === 'registering' && '○ SECURING WITH VAULT SERVER...'}
                    </button>

                    <a href="/login" className={styles.forgotLink}>
                        Already have an account? Login →
                    </a>
                </form>

                <div className={styles.zkNote}>
                    <span className={styles.zkIcon}>◈</span>
                    <span>
                        VaultTabs is End-to-End Encrypted. Your password controls your personal Master Key. If you forget your password and lose your recovery code, data cannot be recovered.
                    </span>
                </div>
            </div>
        </div>
    );
}
