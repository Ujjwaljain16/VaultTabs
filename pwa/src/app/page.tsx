'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadSession, loadMasterKey } from '@/lib/storage';
import styles from './landing.module.css';

export default function RootPage() {
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    async function check() {
      const session = loadSession();
      const masterKey = await loadMasterKey();

      if (session && masterKey) {
        setIsLoggedIn(true);
      }
      setIsReady(true);
    }
    check();
  }, []);

  if (!isReady) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100dvh', background: 'var(--black)',
      }}>
        <div className={styles.spinner}></div>
      </div>
    );
  }

  return (
    <div className={styles.heroContainer}>
      <div className={styles.bgGrid}></div>

      <div className={styles.content}>
        <div className={styles.badge}>
          <span>✓</span> Zero-Knowledge End-to-End Encryption
        </div>

        <h1 className={styles.title}>
          Your Tabs. Everywhere. <br />
          <span className={styles.titleHighlight}>Fully Encrypted.</span>
        </h1>

        <p className={styles.description}>
          VaultTabs syncs your browser tabs across all your devices in real-time.
          Send a tab from your phone to your laptop instantly, with military-grade privacy.
          We never see your data.
        </p>

        <div className={styles.ctas}>
          {isLoggedIn ? (
            <button className={styles.btnPrimary} onClick={() => router.push('/dashboard')}>
              Enter Vault
            </button>
          ) : (
            <>
              <button className={styles.btnPrimary} onClick={() => router.push('/login')}>
                Get Started
              </button>
              <button className={styles.btnSecondary} onClick={() => window.open('https://github.com/Ujjwaljain16/VaultTabs', '_blank')}>
                View Source
              </button>
            </>
          )}
        </div>
      </div>

      <div className={styles.visualContainer}>
        <div className={styles.browserMockup}>
          <div className={styles.browserHeader}>
            <div className={styles.dot}></div>
            <div className={styles.dot}></div>
            <div className={styles.dot}></div>
            <div className={styles.browserTab}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              My Secure Workspace
            </div>
          </div>
          <div className={styles.browserBody}>
            <div className={styles.shieldIcon}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </div>
            {/* Floating Tabs */}
            <div className={`${styles.floatingTab} ${styles.tab1}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#39ff85" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
              Research.pdf
            </div>
            <div className={`${styles.floatingTab} ${styles.tab2}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              Youtube - LoFi
            </div>
            <div className={`${styles.floatingTab} ${styles.tab3}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#39ff85" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
              Project Vault
            </div>
          </div>
        </div>
      </div>

      <div className={styles.features}>
        <div className={styles.featureCard}>
          <div className={styles.featureIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </div>
          <h3 className={styles.featureTitle}>Real-Time Sync</h3>
          <p className={styles.featureDesc}>
            Open a tab on your laptop, and it instantly appears on your dashboard. No manual refreshing required.
          </p>
        </div>

        <div className={styles.featureCard}>
          <div className={styles.featureIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <h3 className={styles.featureTitle}>Window Segregation</h3>
          <p className={styles.featureDesc}>
            Keep your workspaces organized. We group your tabs exactly how they are structured in your browser windows.
          </p>
        </div>

        <div className={styles.featureCard}>
          <div className={styles.featureIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
          </div>
          <h3 className={styles.featureTitle}>Tab Teleporting</h3>
          <p className={styles.featureDesc}>
            Send any active tab to another specific device with a single click. It opens instantly on the target machine.
          </p>
        </div>
      </div>
    </div>
  );
}