'use client';

import { useState } from 'react';
import { downloadBlob } from '@/lib/export';
import styles from './ui.module.css';

interface Props {
  code: string;
  email?: string;
  continueLabel?: string;
  onContinue: () => void;
}

/** Shows a recovery code exactly once, with copy / download and an "I saved it" gate. */
export function RecoveryCodePanel({ code, email, continueLabel = 'Continue', onContinue }: Props) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  function download() {
    const text = [
      'VaultTabs recovery code',
      '=======================',
      '',
      email ? `Account: ${email}` : '',
      `Created: ${new Date().toISOString()}`,
      '',
      code,
      '',
      'This code is the ONLY way to regain access to your encrypted tabs if you forget your password.',
      'Anyone with this code and your email can reset your password. Store it offline (password manager,',
      'printed copy). VaultTabs cannot recover it for you. Generating a new code invalidates this one.',
      '',
    ]
      .filter((l, i, a) => l !== '' || a[i - 1] !== '')
      .join('\n');
    downloadBlob(text, 'vaulttabs-recovery-code.txt', 'text/plain;charset=utf-8');
  }

  return (
    <section className={styles.recoveryPanel} aria-labelledby="recovery-title">
      <h2 id="recovery-title" className={styles.recoveryTitle}>
        Save your recovery code
      </h2>
      <p className={styles.recoveryText}>
        If you forget your password, this code is the only way back into your encrypted tabs. It is shown{' '}
        <strong>once</strong>. VaultTabs cannot recover it for you.
      </p>
      <output className={styles.recoveryCode} aria-label="Recovery code">
        {code}
      </output>
      <div className={styles.row}>
        <button type="button" className={styles.btnSecondary} onClick={copy}>
          {copied === 'ok' ? '✓ Copied' : 'Copy'}
        </button>
        <button type="button" className={styles.btnSecondary} onClick={download}>
          Download .txt
        </button>
      </div>
      {copied === 'fail' && (
        <p className={styles.hint} role="alert">
          Copy failed. Select the code and copy it manually.
        </p>
      )}
      <label className={styles.checkboxRow}>
        <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />
        <span>I saved my recovery code somewhere safe.</span>
      </label>
      <button type="button" className={styles.btnPrimary} disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </button>
    </section>
  );
}
