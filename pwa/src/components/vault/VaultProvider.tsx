'use client';

/**
 * Client-side guard for protected pages:
 *   no session            → /login
 *   session but no key    → /unlock?next=<path>
 *   otherwise             → render children with the unlocked vault in context.
 * Also runs the idle auto-lock and reacts to lock / sign-out in other tabs.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  clearLocalSession,
  getLockSettings,
  getMasterKey,
  getSession,
  lockVault,
  onVaultEvent,
  updateSession,
  type StoredSession,
} from '@/lib/session';
import styles from '@/components/ui/ui.module.css';

export interface VaultContextValue {
  session: StoredSession;
  key: CryptoKey;
  userId: string;
  lock: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-read the stored session (after settings changes). */
  refreshSession: () => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error('useVault() must be used inside <VaultProvider>');
  return ctx;
}

export function unlockHref(pathname: string | null): string {
  return pathname && pathname !== '/unlock' ? `/unlock?next=${encodeURIComponent(pathname)}` : '/unlock';
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function VaultProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<{ session: StoredSession; key: CryptoKey } | null>(null);
  const lastActivity = useRef(Date.now());

  const goUnlock = useCallback(() => router.replace(unlockHref(pathname)), [router, pathname]);

  // Guard.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = getSession();
      if (!session) {
        router.replace('/login');
        return;
      }
      const key = await getMasterKey();
      if (cancelled) return;
      if (!key) {
        goUnlock();
        return;
      }
      setState({ session, key });
      // Refresh user / crypto params in the background (keeps offline unlock params current and
      // detects revoked sessions). Network errors are ignored: the dashboard works offline-ish.
      api
        .me()
        .then(me => {
          const next = updateSession({ user: me.user, crypto: me.crypto });
          if (next && !cancelled) setState(prev => (prev ? { ...prev, session: next } : prev));
        })
        .catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
    // Only on mount: navigation between protected pages keeps the provider mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lock = useCallback(async () => {
    await lockVault();
    setState(null);
    goUnlock();
  }, [goUnlock]);

  const signOut = useCallback(async () => {
    await clearLocalSession();
    setState(null);
    router.replace('/login');
  }, [router]);

  const refreshSession = useCallback(() => {
    const s = getSession();
    if (s) setState(prev => (prev ? { ...prev, session: s } : prev));
  }, []);

  // Other tabs locking / signing out.
  useEffect(
    () =>
      onVaultEvent(event => {
        setState(null);
        if (event === 'lock') goUnlock();
        else router.replace('/login');
      }),
    [goUnlock, router],
  );

  // Idle auto-lock.
  const unlocked = state !== null;
  useEffect(() => {
    if (!unlocked) return;
    const mark = () => {
      lastActivity.current = Date.now();
    };
    const check = () => {
      const minutes = getLockSettings().autoLockMinutes;
      if (minutes > 0 && Date.now() - lastActivity.current > minutes * 60_000) void lock();
    };
    mark();
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, mark, { passive: true }));
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(check, 15_000);
    return () => {
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, mark));
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [unlocked, lock]);

  if (!state) {
    return (
      <div className={styles.fullscreenCenter} role="status" aria-live="polite">
        <div className={styles.spinner} aria-hidden="true" />
        <span className={styles.srOnly}>Opening your vault…</span>
      </div>
    );
  }

  return (
    <VaultContext.Provider
      value={{
        session: state.session,
        key: state.key,
        userId: state.session.user.id,
        lock,
        signOut,
        refreshSession,
      }}
    >
      {children}
    </VaultContext.Provider>
  );
}
