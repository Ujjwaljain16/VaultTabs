'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { loadSession, loadMasterKey } from '@/lib/storage';
import styles from './landing.module.css';

// Hook for scroll animations
function useScrollReveal(isReady: boolean) {
  useEffect(() => {
    if (!isReady) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add(styles.revealed);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    // Use setTimeout to ensure React has painted the DOM
    const timeoutId = setTimeout(() => {
      document.querySelectorAll(`.${styles.reveal}`).forEach(el => observer.observe(el));
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [isReady]);
}

export default function RootPage() {
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useScrollReveal(isReady);

  useEffect(() => {
    async function check() {
      const session = loadSession();
      const masterKey = await loadMasterKey();
      if (session && masterKey) setIsLoggedIn(true);
      setIsReady(true);
    }
    check();
  }, []);

  if (!isReady) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', background: 'var(--black)' }}>
        <div className={styles.spinner}></div>
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      {/* NAVBAR */}
      <nav className={styles.navbar}>
        <div className={styles.logo}>
          <div className={styles.logoIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          VaultTabs
        </div>
        <div className={styles.navLinks}>
          <button className={styles.navBtn} onClick={() => window.open('https://github.com/Ujjwaljain16/VaultTabs', '_blank')}>Source Code</button>
          {isLoggedIn ? (
            <button className={styles.navBtnPrimary} onClick={() => router.push('/dashboard')}>Dashboard</button>
          ) : (
            <button className={styles.navBtnPrimary} onClick={() => router.push('/login')}>Login</button>
          )}
        </div>
      </nav>

      {/* HERO SECTION */}
      <header className={styles.heroContainer}>
        <div className={styles.bgGrid}></div>

        <div className={`${styles.heroContent} ${styles.reveal}`}>
          <div className={styles.badge}>
            <div className={styles.badgePulse}></div>
            Zero-Knowledge Architecture
          </div>

          <h1 className={styles.title}>
            Your Tabs. Everywhere.<br />
            <span className={styles.titleHighlight}>Entirely Private.</span>
          </h1>

          <p className={styles.description}>
            Seamlessly sync your active workspaces across all your devices.
            Send specific tabs instantly where you need them. Secure, fast,
            and entirely private—we never see your data.
          </p>

          <div className={styles.ctas}>
            {isLoggedIn ? (
              <button className={styles.btnPrimary} onClick={() => router.push('/dashboard')}>
                Launch Vault
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
              </button>
            ) : (
              <>
                <button className={styles.btnPrimary} onClick={() => router.push('/login')}>
                  Get Started Free
                </button>
                <button className={styles.btnSecondary} onClick={() => window.open('https://github.com/Ujjwaljain16/VaultTabs', '_blank')}>
                  View architecture
                </button>
              </>
            )}
          </div>
        </div>

        {/* 3D Vis Show */}
        <div className={`${styles.showcase} ${styles.reveal}`}>
          <div className={styles.floatingBrowser}>
            <div className={styles.browserTop}>
              <div className={styles.dots}>
                <div className={styles.dot}></div>
                <div className={styles.dot}></div>
                <div className={styles.dot}></div>
              </div>
              <div className={styles.urlBar}>vault.local/secure</div>
            </div>

            <div className={styles.browserContent}>
              <div className={styles.centerVault}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </div>

              <div className={`${styles.syncTab} ${styles.syncTab1}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                localhost:3000
              </div>

              <div className={`${styles.syncTab} ${styles.syncTab2}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#39ff85" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                Github - VaultTabs
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* CORE FEATURES (Alternating Layout) */}
      <section className={styles.section}>
        <div className={styles.sectionInner}>

          <div className={`${styles.featureRow} ${styles.reveal}`}>
            <div className={styles.featureText}>
              <div className={styles.featureSubtitle}>Continuous Sync</div>
              <h2 className={styles.featureTitle}>Pick up exactly where you left off.</h2>
              <p className={styles.featureDesc}>
                A lightweight engine silently updates your state across devices.
                Whether you switch from laptop to desktop, your tabs are right
                there waiting for you. No manual refreshing required.
              </p>
            </div>
            <div className={styles.featureVisual}>
              <div className={styles.glassCard}>
                <svg width="100%" height="200" viewBox="0 0 400 200" fill="none">
                  <path d="M50 100 Q 200 10 350 100" stroke="rgba(57, 255, 133, 0.4)" strokeWidth="4" strokeDasharray="10 10">
                    <animate attributeName="stroke-dashoffset" from="100" to="0" dur="2s" repeatCount="indefinite" />
                  </path>
                  <circle cx="50" cy="100" r="20" fill="#1e1e1e" stroke="var(--green)" strokeWidth="2" />
                  <circle cx="350" cy="100" r="20" fill="#1e1e1e" stroke="var(--green)" strokeWidth="2" />
                  <rect x="35" y="85" width="30" height="30" rx="4" fill="var(--green)" opacity="0.2" />
                  <rect x="335" y="85" width="30" height="30" rx="4" fill="var(--green)" opacity="0.2" />
                </svg>
              </div>
            </div>
          </div>

          <div className={`${styles.featureRow} ${styles.reveal}`}>
            <div className={styles.featureText}>
              <div className={styles.featureSubtitle}>Teleportation</div>
              <h2 className={styles.featureTitle}>Beam tasks directly to other screens.</h2>
              <p className={styles.featureDesc}>
                Found an interesting article on your phone but want to read it on your monitor? Hit the "Send" icon. It immediately pops open the target browser. No messy links, no email drafts.
              </p>
            </div>
            <div className={styles.featureVisual}>
              <div className={styles.glassCard}>
                <svg width="100%" height="200" viewBox="0 0 400 200" fill="none">
                  <rect x="50" y="40" width="120" height="120" rx="8" fill="var(--black-2)" stroke="var(--border)" />
                  <rect x="230" y="40" width="120" height="120" rx="8" fill="var(--black-2)" stroke="var(--green)" />
                  <path d="M120 100 L 280 100" stroke="var(--green)" strokeWidth="3" markerEnd="url(#arrow)">
                    <animate attributeName="stroke-dashoffset" from="200" to="0" dur="1s" repeatCount="indefinite" strokeDasharray="200" />
                  </path>
                  <circle cx="280" cy="100" r="8" fill="var(--green)">
                    <animate attributeName="r" values="8;16;8" dur="1s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite" />
                  </circle>
                </svg>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* SECURITY GRID */}
      <section className={styles.securitySection}>
        <div className={`${styles.badge} ${styles.reveal}`}>Security Built-In</div>
        <h2 className={`${styles.title} ${styles.reveal}`} style={{ fontSize: 'clamp(32px, 5vw, 56px)' }}>Zero-Knowledge Protocol</h2>
        <p className={`${styles.description} ${styles.reveal}`} style={{ margin: '0 auto' }}>
          Your browsing habits are deeply personal. <br />Our architecture ensures your data remains encrypted and inaccessible to anyone—even us.
        </p>

        <div className={styles.secGrid}>
          <div className={`${styles.secCard} ${styles.reveal}`}>
            <div className={styles.secIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            </div>
            <h4>End-to-End Encrypted</h4>
            <p>Your master key is derived locally from your password using PBKDF2. Data is encrypted using AES-GCM *before* it leaves your browser.</p>
          </div>

          <div className={`${styles.secCard} ${styles.reveal}`}>
            <div className={styles.secIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </div>
            <h4>Server-Blind</h4>
            <p>Our PostgreSQL database stores only indecipherable blobs and salted hashes. Even in the event of a breach, your data is cryptographically secure.</p>
          </div>

          <div className={`${styles.secCard} ${styles.reveal}`}>
            <div className={styles.secIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
            </div>
            <h4>Open Source Core</h4>
            <p>Verify exactly how your data is treated. The entire Sync Engine, cryptography layer, and backend API are open for audit on GitHub.</p>
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <footer className={styles.footerCta}>
        <div className={`${styles.reveal}`}>
          <h2>Ready for a better browsing experience?</h2>
          {isLoggedIn ? (
            <button className={styles.btnPrimary} style={{ margin: '0 auto' }} onClick={() => router.push('/dashboard')}>
              Go to Dashboard
            </button>
          ) : (
            <button className={styles.btnPrimary} style={{ margin: '0 auto' }} onClick={() => router.push('/login')}>
              Create Secure Account
            </button>
          )}
        </div>
      </footer>

      <div className={styles.footer}>
        © {new Date().getFullYear()} VaultTabs. Open Source under MIT License.
      </div>
    </div>
  );
}