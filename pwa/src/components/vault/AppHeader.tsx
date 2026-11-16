'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoMark } from '@/components/ui/Logo';
import styles from '@/components/ui/ui.module.css';
import { useVault } from './VaultProvider';

const NAV = [
  { href: '/dashboard', label: 'Tabs' },
  { href: '/devices', label: 'Devices' },
  { href: '/settings', label: 'Settings' },
];

/** Shared header for the protected pages: logo, navigation, page actions and the Lock button. */
export function AppHeader({ actions }: { actions?: ReactNode }) {
  const pathname = usePathname();
  const { lock } = useVault();

  return (
    <header className={styles.appHeader}>
      <Link href="/dashboard" className={styles.appBrand} aria-label="VaultTabs dashboard">
        <LogoMark size={22} />
        <span className={styles.appBrandName}>VaultTabs</span>
      </Link>
      <nav className={styles.appNav} aria-label="Main">
        {NAV.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={styles.appNavLink}
            aria-current={pathname === item.href ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className={styles.appActions}>
        {actions}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => void lock()}
          title="Lock vault (forget the key on this browser)"
          aria-label="Lock vault"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </button>
      </div>
    </header>
  );
}
