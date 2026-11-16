'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { LogoMark } from '@/components/ui/Logo';
import styles from './auth.module.css';

interface Props {
  subtitle: string;
  log?: string[];
  busy?: boolean;
  wide?: boolean;
  children: ReactNode;
}

/** Common frame for login / register / unlock / recover. */
export function AuthShell({ subtitle, log = [], busy, wide, children }: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  return (
    <main className={styles.root}>
      <div className={styles.scanline} aria-hidden="true" />
      <div className={`${styles.container} ${wide ? styles.wide : ''}`}>
        <Link href="/" className={styles.logo} style={{ textDecoration: 'none' }} aria-label="VaultTabs home">
          <LogoMark />
          <div>
            <div className={styles.logoName}>VaultTabs</div>
            <div className={styles.logoSub}>{subtitle}</div>
          </div>
        </Link>

        {log.length > 0 && (
          <div className={styles.terminal} ref={logRef} role="log" aria-live="polite" aria-label="Progress">
            {log.map((line, i) => (
              <div key={i} className={styles.termLine}>
                <span className={styles.termPrefix} aria-hidden="true">
                  $
                </span>
                <span>{line}</span>
              </div>
            ))}
            {busy && (
              <span className={styles.cursor} aria-hidden="true">
                ▋
              </span>
            )}
          </div>
        )}

        {children}
      </div>
    </main>
  );
}

export function PasswordStrengthMeter({ score, label }: { score: number; label: string }) {
  return (
    <div className={styles.strength} aria-live="polite">
      <div className={styles.strengthBar} aria-hidden="true">
        {[1, 2, 3, 4].map(i => (
          <span
            key={i}
            className={`${styles.strengthSeg} ${i <= score ? styles[`strengthOn${score}` as keyof typeof styles] : ''}`}
          />
        ))}
      </div>
      <span className={styles.strengthLabel}>{label ? `Strength: ${label}` : ''}</span>
    </div>
  );
}
