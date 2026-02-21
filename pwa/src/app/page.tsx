'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { loadSession } from '@/lib/storage';
import { loadMasterKey } from '@/lib/storage';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    async function check() {
      const session   = loadSession();
      const masterKey = await loadMasterKey();

      if (session && masterKey) {
        router.replace('/dashboard');
      } else {
        router.replace('/login');
      }
    }
    check();
  }, [router]);

  // Brief loading flash while redirecting
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100dvh', background: 'var(--black)',
    }}>
      <svg width="36" height="36" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#0f0f0f"/>
        <path d="M16 6L8 10V16C8 20.4 11.6 24.5 16 26C20.4 24.5 24 20.4 24 16V10L16 6Z"
          fill="#39ff85" opacity="0.9"/>
        <path d="M13 16L15 18L19 14" stroke="#080808" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}